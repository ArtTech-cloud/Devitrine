export type PaymentErrorCode =
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'idempotency_mismatch'
  | 'not_implemented'
  | 'timeout'

/** Erro de uma chamada ao gateway (ou ao fake). `idempotency_mismatch`: mesma chave, parâmetros diferentes. */
export class PaymentProviderError extends Error {
  readonly code: PaymentErrorCode
  constructor(code: PaymentErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PaymentProviderError'
    this.code = code
  }
}

/** Webhook sem token válido: o endpoint responde 401 e não grava nada em `webhook_events`. */
export class WebhookAuthError extends Error {
  constructor() {
    super('Webhook não autenticado')
    this.name = 'WebhookAuthError'
  }
}

/** Corpo autenticado mas ilegível; o endpoint responde 400 sem enfileirar. */
export class WebhookPayloadError extends Error {
  constructor(message = 'Corpo de webhook inválido') {
    super(message)
    this.name = 'WebhookPayloadError'
  }
}
