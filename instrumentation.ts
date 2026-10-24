import * as Sentry from '@sentry/nextjs'
import { maskSensitive } from '@/lib/logger'

export async function register() {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) return
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
    beforeSend: (event) => maskSensitive(event) as typeof event,
  })
}

export const onRequestError = Sentry.captureRequestError
