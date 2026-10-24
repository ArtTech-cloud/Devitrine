# CLAUDE.md

Marketplace de serviços digitais. Clientes compram pacotes fechados (Básico, Padrão, Premium) de devs independentes; a plataforma intermedeia a venda, segura o pagamento em custódia no gateway até a aprovação e fica com uma taxa. MVP: um nicho, em reais, clientes no Brasil, Pix e cartão.

**Fase atual: 0 (Fundação).** Atualize esta linha quando o portão de uma fase passar.

A especificação completa está em `docs/SPEC.md` e é a fonte da verdade do produto. Leia as seções da fase em andamento antes de planejar e não invente comportamento que não esteja lá. As seções 8 (gateway), 9 (webhooks) e 10 (segurança) são regras, não sugestões.

## Como trabalhar

- Uma fase por vez, na ordem da seção 4 da spec. A fase só termina quando o portão dela passa e o CI está verde.
- Antes de escrever código, apresente o plano da fase (arquivos, migrações, testes e riscos) e espere aprovação.
- Escreva os testes de dinheiro, estados e permissões junto com o código, não depois.
- Mudou uma regra ou tomou uma decisão nova: registre em `docs/decisions/NNN-titulo.md`, no formato dos registros que já estão lá, e atualize `docs/SPEC.md` no mesmo PR.
- Antes de mexer em `payments`, `ledger` ou `webhooks`, releia as seções 6, 8 e 9 da spec. PRs nesses módulos exigem revisão humana antes do merge; avise na descrição do PR.
- Em dúvida sobre a API do Asaas ou da Stripe, consulte a documentação oficial (links na spec) e teste no sandbox. Não invente endpoints, campos ou nomes de evento.
- Se a spec estiver ambígua ou contraditória, pare e pergunte em vez de escolher sozinho.

## Stack

- TypeScript em modo strict; Next.js (App Router) com Route Handlers e Server Actions
- Tailwind CSS + shadcn/ui (Radix)
- Supabase: Postgres com RLS, Auth e Storage (região São Paulo); Drizzle ORM com migrações SQL versionadas
- Inngest (jobs, retries e cron), Resend (e-mail), Sentry + pino (observabilidade)
- Asaas no MVP: Pix e cartão, split, subcontas e conta escrow. Stripe só na Fase 6
- Vitest, fast-check e Playwright; GitHub Actions; deploy na Vercel

## Comandos

Definidos na Fase 0; mantenha esta lista igual aos scripts do `package.json`.

- `pnpm dev` e `pnpm build`
- `pnpm lint`, `pnpm typecheck`, `pnpm test` e `pnpm test:e2e`
- `supabase start` (Postgres local), `pnpm db:generate` e `pnpm db:migrate`

## Estrutura

```
src/app/              rotas, páginas e Route Handlers
src/modules/<nome>/   domain/, application/, infra/ e index.ts (API pública)
src/lib/              money, ids, auth, erros, logger
src/jobs/             funções Inngest
db/migrations/        SQL versionado
tests/                unit, integration, e2e
docs/                 SPEC.md e decisions/
```

Módulos: `accounts`, `catalog`, `orders`, `payments`, `ledger`, `webhooks`, `disputes`, `reviews`, `notifications`, `admin` e `referrals` (Fase 5).

- A UI chama só a camada `application`; nada de SQL em componentes.
- Um módulo não lê tabelas de outro; usa o `index.ts` dele.

## Dinheiro: regras inegociáveis

- Valores em centavos inteiros (`bigint` no banco) com `currency`; taxas em basis points (`fee_bps`). Nunca ponto flutuante. Use os helpers de `src/lib/money`.
- Taxa = valor × `fee_bps` / 10.000, arredondada para o centavo; parte do dev = valor − taxa. A soma sempre fecha.
- Saldo nunca é coluna editável: é sempre a soma dos lançamentos do ledger.
- Só o módulo `ledger` escreve em `ledger_entries`. Todo `tx_id` fecha (débitos = créditos) ou o lote inteiro é rejeitado.
- `order_events`, `ledger_entries`, `webhook_events` e `audit_log` são append-only (UPDATE e DELETE bloqueados por trigger e RLS).
- Só `transition(order, event, actor)` muda `orders.status`. Ela valida o ator, grava `order_events` e dispara os efeitos.
- Só o módulo `payments` fala com o gateway, sempre pela interface `PaymentProvider`.
- Toda chamada que cria ou move dinheiro leva chave de idempotência, registrada em `idempotency_keys`.
- Split no Asaas com o `walletId` do dev e `fixedValue` = parte do dev, que precisa caber no `netValue` da cobrança. Nunca receber o valor cheio para repassar depois.
- O dinheiro do dev só é liberado quando o pedido chega a `completed`: buscar a garantia da cobrança e chamar `POST /v3/escrow/{id}/finish` com o id da garantia (não o da cobrança).
- O servidor nunca recebe número de cartão; o pagamento com cartão acontece em página hospedada pelo gateway.
- O webhook de validação de saque aprova só o que cabe no saldo disponível do dev no ledger. `settings.withdrawals_paused = true` recusa todos os saques.

## Webhooks

- Route Handler em runtime Node, lendo o corpo bruto. Autenticar antes de qualquer parse: Asaas pelo header `asaas-access-token` (comparação em tempo constante); Stripe pelo `Stripe-Signature`, via SDK oficial.
- Gravar em `webhook_events` com `(provider, event_id)` único, enfileirar o job `webhooks/process` e responder 200. Evento repetido: 200 sem reprocessar.
- Nenhuma regra de negócio dentro da requisição. O job busca o recurso no provedor (o payload não é fonte da verdade), aplica `transition()` e os lançamentos numa única transação e marca `processed`.
- Eventos chegam repetidos e fora de ordem: todo handler é idempotente e chega ao mesmo estado em qualquer ordem.
- Falha: retry com backoff até 10 tentativas; depois `failed`, alerta e reprocessamento manual pelo admin.
- Uma varredura a cada 5 minutos reenfileira eventos parados em `received`.

## Segurança

- Zod em toda Server Action e Route Handler.
- RLS ligada em toda tabela com dado de usuário. A service key do Supabase só existe no servidor e nos jobs, nunca no navegador.
- Toda leitura por id confere a posse do recurso (IDOR), mesmo com UUID.
- Segredos só em variáveis de ambiente; `.env.example` sem valores. O logger mascara tokens, CPF, CNPJ e dados bancários.
- TOTP obrigatório para admin. Reautenticação para sacar, trocar dados bancários ou e-mail e decidir disputa.
- Uploads em bucket privado, entregues por URL assinada de 10 minutos.
- Estorno acima de R$ 2.000 e decisão de disputa exigem aprovação de um segundo admin.

## Testes obrigatórios

- Cálculo de taxa e arredondamento.
- `transition()` com todas as transições válidas e inválidas.
- Ledger: qualquer sequência de eventos mantém débitos = créditos (fast-check).
- RLS: cliente A não lê pedido de B; dev não vê chat de pedido alheio.
- Webhooks: o mesmo evento 3 vezes gera um único efeito; fora de ordem chega ao mesmo estado; token inválido retorna 401 sem gravar nada.

## Convenções

- Código, identificadores e nomes de tabela em inglês; interface e mensagens ao usuário em pt-BR.
- IDs UUID v7 gerados na aplicação. Datas em `timestamptz` (UTC), exibidas em America/Sao_Paulo.
- Migrações só para frente; nunca editar migração já aplicada.
- Funcionalidades das Fases 5 e 6 entram atrás de feature flag.
