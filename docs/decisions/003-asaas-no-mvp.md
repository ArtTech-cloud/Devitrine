# ADR-003: Asaas como gateway do MVP

- Status: aceita
- Data: 2026-10-24

## Contexto

O modelo exige cobrar o cliente, dividir o valor com o dev na liquidação e segurar a parte do dev até a aprovação, sem que a plataforma receba o valor cheio para repassar depois.

## Decisão

Usar o Asaas no MVP: uma subconta por dev (com KYC feito pelo gateway), split com `fixedValue` na cobrança e conta escrow na subconta, liberada com `POST /v3/escrow/{id}/finish` quando o pedido é concluído. Todo acesso ao gateway passa pela interface `PaymentProvider`.

## Consequências

- Um provedor só cobre cobrança, divisão, custódia e repasse.
- A conta escrow tem mensalidade por subconta: ativar só para devs aprovados.
- O estado da garantia não chega por webhook: a conciliação diária compara gateway e ledger.
- Somar ou trocar de provedor (Stripe na Fase 6; Pagar.me ou Mercado Pago como plano B) é um novo adaptador, sem mexer no domínio.
