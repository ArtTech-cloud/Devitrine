import type { Db } from '@/lib/db'
import type { AlertSink, OrderPaymentEffects, PaymentProvider } from '@/modules/payments'

/** Tudo que o módulo recebe de fora; a composição (src/lib/composition.ts) liga os adaptadores reais. */
export interface WebhookDeps {
  provider: PaymentProvider
  orders: OrderPaymentEffects
  alert: AlertSink
  /** Envia o job `webhooks/process` para a fila. Lança se não conseguir enfileirar. */
  enqueue(webhookEventIds: string[]): Promise<void>
  /** Abre uma transação de serviço. Em produção é `withService`; os testes passam a URL do banco. */
  run<T>(fn: (db: Db) => Promise<T>): Promise<T>
}
