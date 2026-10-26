// API pública do módulo payments. O adaptador fake e o esboço do Asaas são ligados só em src/lib/composition.ts.
export type {
  Charge,
  ChargeStatus,
  CreateChargeInput,
  Customer,
  Escrow,
  EscrowStatus,
  ListChargesInput,
  NormalizedEvent,
  NormalizedEventType,
  PaymentMethod,
  PaymentProvider,
  PixData,
  Refund,
  SplitStatus,
  WebhookProvider,
} from './domain/provider'
export { PaymentProviderError, WebhookAuthError, WebhookPayloadError } from './domain/errors'
export type { PaymentErrorCode } from './domain/errors'
export { MAX_CHARGE_CENTS, splitFitsNet } from './domain/charge-rules'
export type {
  AlertSeverity,
  AlertSink,
  OrderPaymentEffects,
  PaymentAlert,
  PaymentEffectInput,
} from './domain/ports'
export { planPaymentSync, canAdvanceStatus, canAdvanceSplit, isPaidStatus } from './domain/payment-sync'
export { logPaymentAlert } from './application/alerts'
export { createOrderCharge, CREATE_CHARGE_SCOPE } from './application/charge-service'
export type { CreateOrderChargeInput, OrderCharge } from './application/charge-service'
export { applyPaymentEvent, paymentConfirmedKey } from './application/apply-event'
export type { ApplyEventContext, ApplyResult } from './application/apply-event'
export {
  reconcilePayments,
  RECONCILIATION_WINDOW_HOURS,
  RECONCILIATION_GRACE_MINUTES,
} from './application/reconciliation'
export type { Divergence, DivergenceKind, ReconciliationReport } from './application/reconciliation'
