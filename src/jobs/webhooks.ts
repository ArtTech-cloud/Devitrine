import { NonRetriableError } from 'inngest'
import { getWebhookDeps } from '@/lib/composition'
import { PROCESS_EVENT_NAME, processWebhookEvent, sweepStuckWebhooks, WebhookDeadError } from '@/modules/webhooks'
import { inngest } from './client'

/** `webhooks/process` (SPEC §9, passos 6 e 7): retry com backoff até 10 tentativas (a 1ª + 9 retries). */
export const processWebhook = inngest.createFunction(
  // retries = MAX_ATTEMPTS - 1 (a 1ª tentativa + 9 retries); o tipo do Inngest exige literal e um teste garante a igualdade.
  { id: 'webhooks-process', retries: 9, triggers: [{ event: PROCESS_EVENT_NAME }] },
  async ({ event }) => {
    const webhookEventId = String((event.data as { webhookEventId?: unknown }).webhookEventId ?? '')
    if (!webhookEventId) throw new NonRetriableError('webhooks/process sem webhookEventId')
    try {
      return await processWebhookEvent(webhookEventId, getWebhookDeps())
    } catch (error) {
      // Esgotou as tentativas: o evento já está `failed` e o alerta saiu; o admin reprocessa pelo painel.
      if (error instanceof WebhookDeadError) throw new NonRetriableError(error.message, { cause: error })
      throw error
    }
  },
)

/** Varredura a cada 5 minutos: reenfileira o que ficou parado em `received` (SPEC §9, passo 4). */
export const sweepWebhooks = inngest.createFunction(
  { id: 'webhooks-sweep', triggers: [{ cron: '*/5 * * * *' }] },
  async () => sweepStuckWebhooks(getWebhookDeps()),
)
