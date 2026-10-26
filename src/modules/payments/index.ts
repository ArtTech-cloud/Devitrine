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
