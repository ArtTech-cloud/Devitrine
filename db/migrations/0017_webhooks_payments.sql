-- Fase 2, etapa 2: caixa de entrada de webhooks, cobranças, chaves de idempotência e conciliação
-- (ADR-005, ADR-020). Tudo fechado para anon/authenticated: só o servidor e os jobs (service_role) acessam.

-- Caixa de entrada: o evento recebido é imutável (append-only, SPEC §10). O andamento do processamento
-- (tentativas, erro, status) não é coluna editável: vem de `webhook_event_runs`, também append-only.
create table public.webhook_events (
  id uuid primary key,
  provider text not null check (provider in ('asaas', 'stripe', 'fake')),
  event_id text not null check (char_length(event_id) between 1 and 200),
  type text not null check (char_length(type) between 1 and 60),
  raw_type text not null check (char_length(raw_type) between 1 and 120),
  provider_payment_id text check (provider_payment_id is null or char_length(provider_payment_id) <= 200),
  split_id text check (split_id is null or char_length(split_id) <= 200),
  payload jsonb not null,
  received_at timestamptz not null default now(),
  constraint webhook_events_provider_event_uq unique (provider, event_id)
);
create index webhook_events_received_idx on public.webhook_events (received_at);

create table public.webhook_event_runs (
  seq bigint generated always as identity primary key,
  webhook_event_id uuid not null references public.webhook_events (id),
  -- processed/ignored = terminal; failed = vai repetir; dead = 10ª falha; requeued = reprocesso manual.
  outcome text not null check (outcome in ('processed', 'ignored', 'failed', 'dead', 'requeued')),
  error text check (error is null or char_length(error) <= 1000),
  created_at timestamptz not null default clock_timestamp()
);
create index webhook_event_runs_event_idx on public.webhook_event_runs (webhook_event_id, seq);

create trigger webhook_events_no_mutation before update or delete on public.webhook_events
  for each row execute function public.forbid_mutation();
create trigger webhook_events_no_truncate before truncate on public.webhook_events
  for each statement execute function public.forbid_mutation();
create trigger webhook_event_runs_no_mutation before update or delete on public.webhook_event_runs
  for each row execute function public.forbid_mutation();
create trigger webhook_event_runs_no_truncate before truncate on public.webhook_event_runs
  for each statement execute function public.forbid_mutation();

-- Visão derivada com as colunas da SPEC §10 (status, attempts, last_error). `attempts` conta só as
-- tentativas depois do último reprocesso manual.
create view public.webhook_event_status with (security_invoker = true) as
select
  e.id, e.provider, e.event_id, e.type, e.raw_type, e.provider_payment_id, e.split_id, e.received_at,
  case l.outcome
    when 'processed' then 'processed'
    when 'ignored' then 'ignored'
    when 'failed' then 'retrying'
    when 'dead' then 'failed'
    else 'received'
  end as status,
  coalesce(a.attempts, 0)::int as attempts,
  case when l.outcome in ('failed', 'dead') then l.error end as last_error,
  l.created_at as last_run_at
from public.webhook_events e
left join lateral (
  select r.outcome, r.error, r.created_at from public.webhook_event_runs r
  where r.webhook_event_id = e.id order by r.seq desc limit 1
) l on true
left join lateral (
  select count(*) as attempts from public.webhook_event_runs r
  where r.webhook_event_id = e.id and r.outcome <> 'requeued'
    and r.seq > coalesce((
      select max(q.seq) from public.webhook_event_runs q
      where q.webhook_event_id = e.id and q.outcome = 'requeued'
    ), 0)
) a on true;

