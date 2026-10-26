import { withContext } from '@/lib/logger'
import type { AlertSink } from '../domain/ports'

/**
 * Alerta padrão: log estruturado (pino mascara tokens e documentos) com `alert: true`, que o Sentry e o painel
 * de logs usam para notificar. Críticos saem como `error`, avisos como `warn`.
 */
export const logPaymentAlert: AlertSink = (alert) => {
  const log = withContext({})
  const fields = { alert: true, alertCode: alert.code, ...alert.context }
  if (alert.severity === 'critical') log.error(fields, alert.message)
  else log.warn(fields, alert.message)
}
