-- Fase 2, etapa 1: ledger de dupla entrada (ADR-004, ADR-018).
-- Três tabelas append-only (contas, transações, lançamentos) e uma única porta de escrita,
-- `ledger_post`, que rejeita o lote inteiro se débitos ≠ créditos e é idempotente por chave.
-- Fechamento também é garantido por um gatilho deferido, para quem inserir direto na tabela.
create type public.ledger_direction as enum ('debit', 'credit');

-- Lado "normal" de cada conta (SPEC §6): saldo = lado normal − lado oposto.
create function public.ledger_normal_side(p_code text) returns public.ledger_direction
language sql immutable as $$
  select case when p_code in ('gateway_cash', 'gateway_fees', 'dev_receivable')
    then 'debit'::public.ledger_direction else 'credit'::public.ledger_direction end
$$;

create table public.ledger_accounts (
  id uuid primary key default gen_random_uuid(),
  code text not null check (code in (
    'gateway_cash', 'gateway_fees', 'escrow_liability', 'platform_revenue',
    'dev_payable', 'dev_available', 'dev_withdrawal_pending', 'dev_receivable'
  )),
  -- Contas por dev têm dono; as da plataforma, não.
  owner_id uuid references public.users (id),
  normal_side public.ledger_direction not null,
  created_at timestamptz not null default now(),
  constraint ledger_accounts_owner_ck check (
    (code like 'dev\_%' and owner_id is not null) or (code not like 'dev\_%' and owner_id is null)
  ),
  constraint ledger_accounts_side_ck check (normal_side = public.ledger_normal_side(code)),
  constraint ledger_accounts_code_owner_uq unique nulls not distinct (code, owner_id)
);

insert into public.ledger_accounts (code, normal_side) values
  ('gateway_cash', public.ledger_normal_side('gateway_cash')),
  ('gateway_fees', public.ledger_normal_side('gateway_fees')),
  ('escrow_liability', public.ledger_normal_side('escrow_liability')),
  ('platform_revenue', public.ledger_normal_side('platform_revenue'));

-- Cabeçalho de cada lote. A chave de idempotência é do evento de negócio que gerou o lote
-- (ex.: `payment_confirmed:<id do pagamento>`): repetir o evento não lança de novo.
create table public.ledger_transactions (
  tx_id uuid primary key,
  kind text not null check (char_length(kind) between 1 and 60),
  idempotency_key text not null unique check (char_length(idempotency_key) between 1 and 200),
  -- Sem FK por enquanto: a tabela orders nasce depois (a FK entra junto com ela).
  order_id uuid,
  lines_hash text not null,
  -- Só a transação que criou o cabeçalho pode inserir linhas nele (lote fechado nunca cresce).
  created_xid xid8 not null default pg_current_xact_id(),
  created_at timestamptz not null default now()
);
create index ledger_transactions_order_idx on public.ledger_transactions (order_id);

create table public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  tx_id uuid not null references public.ledger_transactions (tx_id),
  account_id uuid not null references public.ledger_accounts (id),
  direction public.ledger_direction not null,
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null default 'BRL' check (currency = 'BRL'),
  order_id uuid,
  created_at timestamptz not null default now()
);
create index ledger_entries_tx_idx on public.ledger_entries (tx_id);
create index ledger_entries_account_idx on public.ledger_entries (account_id);
create index ledger_entries_order_idx on public.ledger_entries (order_id);

-- Append-only: UPDATE, DELETE e TRUNCATE bloqueados por gatilho (vale também para o dono do banco).
create trigger ledger_accounts_no_mutation before update or delete on public.ledger_accounts
  for each row execute function public.forbid_mutation();
create trigger ledger_accounts_no_truncate before truncate on public.ledger_accounts
  for each statement execute function public.forbid_mutation();
create trigger ledger_transactions_no_mutation before update or delete on public.ledger_transactions
  for each row execute function public.forbid_mutation();
create trigger ledger_transactions_no_truncate before truncate on public.ledger_transactions
  for each statement execute function public.forbid_mutation();
create trigger ledger_entries_no_mutation before update or delete on public.ledger_entries
  for each row execute function public.forbid_mutation();
create trigger ledger_entries_no_truncate before truncate on public.ledger_entries
  for each statement execute function public.forbid_mutation();

-- Linhas só entram na transação que criou o cabeçalho do lote.
create function public.ledger_entries_same_xact() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from public.ledger_transactions t
    where t.tx_id = new.tx_id and t.created_xid = pg_current_xact_id()
  ) then
    raise exception 'ledger: lote % já está fechado; lançamentos novos exigem novo tx_id', new.tx_id
      using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger ledger_entries_same_xact before insert on public.ledger_entries
  for each row execute function public.ledger_entries_same_xact();

-- Rede de segurança: no COMMIT, todo lote tocado fecha (débitos = créditos) e tem ao menos duas linhas.
create function public.ledger_check_balanced() returns trigger
language plpgsql as $$
declare
  v_debits bigint;
  v_credits bigint;
  v_lines integer;
begin
  select coalesce(sum(amount_cents) filter (where direction = 'debit'), 0),
         coalesce(sum(amount_cents) filter (where direction = 'credit'), 0),
         count(*)
    into v_debits, v_credits, v_lines
    from public.ledger_entries where tx_id = new.tx_id;
  if v_lines < 2 or v_debits <> v_credits then
    raise exception 'ledger: lote % não fecha (débitos %, créditos %, linhas %)',
      new.tx_id, v_debits, v_credits, v_lines using errcode = '23514';
  end if;
  return null;
