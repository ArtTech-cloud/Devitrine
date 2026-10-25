-- ADR-015: tabelas novas nascem fechadas e _migrations sai do alcance de anon/authenticated.

-- 1) Registro de migrações: RLS ligada e sem privilégio para os papéis da API.
--    (O runner cria a tabela já protegida; aqui a base antiga é corrigida. Idempotente.)
alter table public._migrations enable row level security;
revoke all on public._migrations from public, anon, authenticated;

-- 2) Default privileges: o Supabase concede ALL a anon/authenticated em tudo que o dono cria
--    no schema public. Daqui em diante, cada migração concede só o necessário.
--    service_role mantém o default (só servidor e jobs).
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
-- Funções novas também não ficam executáveis por PUBLIC (default global do Postgres).
alter default privileges for role postgres revoke execute on functions from public;
