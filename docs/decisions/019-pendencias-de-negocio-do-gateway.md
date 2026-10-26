# ADR-019: Suposições de negócio do gateway, pendentes até antes de produção

- Status: aceita (as suposições valem para desenvolvimento; revisitar antes de produção)
- Data: 2026-10-26

## Contexto

Cinco pontos do fluxo de dinheiro dependem de decisões dos fundadores e do contrato real com o Asaas (SPEC §14). Nenhum bloqueia o desenvolvimento: a Fase 2 roda contra o adaptador fake (ADR-017), e o Arthur autorizou seguir para a etapa 2 mantendo as suposições abaixo. Este ADR as reúne num só lugar, no mesmo formato do que já foi feito com o pagador da taxa do escrow na Fase 1 (ADR-012). Ele reforça os registros anteriores; não os substitui.

## Suposições em vigor

| # | Suposição | Onde está no código | Origem |
| --- | --- | --- | --- |
| 1 | **Pagador da taxa do escrow:** `isFeePayer = false`, a plataforma arca com a taxa da conta de garantia. | `accounts/application/dev-service.ts` | ADR-012 |
| 2 | **Taxa do chargeback:** a plataforma arca com o custo da contestação e cobra do dev depois, pela conta `dev_receivable`. | `ledger/domain/postings.ts` (`chargebackAfterRelease`), SPEC §6 | ADR-018 |
| 3 | **`daysToExpire` da garantia:** valor placeholder lido do setting `escrow_days_to_expire` (60 dias na migração 0001), maior que o ciclo máximo do pedido. O limite real do Asaas não está na documentação. | `accounts/application/dev-service.ts`, `db/migrations/0001_base.sql` | SPEC §8 |
| 4 | **Pago depois de cancelado (`paid_after_cancel`):** política **aprovada pelo Arthur em 2026-10-26**: o admin devolve o valor integral ao cliente (`refund` total, com chave de idempotência); o pedido só reabre se o dev aceitar e o valor estiver em custódia, nunca automaticamente. Falta implementar a ação de devolução do admin (Fase 4); até lá o sistema só alerta e o admin devolve à mão. O texto dos termos ainda precisa do advogado. | `payments/application/apply-event.ts`, SPEC §9 | Revisão do Vigia (B2) |
| 5 | **Retenção do payload bruto de webhook (LGPD):** política **aprovada pelo Arthur em 2026-10-26**: base legal de execução de contrato e prevenção a fraude (LGPD art. 7º, V e IX), 12 meses com o corpo completo e depois só metadados; registros financeiros seguem o prazo fiscal. **Pendências abertas (não bloqueiam a etapa 2):** a função de expurgo auditada, que respeite o append-only, ainda não existe; e a base legal e o prazo ainda precisam da confirmação do advogado ou do DPO. | `webhook_events.payload`, SPEC §10 | Revisão do Vigia (M5) |

## O que precisa ser decidido, e por quem

1. **Pagador da taxa do escrow (1):** fundadores, com os números do contrato. Se o dev passar a pagar, `isFeePayer` vira `true` e o preço líquido do dev muda; o cálculo de D e P na SPEC §6 precisa de revisão.
2. **Chargeback (2):** fundadores, com o contrato do Asaas. A suposição é que a plataforma paga a taxa e debita o dev depois. Se o dev tiver saldo insuficiente, `dev_receivable` fica positivo e reduz o saldo gastável (`getDevSpendableCents`), o que pode bloquear saques futuros do dev. Os termos de uso (jurídico, Fase 4) precisam prever essa cobrança posterior.
3. **`daysToExpire` (3):** confirmar com o Asaas o limite aceito e escolher um valor maior que o ciclo máximo do pedido. Se a garantia expirar antes da conclusão, o webhook de validação de saque continua protegendo o valor (SPEC §8).
4. **`paid_after_cancel` (4):** política decidida pelo Arthur em 2026-10-26. Resta implementar a ação do admin que devolve (com `refund`, chave de idempotência e auditoria) e o advogado revisar o texto dos termos. Até lá o sistema só alerta e o admin devolve à mão.
5. **Retenção do payload (5):** política aprovada pelo Arthur em 2026-10-26. Falta, em aberto: (a) o advogado ou o DPO confirmar base legal e prazo; (b) o time criar o expurgo (função auditada que reduz o `payload` sem violar o append-only dos demais campos). Os dois são pendência, não bloqueio da etapa 2, e precisam estar fechados antes de dinheiro real.

## Decisão

- Mantemos as três suposições como estão no desenvolvimento e nos testes.
- **Antes de qualquer ambiente de produção ou de dinheiro real**, as três precisam ser confirmadas com os fundadores e com o Asaas. Esta é uma pendência de negócio explícita, não um detalhe técnico.
- Cada suposição está isolada num ponto só do código (uma constante, um setting ou um construtor de lançamento), então a mudança não exige reescrever fluxos.
- Quando uma for decidida, registre um ADR novo que substitua a linha correspondente da tabela, atualize a SPEC §6/§8/§14 no mesmo PR e ajuste os testes que fixam o comportamento atual (`ledger-domain`, `ledger` e `dev-onboarding`).

## Consequências

- A SPEC §14 passa a apontar para este ADR nos três itens.
- O relatório de cada etapa da Fase 2 e da Fase 4 lembra que a pendência continua aberta.
- O portão da Fase 4 (revisão de segurança da seção 10) não deve ser dado como concluído com estas suposições ainda sem decisão.
