# ADR-010: Porta RecipientGateway, credenciais da subconta em payments e ponto de composição

- Status: aceita
- Data: 2026-10-24

## Contexto

O onboarding do dev (Fase 1, módulo `accounts`) precisa criar a subconta no gateway, consultar o KYC e ligar a conta escrow. O `PaymentProvider` (módulo `payments`, do Cofre) só nasce na Fase 2, e a chave de API da subconta só pode ser lida por `payments` (SPEC §10).

## Decisão

1. **Porta no `accounts`.** `accounts/domain/recipient-gateway.ts` define `RecipientGateway` e os tipos de entrada e saída, exportados por `accounts/index.ts`. `payments` importa só isso; `accounts` nunca importa `payments`.
   - `createRecipient({ devUserId, name, cpfCnpj, email, mobilePhone, address, addressNumber, province, postalCode, incomeCents, birthDate?, companyType?, idempotencyKey })` → `{ accountId, walletId, onboardingUrl | null }`
   - `getRecipientStatus(accountId)` → `{ kyc: 'not_started' | 'pending' | 'approved' | 'rejected', onboardingUrl | null }`
   - `enableEscrow(accountId, { daysToExpire, isFeePayer, idempotencyKey })` → `void`, idempotente.
   - Valores monetários em centavos; a conversão para decimal do Asaas fica dentro do adaptador.
2. **Chave da subconta fora do `accounts`.** Tabela `recipient_credentials(dev_id, api_key_enc, key_version, created_at)`, criada pelo Cofre na migração 0007, com RLS ligada e `REVOKE ALL` para `anon` e `authenticated`; só service. Cifra AES-256-GCM, `dev_id` como AAD, chave-mestra em variável de ambiente com `key_version`. `dev_profiles` guarda só `provider_account_id`, `wallet_id`, `kyc_status`, `kyc_link` e `escrow_enabled_at`.
3. **Ordem de gravação do adaptador real.** A chave só vem na resposta da criação da subconta; o adaptador cifra e grava a credencial e `provider_account_id` antes de retornar, e `createRecipient` não é reexecutado cegamente em retry (dedupe por `idempotency_keys` e índice único em `provider_account_id`).
4. **Composição.** Um único ponto, `src/lib/composition.ts`, liga a porta ao adaptador (`createAsaasRecipientGateway()` do `payments`, ou o fake em dev e testes). Os Server Actions chamam a composição; nenhum módulo importa o outro.
5. **KYC na Fase 1 por consulta** (`getRecipientStatus` ao abrir o onboarding e botão "atualizar", com limite de frequência). Os webhooks `ACCOUNT_STATUS_*` entram na Fase 2.
6. **Escrow só depois do KYC aprovado** (mensalidade por subconta, SPEC §8).
7. **Migrações:** `0006` (accounts) e `0007` (Cofre, `recipient_credentials`); as do catálogo seguem a partir de `0008`. Migrações podem ter lacunas de numeração.

## Consequências

- A Fase 2 reaproveita as mesmas assinaturas em `PaymentProvider.createRecipient` e `getRecipientStatus`.
- Atribuição de tarefas: a porta e o fake são do `accounts`; o adaptador Asaas, a tabela de credenciais e a cifra são do `payments` (PR com revisão humana e do Vigia).
- O teste de RLS de `recipient_credentials` (anon e authenticated não leem nem escrevem) acompanha a migração 0007.
- O contrato com o Asaas real está por confirmar no sandbox (ADR-009).