-- Cobrança no gateway. A parte do dev e a carteira ficam gravadas: a conciliação compara com o gateway.
create table public.payments (
  id uuid primary key,
  -- Sem FK por enquanto: a tabela orders nasce depois (a FK entra junto com ela).
  order_id uuid not null,
  provider text not null check (provider in ('asaas', 'stripe', 'fake')),
  provider_payment_id text not null check (char_length(provider_payment_id) between 1 and 200),
  method text not null check (method in ('pix', 'card')),
  status text not null check (status in (
    'pending', 'confirmed', 'received', 'overdue', 'refunded', 'partially_refunded', 'chargeback', 'deleted'
  )),
  dev_id uuid not null references public.users (id),
  dev_wallet_id text not null,
  gross_cents bigint not null check (gross_cents > 0),
  dev_amount_cents bigint not null check (dev_amount_cents > 0),
  net_cents bigint,
  currency text not null default 'BRL' check (currency = 'BRL'),
  split_status text not null default 'pending' check (split_status in ('pending', 'done', 'blocked', 'cancelled')),
  escrow_id text,
  checkout_url text,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payments_provider_payment_uq unique (provider, provider_payment_id),
  constraint payments_dev_fits_gross_ck check (dev_amount_cents <= gross_cents),
  constraint payments_net_ck check (net_cents is null or (net_cents >= 0 and net_cents <= gross_cents))
);
create index payments_order_idx on public.payments (order_id);
-- Um pedido nunca tem duas cobranças abertas ou pagas ao mesmo tempo (evita cobrar duas vezes).
create unique index payments_one_open_per_order on public.payments (order_id)
  where status in ('pending', 'confirmed', 'received');
create trigger payments_touch_updated_at before update on public.payments
  for each row execute function public.touch_updated_at();
-- O status muda, mas a cobrança nunca é apagada: o ledger e a conciliação apontam para ela.
create trigger payments_no_delete before delete on public.payments
  for each row execute function public.forbid_mutation();
create trigger payments_no_truncate before truncate on public.payments
  for each statement execute function public.forbid_mutation();

-- Chamadas que criam ou movem dinheiro (SPEC §8): a chave e o hash do pedido ficam registrados; repetir
-- a chave com o mesmo pedido devolve o mesmo resultado, com pedido diferente é conflito.
create table public.idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (char_length(scope) between 1 and 80),
  key text not null check (char_length(key) between 1 and 200),
  request_hash text not null,
  result_ref text not null,
  created_at timestamptz not null default now(),
  constraint idempotency_keys_scope_key_uq unique (scope, key)
);
-- Apagar uma chave reabriria a porta para cobrar duas vezes: só se cria.
create trigger idempotency_keys_no_mutation before update or delete on public.idempotency_keys
  for each row execute function public.forbid_mutation();
create trigger idempotency_keys_no_truncate before truncate on public.idempotency_keys
  for each statement execute function public.forbid_mutation();

-- Resultado de cada conciliação diária (append-only); o painel do admin (Fase 4) lê daqui.
create table public.reconciliation_runs (
  id uuid primary key,
  window_from timestamptz not null,
  window_to timestamptz not null,
  charges_checked integer not null check (charges_checked >= 0),
  divergences jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create trigger reconciliation_runs_no_mutation before update or delete on public.reconciliation_runs
  for each row execute function public.forbid_mutation();
create trigger reconciliation_runs_no_truncate before truncate on public.reconciliation_runs
  for each statement execute function public.forbid_mutation();

alter table public.webhook_events enable row level security;
alter table public.webhook_event_runs enable row level security;
alter table public.payments enable row level security;
alter table public.idempotency_keys enable row level security;
alter table public.reconciliation_runs enable row level security;

revoke all on public.webhook_events, public.webhook_event_runs, public.webhook_event_status,
  public.payments, public.idempotency_keys, public.reconciliation_runs
  from public, anon, authenticated;
grant select, insert on public.webhook_events, public.webhook_event_runs, public.idempotency_keys,
  public.reconciliation_runs to service_role;
grant select on public.webhook_event_status to service_role;
grant select, insert, update on public.payments to service_role;
revoke update, delete, truncate on public.webhook_events, public.webhook_event_runs,
  public.idempotency_keys, public.reconciliation_runs from service_role;
revoke delete, truncate on public.payments from service_role;
