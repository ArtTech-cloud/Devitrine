# ADR-008: Pendências externas da Fase 0 e endurecimento de auth

- Status: aceita
- Data: 2026-10-24

## Contexto

Por decisão do dono, o repositório remoto e as contas externas (GitHub, Vercel, Supabase cloud, Sentry) ainda não foram liberados. A Fase 0 foi concluída e verificada localmente (lint, typecheck, unitários, integração com RLS, build e E2E). A reverificação de segurança do Vigia apontou três bloqueios, corrigidos junto com este registro.

## Decisão

1. **Pendências externas explícitas.** Ficam em aberto até o dono liberar repositório remoto e contas:
   - CI hospedado (GitHub Actions) rodando verde; o workflow já existe em `.github/workflows`.
   - Deploy de preview na Vercel com `E2E_BASE_URL` apontando para ele.
   - Projeto Supabase na nuvem (São Paulo) com as migrações aplicadas por `pnpm db:migrate`.
   - Sentry (DSN em variável de ambiente).
2. **Portão da Fase 0 (SPEC §4):** "CI verde, deploy de preview no ar, login com papéis e teste de RLS passando". Login com papéis e RLS passam localmente; **CI verde hospedado e preview no ar seguem pendentes**, portanto o portão só fecha por inteiro quando essas pendências forem resolvidas. A linha "Fase atual" do `CLAUDE.md` não muda até lá.
3. **Cookie de sessão:** toda escrita de cookie de sessão (Server Actions e proxy) passa por `hardenCookieOptions`: `httpOnly`, `SameSite=Lax` e `Secure` em produção. Há teste E2E.
4. **Logger:** mascara também `stack`, `Error` como primeiro argumento, JWT soltos, padrões `chave=valor`/URL e as chaves `account`, `agency`, `routing`, `jwt`, `dsn`, `signature`, `otp`, `totp`, `secret`.
5. **Senha:** `minimum_password_length = 10` e `password_requirements = "letters_digits"` no Supabase local, para que a API do Auth não aceite menos que o Zod.
6. **Defesa em profundidade:** migração 0005 revoga UPDATE, DELETE e TRUNCATE de `service_role` em `audit_log`; `pnpm db:check` falha no CI se a base de comparação não existir.

## Ajustes obrigatórios no projeto de nuvem

Ao criar o projeto Supabase cloud (Auth → Providers/Policies): senha mínima de 10 caracteres com letras e dígitos, **confirmação de e-mail ligada (`enable_confirmations = true`)**, `secure_password_change = true` e URL do site/redirects restritos ao domínio. Localmente a confirmação fica desligada para os testes E2E.

## Consequências

- O fechamento da Fase 0 depende de ação do dono (contas), não de código.
- O E2E contra o preview também valida as flags de cookie em HTTPS.
- Em 2026-10-24 a Fase 1 foi autorizada a começar com o portão local aprovado; o fechamento formal da Fase 0 segue pendente destas contas.
