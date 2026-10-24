-- Reenvio do KYC recusado (ADR-012): a tentativa entra na chave de idempotencia da subconta.
-- Escrito so pelo servidor (service role); o dev nao tem GRANT nesta coluna.
alter table public.dev_profiles add column kyc_attempts integer not null default 0 check (kyc_attempts >= 0);
