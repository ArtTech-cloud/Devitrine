// API pública do módulo webhooks: caixa de entrada, processamento, varredura e reprocesso (SPEC §9, ADR-005, ADR-020).
export { receiveWebhook } from './application/receive'
export { handleWebhookRequest } from './application/handle-request'
export type { ReceiveResult } from './application/receive'
export { processWebhookEvent } from './application/process'
export type { ProcessResult } from './application/process'
export { sweepStuckWebhooks, reprocessWebhook } from './application/sweep'
export type { ReprocessResult } from './application/sweep'
export type { WebhookDeps } from './application/deps'
export {
  MAX_ATTEMPTS,
  MAX_BODY_BYTES,
  PROCESS_EVENT_NAME,
  SWEEP_GRACE_SECONDS,
  SWEEP_RETRYING_GRACE_SECONDS,
  WebhookDeadError,
} from './domain/policy'
export type { WebhookStatus } from './domain/policy'
export { readBodyWithLimit } from './domain/body-limit'
export type { ReadBodyResult } from './domain/body-limit'
export { AUTH_FAILURE_ALERT_WINDOW_MS, createAuthFailureThrottle } from './domain/auth-failures'
export type { AuthFailureDecision, AuthFailureThrottle } from './domain/auth-failures'
