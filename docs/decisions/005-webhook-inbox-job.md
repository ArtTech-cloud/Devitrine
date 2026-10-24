# ADR-005: Webhook vira registro na caixa de entrada e é processado por job

- Status: aceita
- Data: 2026-10-24

## Contexto

Os provedores entregam cada evento pelo menos uma vez, sem ordem garantida, e podem pausar a entrega quando o endpoint falha em sequência. Rodar regra de negócio dentro da requisição gera efeito duplicado e perde eventos.

## Decisão

O endpoint autentica o evento, grava em `webhook_events` com `(provider, event_id)` único, enfileira o job `webhooks/process` e responde 200. O job busca o recurso no provedor e aplica `transition()` e o ledger numa única transação. Uma varredura a cada 5 minutos reenfileira eventos parados em `received`.

## Consequências

- Repetição e ordem trocada não geram efeito duplo.
- O endpoint responde rápido e não depende da regra de negócio.
- Eventos com falha ficam visíveis no painel do admin para reprocessar.