end;
$$;
create constraint trigger ledger_entries_balanced after insert on public.ledger_entries
  deferrable initially deferred
  for each row execute function public.ledger_check_balanced();

-- Única porta de escrita. p_lines = [{ code, owner_id|null, direction, amount_cents (texto) }].
-- Valida tudo antes de gravar; retorna 'posted' ou 'duplicate' (mesma chave, mesmo conteúdo).
create function public.ledger_post(
  p_tx_id uuid, p_kind text, p_idempotency_key text, p_order_id uuid, p_lines jsonb
) returns text
language plpgsql set search_path = public as $$
declare
  v_line jsonb;
  v_code text;
  v_owner uuid;
  v_dir public.ledger_direction;
  v_amount bigint;
  v_account uuid;
  v_debits bigint := 0;
  v_credits bigint := 0;
  v_hash text := md5(p_lines::text);
  v_existing public.ledger_transactions;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 2 then
    raise exception 'ledger: lote precisa de ao menos duas linhas' using errcode = '23514';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_line -> 'amount_cents') is distinct from 'string'
       or (v_line ->> 'amount_cents') !~ '^[1-9][0-9]{0,17}$' then
      raise exception 'ledger: amount_cents precisa ser texto de inteiro positivo (centavos)'
        using errcode = '23514';
    end if;
    v_amount := (v_line ->> 'amount_cents')::bigint;
    if (v_line ->> 'direction') not in ('debit', 'credit') then
      raise exception 'ledger: direction inválida' using errcode = '23514';
    end if;
    if (v_line ->> 'direction') = 'debit' then
      v_debits := v_debits + v_amount;
    else
      v_credits := v_credits + v_amount;
    end if;
  end loop;

  if v_debits <> v_credits then
    raise exception 'ledger: lote não fecha (débitos %, créditos %)', v_debits, v_credits
      using errcode = '23514';
  end if;

  insert into public.ledger_transactions (tx_id, kind, idempotency_key, order_id, lines_hash)
    values (p_tx_id, p_kind, p_idempotency_key, p_order_id, v_hash)
    on conflict (idempotency_key) do nothing;
  if not found then
    select * into v_existing from public.ledger_transactions where idempotency_key = p_idempotency_key;
    if v_existing.kind <> p_kind
       or v_existing.order_id is distinct from p_order_id
       or v_existing.lines_hash <> v_hash then
      raise exception 'ledger: chave de idempotência % reutilizada com conteúdo diferente', p_idempotency_key
        using errcode = '23505';
    end if;
    return 'duplicate';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_code := v_line ->> 'code';
    v_owner := nullif(v_line ->> 'owner_id', '')::uuid;
    v_dir := (v_line ->> 'direction')::public.ledger_direction;
    v_amount := (v_line ->> 'amount_cents')::bigint;

    select id into v_account from public.ledger_accounts
      where code = v_code and owner_id is not distinct from v_owner;
    if not found then
      -- Contas por dev nascem no primeiro lançamento; os CHECKs validam código e dono.
      insert into public.ledger_accounts (code, owner_id, normal_side)
        values (v_code, v_owner, public.ledger_normal_side(v_code))
        on conflict (code, owner_id) do nothing;
      select id into v_account from public.ledger_accounts
        where code = v_code and owner_id is not distinct from v_owner;
    end if;

    insert into public.ledger_entries (tx_id, account_id, direction, amount_cents, order_id)
      values (p_tx_id, v_account, v_dir, v_amount, p_order_id);
  end loop;
  return 'posted';
end;
$$;

-- Saldo = lado normal − lado oposto (SPEC §6); nunca é coluna.
create function public.ledger_balance(p_code text, p_owner uuid default null) returns bigint
language sql stable set search_path = public as $$
  select coalesce(sum(case when e.direction = a.normal_side then e.amount_cents else -e.amount_cents end), 0)::bigint
  from public.ledger_accounts a
  join public.ledger_entries e on e.account_id = a.id
  where a.code = p_code and a.owner_id is not distinct from p_owner
$$;

alter table public.ledger_accounts enable row level security;
alter table public.ledger_transactions enable row level security;
alter table public.ledger_entries enable row level security;

-- Fechadas para a API: nada de anon nem authenticated (extrato do dev e painel do admin entram
-- na Fase 4, com policy própria). Só o servidor e os jobs, e sem UPDATE/DELETE/TRUNCATE.
revoke all on public.ledger_accounts, public.ledger_transactions, public.ledger_entries
  from public, anon, authenticated;
grant select, insert on public.ledger_accounts, public.ledger_transactions, public.ledger_entries
  to service_role;
revoke update, delete, truncate on public.ledger_accounts, public.ledger_transactions, public.ledger_entries
  from service_role;

revoke all on function
  public.ledger_post(uuid, text, text, uuid, jsonb),
  public.ledger_balance(text, uuid),
  public.ledger_normal_side(text),
  public.ledger_entries_same_xact(),
  public.ledger_check_balanced()
  from public, anon, authenticated;
grant execute on function
  public.ledger_post(uuid, text, text, uuid, jsonb),
  public.ledger_balance(text, uuid)
  to service_role;
