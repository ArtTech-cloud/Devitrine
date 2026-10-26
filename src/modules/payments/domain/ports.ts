import type { Db } from '@/lib/db'

// Portas de saída do módulo payments: o que ele precisa do resto do sistema sem importar quem fornece.

/**
 * Efeitos no pedido (módulo `orders`). Só `transition(order, event, actor)` muda `orders.status` (SPEC §7):
 * as implementações chamam ela dentro da transação `db` recebida e precisam ser idempotentes.
 * `onPaymentConfirmed` = `awaiting_payment` → `paid`; `onPaymentCancelled` = `awaiting_payment` → `cancelled`.
 */
export interface OrderPaymentEffects {
  onPaymentConfirmed(db: Db, input: PaymentEffectInput): Promise<void>
  onPaymentCancelled(db: Db, input: PaymentEffectInput): Promise<void>
}

export interface PaymentEffectInput {
  orderId: string
  paymentId: string
  providerPaymentId: string
}

export type AlertSeverity = 'warning' | 'critical'

export interface PaymentAlert {
  severity: AlertSeverity
  code: string
  message: string
  context: Record<string, string | number | null>
}

/** Alerta operacional. Hoje vai para o log estruturado; o painel do admin (Fase 4) lê a conciliação e a caixa de webhooks. */
export type AlertSink = (alert: PaymentAlert) => void
