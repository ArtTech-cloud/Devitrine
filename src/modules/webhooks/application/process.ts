import 'server-only'
import { maskString, withContext } from '@/lib/logger'
import { applyPaymentEvent } from '@/modules/payments'
import type { Charge, NormalizedEventType, WebhookProvider } from '@/modules/payments'
import { errorText, isLastAttempt, TERMINAL_STATUSES, WebhookDeadError } from '../domain/policy'
import { advisoryLock, findEvent, insertRun, readStatus } from '../infra/webhook-repository'
import type { WebhookDeps } from './deps'

export type ProcessResult = 'processed' | 'ignored' | 'skipped'

/**
 * Passos 6 e 7 da SPEC §9, o corpo do job `webhooks/process`. Busca a cobrança no provedor (o payload não é fonte
 * da verdade), aplica `payments` + ledger + efeito no pedido numa única transação e grava a execução em
 * `webhook_event_runs`. Se algo falha, a transação desfaz tudo (nenhum efeito parcial no ledger) e a falha é
 * registrada numa transação separada. Na 10ª falha o evento vira `failed`, dispara alerta crítico e lança
 * `WebhookDeadError` (o job não tenta mais). Qualquer outra falha é relançada para o backoff do Inngest.
 */
export async function processWebhookEvent(webhookEventId: string, deps: WebhookDeps): Promise<ProcessResult> {
  const log = withContext({})
  const initial = await deps.run(async (db) => {
    const event = await findEvent(db, webhookEventId)
    return event ? { event, status: await readStatus(db, webhookEventId) } : undefined
  })
  if (!initial) throw new Error(`Evento de webhook ${webhookEventId} não existe`)
  if (initial.status && TERMINAL_STATUSES.has(initial.status.status)) return 'skipped'
  const { event } = initial

  try {
    // A leitura no provedor fica fora da transação do banco: rede lenta não segura trava de linha.
    let charge: Charge | null = null
    if (event.type !== 'ignored' && event.providerPaymentId) {
      charge = await deps.provider.getCharge(event.providerPaymentId)
    }
    return await deps.run(async (db) => {
      await advisoryLock(db, `webhook_event:${webhookEventId}`)
      const current = await readStatus(db, webhookEventId)
      if (current && TERMINAL_STATUSES.has(current.status)) return 'skipped' as const
      const result = await applyPaymentEvent(db, {
        event: {
          provider: event.provider as WebhookProvider,
          type: event.type as NormalizedEventType,
          rawType: event.rawType,
          providerPaymentId: event.providerPaymentId,
          splitId: event.splitId,
        },
        charge,
        orders: deps.orders,
        alert: deps.alert,
      })
      const outcome = result === 'ignored' ? 'ignored' : 'processed'
      await insertRun(db, webhookEventId, outcome)
      return outcome
    })
  } catch (error) {
    const text = maskString(errorText(error))
    const attempts = await deps.run(async (db) => {
      await advisoryLock(db, `webhook_event:${webhookEventId}`)
      const current = await readStatus(db, webhookEventId)
      const next = (current?.attempts ?? 0) + 1
      await insertRun(db, webhookEventId, isLastAttempt(next) ? 'dead' : 'failed', text)
      return next
    })
    log.warn({ webhookEventId, attempts, err: error }, 'falha ao processar webhook')
    if (isLastAttempt(attempts)) {
      deps.alert({
        severity: 'critical',
        code: 'webhook_failed',
        message: `Webhook ${event.rawType} esgotou as tentativas: reprocessar pelo painel do admin`,
        context: { webhookEventId, providerPaymentId: event.providerPaymentId, attempts },
      })
      throw new WebhookDeadError(webhookEventId, error)
    }
    throw error
  }
}
