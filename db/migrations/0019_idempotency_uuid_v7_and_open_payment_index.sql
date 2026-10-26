-- Fase 2, revisão do Vigia (L6 e L8). A 0017 não é editada (migrações só para frente).

-- L8: `idempotency_keys.id` é UUID v7 gerado na aplicação (convenção do projeto). A 0017 deixou um default
-- `gen_random_uuid()` (v4); sem o default, quem esquecer de mandar o id falha em vez de gravar um v4.
alter table public.idempotency_keys alter column id drop default;

-- L6: cobrança parcialmente estornada continua sendo um pagamento recebido do pedido (o cliente pagou e parte do
-- dinheiro segue em custódia). Se ela não contasse como aberta, o pedido poderia ganhar uma segunda cobrança e o
-- cliente pagaria duas vezes. Falhar fechado é o lado seguro; a regra está registrada no ADR-020 (item 24).
drop index public.payments_one_open_per_order;
create unique index payments_one_open_per_order on public.payments (order_id)
  where status in ('pending', 'confirmed', 'received', 'partially_refunded');
