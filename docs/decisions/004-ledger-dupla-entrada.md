# ADR-004: Ledger de dupla entrada como fonte da verdade do dinheiro

- Status: aceita
- Data: 2026-10-24

## Contexto

O dinheiro passa por cobrança, custódia, liberação, estorno, chargeback e saque, em dois lugares (o gateway e o banco da plataforma). Saldos guardados em colunas divergem e não explicam a própria história.

## Decisão

Todo movimento vira lançamentos em `ledger_entries` (append-only), agrupados por `tx_id`, aceitos só quando débitos = créditos. Saldos são sempre derivados dos lançamentos. Só o módulo `ledger` escreve nessas tabelas. Os lançamentos de cada evento estão na seção 6 da spec.

## Consequências

- Todo saldo tem trilha de auditoria e pode ser reconstruído.
- A conciliação diária compara o ledger com o gateway e acusa divergência.
- Correções são novos lançamentos de estorno, nunca UPDATE.
