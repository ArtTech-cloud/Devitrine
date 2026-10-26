import 'server-only'
import { newId } from '@/lib/ids'
import { withContext } from '@/lib/logger'
import { WebhookAuthError, WebhookPayloadError } from '@/modules/payments'
import { createAuthFailureThrottle } from '../domain/auth-failures'
import { MAX_BODY_BYTES, TERMINAL_STATUSES } from '../domain/policy'
import { insertEvent, readStatus } from '../infra/webhook-repository'
import type { WebhookDeps } from './deps'

const processAuthFailures = createAuthFailureThrottle()

export interface ReceiveResult {
  status: 200 | 400 | 401 | 413 | 500
  body: { ok: boolean; error?: string; duplicate?: boolean }
}

/**
 * Passos 1 a 5 da SPEC §9: autentica ANTES de qualquer parse, grava em `webhook_events` com `(provider, event_id)`
 * único, enfileira `webhooks/process` e só então responde 200. Nenhuma regra de negócio roda aqui.
 * - Token inválido: 401 e nada é gravado. Cada 401 vai para o log; o alerta sai uma vez por janela (anti-inundação).
 * - Evento repetido: 200 sem reprocessar; se o anterior ainda não terminou (ex.: ficou sem enfileirar), enfileira de novo.
 * - Falha ao enfileirar: 500, para o provedor reenviar (o registro fica em `received` e a varredura também o pega).
 */
export async function receiveWebhook(rawBody: string, headers: Headers, deps: WebhookDeps): Promise<ReceiveResult> {
  const log = withContext({})
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return { status: 413, body: { ok: false, error: 'payload_too_large' } }
  }

  let event
  try {
    event = await deps.provider.parseWebhook(rawBody, headers)
  } catch (error) {
    if (error instanceof WebhookAuthError) {
      // Sem payload no log (SPEC §9, passo 2). Sem `alert: true` por requisição: quem conhece a URL poderia inundar
      // o canal de alertas. O alerta é um por janela, com a contagem dos 401 silenciados.
      log.warn({ alertCode: 'webhook_auth_failed' }, 'webhook com token inválido')
      const decision = (deps.authFailures ?? processAuthFailures).record()
      if (decision.alert) {
        deps.alert({
          severity: 'warning',
          code: 'webhook_auth_failed',
          message: 'Webhook recusado por token inválido ou ausente',
          context: { suppressedSinceLastAlert: decision.suppressed },
        })
      }
      return { status: 401, body: { ok: false, error: 'unauthorized' } }
    }
    if (error instanceof WebhookPayloadError) {
      log.warn({ alertCode: 'webhook_payload_invalid' }, 'webhook autenticado com corpo inválido')
      return { status: 400, body: { ok: false, error: 'invalid_payload' } }
    }
    throw error
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return { status: 400, body: { ok: false, error: 'invalid_payload' } }
  }

  const stored = await deps.run(async (db) => {
    const row = await insertEvent(db, {
      id: newId(),
      provider: event.provider,
      eventId: event.eventId,
      type: event.type,
      rawType: event.rawType,
      providerPaymentId: event.providerPaymentId,
      splitId: event.splitId,
      payload: payload as object,
    })
    if (row.inserted) return { ...row, terminal: false }
    const status = await readStatus(db, row.id)
    return { ...row, terminal: !!status && TERMINAL_STATUSES.has(status.status) }
  })

  if (stored.terminal) return { status: 200, body: { ok: true, duplicate: true } }

  try {
    await deps.enqueue([stored.id])
  } catch (error) {
    log.error({ alertCode: 'webhook_enqueue_failed', webhookEventId: stored.id, err: error }, 'falha ao enfileirar webhook')
    return { status: 500, body: { ok: false, error: 'enqueue_failed' } }
  }
  return { status: 200, body: { ok: true, ...(stored.inserted ? {} : { duplicate: true }) } }
}
