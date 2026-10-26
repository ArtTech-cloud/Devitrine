# ADR-020: Caixa de entrada de webhooks, cobranças e conciliação

- Status: aceita (Fase 2, etapa 2; roda contra o adaptador fake, ver "Não verificado")
- Data: 2026-10-26

## Contexto

A SPEC §9 define o caminho de todo webhook (autenticar, gravar, enfileirar, responder 200, processar num job idempotente) e a SPEC §6 lista `webhook_events` como append-only com as colunas `status`, `attempts` e `last_error`. As duas regras se contradizem: não dá para atualizar `status` e `attempts` numa tabela que bloqueia UPDATE. Também faltavam as tabelas `payments`, `idempotency_keys` e a conciliação, e o módulo `orders` com `transition()` ainda não existe (Rota/Atlas).

## Decisão

1. **`webhook_events` é estritamente append-only** (migração `0017_webhooks_payments.sql`): guarda só o fato recebido (`provider`, `event_id`, `type`, `raw_type`, `provider_payment_id`, `split_id`, `payload`, `received_at`), com `(provider, event_id)` único. UPDATE, DELETE e TRUNCATE falham por gatilho, também para o dono do banco.
2. **O andamento vem de `webhook_event_runs`** (append-only; `seq` identity; `outcome` em `processed`, `ignored`, `failed`, `dead`, `requeued`) e da view `webhook_event_status` (`security_invoker`), que deriva `status` (`received`, `processed`, `ignored`, `retrying`, `failed`), `attempts`, `last_error` e `last_run_at`. É uma **decisão de julgamento** que desvia das colunas literais da SPEC §6 para respeitar a regra de append-only; a SPEC é atualizada no mesmo PR.
3. **Endpoint `POST /api/webhooks/asaas`** (runtime Node, corpo bruto): corpo acima de 1 MB dá 413; autenticação falha dá 401 sem gravar nada (comparação em tempo constante, antes de qualquer parse); payload inválido dá 400; evento novo é gravado, enfileirado (`webhooks/process`) e só então responde 200; falha ao enfileirar dá 500 (o provedor reenvia e o evento já gravado é reenfileirado); duplicado terminal dá 200 sem enfileirar; duplicado ainda não terminal é reenfileirado.
4. **Processamento** (`processWebhookEvent`): a leitura da cobrança no provedor (`getCharge`) fica **fora** da transação do banco. Dentro de uma transação única: trava advisory por evento, releitura do status, `applyPaymentEvent` (`payments` + lançamento no ledger + efeito no pedido) e `insertRun`. Se algo falha, tudo é desfeito e a falha é gravada numa transação separada (`failed`). A 10ª falha vira `dead`, dispara alerta crítico `webhook_failed` e lança `WebhookDeadError`, que o job converte em `NonRetriableError`. `retries: 9` no Inngest (a 1ª tentativa + 9), e um teste garante `retries = MAX_ATTEMPTS - 1`.
5. **O efeito vem da cobrança atual no provedor, não do payload**, e os estados só avançam (`planPaymentSync`): evento repetido ou fora de ordem chega ao mesmo estado. Chave do ledger: `payment_confirmed:<provider>:<providerPaymentId>`. Teste de propriedade (fast-check) com leituras atrasadas e repetidas cobre a convergência.
6. **Porta de pedidos com falha fechada** (`OrderPaymentEffects`): enquanto `orders` e `transition()` não existem, `getOrderPaymentEffects()` em `composition.ts` lança "Efeito no pedido indisponível". O evento de pagamento falha e é repetido; nada é lançado no ledger sem o pedido avançar. Quando o módulo `orders` existir, só a composição muda.
7. **Estorno, chargeback e split** só atualizam o status e geram alertas (`reversal_not_booked`, `split_divergence_block`, `split_cancelled`). Os lançamentos de reembolso e chargeback ficam para a Fase 3; a conciliação aponta `unbooked_reversal` enquanto isso.
8. **Varredura** a cada 5 minutos reenfileira `received` com mais de 120 s (lote de 200). **Reprocesso manual** (`reprocessWebhook`, só `failed` ou `retrying`) grava `requeued`, chama `write_audit('webhook.reprocess')` e enfileira. A UI do admin entra na Fase 4.
9. **Cobrança** (`createOrderCharge`): trava advisory por chave, consulta `idempotency_keys` (mesmo hash repete o resultado; hash diferente dá `idempotency_mismatch`), uma cobrança aberta por pedido (também índice único parcial `payments_one_open_per_order`), chama `provider.createCharge`, grava `payments` e a chave, e alerta se a parte do dev não couber no líquido.
10. **Triggers extras:** `payments` bloqueia DELETE e TRUNCATE (UPDATE continua, só por `updated_at` e avanço de status); `idempotency_keys` bloqueia UPDATE, DELETE e TRUNCATE, porque apagar uma chave reabriria a porta para cobrar duas vezes. Os testes de integração acharam as duas lacunas.
11. **Conciliação diária** (`reconcileDaily`, 07:00 UTC): janela de 72 h e carência de 15 min; compara `listCharges` com `payments` e com o ledger, grava `reconciliation_runs` e abre um alerta crítico por divergência. Tipos: `missing_payment_row`, `missing_at_provider`, `status_mismatch`, `split_mismatch`, `amount_mismatch`, `net_mismatch`, `ledger_missing`, `ledger_mismatch`, `ledger_without_payment`, `unbooked_reversal`.
12. **Porta `PaymentProvider`** ganha `getCharge` e `listCharges`, e `name`. Os IDs de evento do fake passam a ser `evt_fake_<uuid>`.

## Não verificado (nada disto foi testado contra o Asaas real)

- Formato real do corpo do webhook e onde fica o `splitId` (o fake tem forma própria).
- Comportamento real de idempotência do Asaas em `POST /v3/payments`.
- A fórmula de reembolso parcial e as taxas do fake (fictícias).
- Os testes de integração rodam num Postgres 18 local com um shim do Supabase, não em `supabase start`; não há CI hospedado (ADR-008).
- O item "estados até paid" do portão da Fase 2 só fecha de verdade com `orders` e `transition()`.

## Consequências

- O portão local (um pagamento gera um único lançamento mesmo com o webhook entregue três vezes, e a conciliação não acusa divergência) é coberto por teste de integração. Ele **não** substitui o portão oficial, que exige o sandbox do Asaas.
- As suposições de negócio abertas continuam no ADR-019.
- SPEC §6, §9 e §14 atualizadas no mesmo PR.
- Os PRs de `payments`, `ledger` e `webhooks` exigem revisão humana antes do merge e revisão do Vigia (QA e segurança).
