-- Fase 2, revisão do Vigia (L5): `payments` só pode mudar o andamento (status, split, escrow, líquido e
-- confirmação). Identidade e valores gravados na criação são imutáveis; o ledger e a conciliação apontam para eles.
-- A trava vale também para o dono do banco (a aplicação conecta como `postgres`, ADR-002).
create or replace function public.payments_guard_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.order_id is distinct from old.order_id
    or new.provider is distinct from old.provider
    or new.provider_payment_id is distinct from old.provider_payment_id
    or new.method is distinct from old.method
    or new.dev_id is distinct from old.dev_id
    or new.dev_wallet_id is distinct from old.dev_wallet_id
    or new.gross_cents is distinct from old.gross_cents
    or new.dev_amount_cents is distinct from old.dev_amount_cents
    or new.currency is distinct from old.currency
    or new.created_at is distinct from old.created_at
  then
    raise exception 'payments: coluna imutável alterada' using errcode = '23514';
  end if;
  -- Depois de confirmado, o momento e o líquido ficam fixos (o lançamento do ledger foi calculado com eles).
  if old.confirmed_at is not null
    and (new.confirmed_at is distinct from old.confirmed_at or new.net_cents is distinct from old.net_cents)
  then
    raise exception 'payments: confirmação e líquido são imutáveis depois de confirmados' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger payments_guard_immutable before update on public.payments
  for each row execute function public.payments_guard_immutable();

revoke all on function public.payments_guard_immutable() from public, anon, authenticated;
