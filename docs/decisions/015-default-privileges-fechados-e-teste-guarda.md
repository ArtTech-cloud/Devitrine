# ADR-015: Default privileges fechados, _migrations protegida e teste-guarda de grants

- Status: aceita
- Data: 2026-10-25

## Contexto

O Vigia achou que `public._migrations`, criada pelo runner (`scripts/migrate.ts`), estava sem RLS e com todos os privilégios para `anon` e `authenticated`, herdados dos default privileges do Supabase. Com a chave anon (pública), `DELETE /rest/v1/_migrations` devolvia 204 e a leitura expunha nomes e checksums. Dava para apagar linhas (reaplicar migrações), trocar checksum (quebrar o deploy) ou inserir o nome de uma migração futura (o runner a pularia em silêncio). O problema é estrutural: o Supabase concede ALL a `anon` e `authenticated` em toda tabela, view e função nova do schema `public`, então cada objeto dependia de alguém lembrar do `revoke` (as views da 0011 já tinham falhado assim, corrigidas na 0013).

## Decisão

- O runner cria `_migrations` já com RLS ligada e sem privilégio para `public`, `anon` e `authenticated`, sem depender de migração e sem mudar checksum de migração aplicada. O runner conecta como dono do banco e ignora a RLS. A migração 0014 corrige bases existentes (idempotente).
- A migração 0014 também revoga os default privileges do dono (`postgres`) no schema `public` para `anon` e `authenticated` (tabelas, sequences e funções) e o EXECUTE de `PUBLIC` em funções novas. `service_role` mantém o default. Objeto novo nasce fechado e cada migração concede só o necessário (`grant` explícito, por coluna quando couber).
- Teste-guarda `tests/integration/grants-guard.test.ts` (roda no CI junto da integração): percorre `pg_class` e `pg_proc` de `public` e falha se (a) tabela sem RLS; (b) `anon`/`authenticated` têm qualquer privilégio de tabela, de coluna ou EXECUTE fora da allowlist explícita do próprio teste; (c) existe tabela, view ou função sem entrada na allowlist; (d) uma view tem qualquer privilégio de escrita; (e) sequences acessíveis; (f) os default privileges do `postgres` em `public` voltam a conceder algo a `anon`/`authenticated`. Quem cria tabela, view ou função atualiza a allowlist no mesmo PR, o que força a decisão consciente de grants.

## Limitações

- Os default privileges de `supabase_admin` (objetos criados por ele, como extensões) continuam concedendo ALL; `postgres` não pode alterá-los. As migrações rodam como `postgres`, e o teste-guarda pega qualquer objeto de `public` fora da allowlist.
- No projeto de nuvem, aplicar a 0014 e rodar o teste-guarda contra ele antes de abrir ao público.

## Consequências

- Migrações novas (payments, ledger, webhooks) não herdam acesso da API; precisam de `grant` explícito se a API precisar ler, e a allowlist do teste-guarda registra isso.
- Funções usadas em policies ou constraints precisam de `grant execute` explícito aos papéis que as avaliam.
