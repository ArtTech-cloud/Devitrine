# ADR-017: Porta PaymentProvider, adaptador fake e esboço do Asaas

- Status: aceita
- Data: 2026-10-26

## Contexto

A Fase 2 precisa do módulo `payments` falando com o gateway só pela interface `PaymentProvider` (SPEC §8). O portão oficial da fase exige um pagamento no sandbox do Asaas, e o sandbox não foi autorizado (ADR-009: nenhuma conta, credencial ou chamada real sem ordem explícita do Arthur). A etapa 1 constrói a porta e prova o fluxo localmente contra um fake.

## Decisão

1. **Porta em `payments/domain/provider.ts`**, estendendo `RecipientGateway` do `accounts` (ADR-010): `createRecipient`, `getRecipientStatus` e `enableEscrow` têm as mesmas assinaturas. Dentro do `payments`, o tipo vem de `@/modules/accounts` (só tipos; o `accounts` nunca importa o `payments`).
2. **Divergências em relação ao esboço da SPEC §8**, que foi atualizada junto:
   - valores em `bigint` (centavos), não `number`: a regra de dinheiro do projeto é inteira e sem ponto flutuante;
   - `getCharge(providerPaymentId)`: o job de webhook busca o recurso no provedor porque o payload não é fonte da verdade (§9, passo 6);
   - `listCharges({ from, to })`: a conciliação diária compara as últimas 72 h com `payments` e o ledger;
   - `createCharge` devolve `netCents`, `splitStatus`, `checkoutUrl` (cartão, página hospedada) e dados do Pix; o servidor nunca recebe número de cartão.
3. **Regras comuns a qualquer adaptador** em `domain/charge-rules.ts`: valores inteiros positivos, teto de R$ 100.000,00 por cobrança, parte do dev entre 0 e G, chave de idempotência obrigatória. O encaixe de D no líquido (`D ≤ netValue`, §8 item 4) é verificado com o `netCents` que o gateway devolve (`splitFitsNet`).
4. **Adaptador fake** (`infra/fake-payment-provider.ts`) para dev e testes, sem rede:
   - Pix, cartão e split de valor fixo; garantia (escrow) criada quando D cabe no líquido; split bloqueado (`PAYMENT_SPLIT_DIVERGENCE_BLOCK`) quando não cabe;
   - estorno total e parcial, chargeback e vencimento;
   - taxas fictícias (Pix R$ 0,99; cartão 2,99% + R$ 0,49), só para que o líquido seja menor que o bruto;
   - idempotência por chave com impressão digital dos parâmetros: mesma chave e mesmos parâmetros devolve o mesmo resultado, parâmetros diferentes dá `idempotency_mismatch`;
   - `releaseEscrow` recebe o id da garantia, não o da cobrança, e é idempotente;
   - os métodos `simulate*` e `delivery()` são o lado "gateway": devolvem os eventos no formato de nomes da SPEC §9 (`PAYMENT_RECEIVED`, `PAYMENT_SPLIT_DONE`, ...), e reenviar o mesmo `FakeWebhookBody` é a redistribuição do mesmo evento (mesmo `id`);
   - `parseWebhook` autentica o header `asaas-access-token` em tempo constante (`infra/token.ts`, SHA-256 + `timingSafeEqual`) **antes** de ler o corpo, e lança `WebhookAuthError`.
5. **Esboço do Asaas** (`infra/asaas-payment-provider.ts`): implementa a porta, mas todo método lança `PaymentProviderError('not_implemented')`. Nenhuma chamada de rede, endpoint, campo ou nome de evento inventado.
6. **Composição.** `getPaymentProvider()` em `src/lib/composition.ts` devolve o fake (singleton em `globalThis`, compartilhando o `RecipientGateway` de `getRecipientGateway()` para as carteiras coincidirem) e recusa em produção, como o gateway de subcontas.
7. **Eventos normalizados** (`domain/webhook-events.ts`): tabela dos nomes de evento do Asaas da SPEC §9 para um tipo interno. Evento fora da lista vira `ignored`: é gravado na caixa de entrada, mas não gera efeito.

## Consequências

- O fluxo local completo (cobrança → webhook 3× → ledger → conciliação) roda contra o fake sem sandbox. Isso **não** substitui o portão oficial, que continua exigindo um pagamento real no sandbox do Asaas.
- **Não verificado contra o Asaas real:** o formato do corpo do webhook (`id`, `event`, `payment.id`), onde fica o `splitId` (`additionalInfo.splitId`, que a SPEC cita sem dizer o objeto pai), o formato da garantia e o comportamento real de `splitRefunds`. O fake usa uma forma plausível, só dele; o adaptador real deve conferir cada item na documentação oficial e no sandbox antes de mapear.
- Em aberto com o Arthur (decisões de negócio, SPEC §14): quem arca com a taxa do chargeback e o prazo de `daysToExpire` da garantia. Consolidado como pendência de negócio no ADR-019.
- Os PRs do `payments` exigem revisão humana antes do merge e revisão do Vigia.
