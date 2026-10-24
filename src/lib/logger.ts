import pino, { type DestinationStream, type Logger } from 'pino'

const SENSITIVE_KEY =
  /token|secret|password|senha|authorization|api[-_]?key|cookie|cpf|cnpj|bank|banco|agencia|conta|iban|pix[-_]?key|card|cartao|account|agency|routing|jwt|dsn|signature|otp|totp|session|credential/i

const CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g
const CNPJ = /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g
// chave=valor ou chave: valor em texto livre e URL (?access_token=..., apikey=..., token=abc).
const KEY_VALUE =
  /\b([A-Za-z0-9_-]*(?:token|secret|password|senha|api[-_]?key|jwt|signature|otp|totp|authorization)[A-Za-z0-9_-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&,;"']+)/gi

export const MASK = '[REDACTED]'

export function maskString(value: string): string {
  return value
    .replace(JWT, MASK)
    .replace(BEARER, `$1 ${MASK}`)
    .replace(KEY_VALUE, `$1$2${MASK}`)
    .replace(CNPJ, MASK)
    .replace(CPF, MASK)
}

/** Máscara profunda de tokens, CPF, CNPJ e dados bancários. */
export function maskSensitive(value: unknown, depth = 0): unknown {
  if (depth > 8) return MASK
  if (typeof value === 'string') return maskString(value)
  if (Array.isArray(value)) return value.map((v) => maskSensitive(v, depth + 1))
  if (value instanceof Error) {
    return {
      type: value.name,
      message: maskString(value.message),
      stack: value.stack ? maskString(value.stack) : undefined,
    }
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? MASK : maskSensitive(v, depth + 1)
    }
    return out
  }
  return value
}

export interface LogContext {
  requestId?: string
  orderId?: string
}

export function createLogger(destination?: DestinationStream, level = 'info'): Logger {
  const options = {
    level,
    formatters: {
      log: (obj: Record<string, unknown>) => maskSensitive(obj) as Record<string, unknown>,
    },
    hooks: {
      logMethod(this: Logger, args: unknown[], method: (...a: unknown[]) => void) {
        // Mensagens (string) também passam pela máscara.
        // Error como 1º argumento vira { err } para passar pela máscara (pino o serializaria sem ela).
        const masked = args.map((a, i) =>
          typeof a === 'string' ? maskString(a) : i === 0 && a instanceof Error ? { err: a } : a,
        )
        if (args[0] instanceof Error && typeof masked[1] !== 'string') masked.splice(1, 0, maskString(args[0].message))
        method.apply(this, masked)
      },
    },
  }
  return destination ? pino(options, destination) : pino(options)
}

export const logger = createLogger(undefined, process.env.LOG_LEVEL ?? 'info')

/** Logger filho com requestId e orderId em todo log. */
export function withContext(ctx: LogContext): Logger {
  return logger.child(ctx)
}
