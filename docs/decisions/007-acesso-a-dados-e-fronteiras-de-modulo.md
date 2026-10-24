# ADR-007: Acesso a dados por withUser/withService, fronteira de módulo no lint e migrações SQL próprias

- Status: aceita
- Data: 2026-10-24

## Contexto

O ADR-002 pede RLS como segunda barreira, e o ADR-001 pede módulos isolados. Falta um jeito único e testável de executar SQL como um usuário e de impedir atalhos entre módulos.

## Decisão

- `withUser(claims, fn)` abre uma transação, define `request.jwt.claims` e `request.jwt.claim.sub` e troca para o papel `authenticated`, de modo que o RLS vale. `withService(fn)` ignora o RLS e só roda no servidor e nos jobs (`import 'server-only'`).
- O ESLint proíbe importar o interior de outro módulo (só `@/modules/<nome>`, que resolve para o `index.ts`) e proíbe a UI de importar `@/lib/db`, drizzle ou postgres.
- Migrações são SQL puro em `db/migrations`, aplicadas por `scripts/migrate.ts` com checksum SHA-256 em `public._migrations`. Editar migração aplicada falha na execução e em `pnpm db:check` (comparação com `origin/main` no CI). O drizzle-kit fica só para gerar o schema TypeScript; as migrações vão à mão porque RLS, triggers e funções não cabem no gerador.

## Consequências

- Um teste de RLS usa o mesmo `withUser` do código de produção.
- Violação de fronteira quebra o lint, não a revisão.
- Migração só vai para frente; correção é uma migração nova (ex.: 0004 corrige o papel de admin).
