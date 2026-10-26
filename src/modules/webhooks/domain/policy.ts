// Regras da caixa de entrada de webhooks (SPEC §9, ADR-005, ADR-020).

/** Tentativas antes de o evento virar `failed` (SPEC §9, passo 7). */
export const MAX_ATTEMPTS = 10

/** Corpo máximo aceito; os eventos do gateway são pequenos, e o limite barra abuso antes de qualquer parse. */
export const MAX_BODY_BYTES = 1_000_000

/** A varredura só reenfileira o que está em `received` há mais que isto, para não disputar com o envio normal. */
export const SWEEP_GRACE_SECONDS = 120

/** Máximo de eventos reenfileirados por varredura; o resto fica para a próxima (a cada 5 minutos). */
export const SWEEP_BATCH = 200

/** Nome do evento do Inngest que dispara o processamento. */
export const PROCESS_EVENT_NAME = 'webhooks/process'

/** Status derivado de `webhook_event_runs` (view `webhook_event_status`). */
export type WebhookStatus = 'received' | 'processed' | 'ignored' | 'retrying' | 'failed'

export const TERMINAL_STATUSES: ReadonlySet<WebhookStatus> = new Set(['processed', 'ignored', 'failed'])

/** Esgotou as tentativas? `attempts` já inclui a que acabou de falhar. */
export const isLastAttempt = (attempts: number): boolean => attempts >= MAX_ATTEMPTS

/** Mensagem de erro gravável: truncada e sem quebrar a coluna (o logger mascara segredos na saída de log). */
export function errorText(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return text.slice(0, 500)
}

export class WebhookDeadError extends Error {
  constructor(
    readonly webhookEventId: string,
    cause: unknown,
  ) {
    super(`Webhook ${webhookEventId} esgotou ${MAX_ATTEMPTS} tentativas`, { cause })
    this.name = 'WebhookDeadError'
  }
}
