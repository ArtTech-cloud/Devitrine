import 'server-only'
import { withContext } from '@/lib/logger'
import { SWEEP_BATCH, SWEEP_GRACE_SECONDS } from '../domain/policy'
import { advisoryLock, findStuckReceived, insertRun, readStatus, writeAudit } from '../infra/webhook-repository'
import type { WebhookDeps } from './deps'

/**
 * Varredura de 5 minutos (SPEC §9, passo 4): reenfileira eventos que ficaram em `received` porque o envio do job
 * falhou. Reenfileirar é seguro: o processamento é idempotente e confere o status antes de agir.
 */
export async function sweepStuckWebhooks(deps: WebhookDeps): Promise<{ requeued: number }> {
  const ids = await deps.run((db) => findStuckReceived(db, SWEEP_GRACE_SECONDS, SWEEP_BATCH))
  if (ids.length === 0) return { requeued: 0 }
  await deps.enqueue(ids)
  withContext({}).info({ requeued: ids.length }, 'varredura reenfileirou webhooks parados')
  return { requeued: ids.length }
}

export type ReprocessResult = 'requeued' | 'not_found' | 'not_failed'

/**
 * Botão "reprocessar" do admin (SPEC §9, passo 7), para evento em `failed` ou `retrying`. Grava `requeued`
 * (zera a contagem de tentativas, sem apagar o histórico), registra no audit_log e reenfileira.
 */
export async function reprocessWebhook(
  webhookEventId: string,
  actorId: string,
  deps: WebhookDeps,
): Promise<ReprocessResult> {
  const result = await deps.run(async (db) => {
    await advisoryLock(db, `webhook_event:${webhookEventId}`)
    const status = await readStatus(db, webhookEventId)
    if (!status) return 'not_found' as const
    if (status.status !== 'failed' && status.status !== 'retrying') return 'not_failed' as const
    await insertRun(db, webhookEventId, 'requeued')
    await writeAudit(db, actorId, 'webhook.reprocess', webhookEventId, {
      from: status.status,
      attempts: status.attempts,
    })
    return 'requeued' as const
  })
  if (result === 'requeued') await deps.enqueue([webhookEventId])
  return result
}
