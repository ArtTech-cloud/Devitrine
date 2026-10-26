import type { NormalizedEventType } from './provider'

// Nomes de evento do Asaas tratados no MVP, tal como estão na SPEC §9 (conferidos em out/2026).
// Evento fora desta lista vira `ignored`: é gravado na caixa de entrada, mas não gera efeito.
const ASAAS_EVENT_TYPES: Readonly<Record<string, NormalizedEventType>> = {
  PAYMENT_CONFIRMED: 'payment_confirmed',
  PAYMENT_RECEIVED: 'payment_received',
  PAYMENT_OVERDUE: 'payment_overdue',
  PAYMENT_DELETED: 'payment_deleted',
  PAYMENT_SPLIT_DONE: 'split_done',
  PAYMENT_SPLIT_DIVERGENCE_BLOCK: 'split_divergence_block',
  PAYMENT_SPLIT_DIVERGENCE_BLOCK_FINISHED: 'split_cancelled',
  PAYMENT_SPLIT_CANCELLED: 'split_cancelled',
  PAYMENT_REFUNDED: 'payment_refunded',
  PAYMENT_PARTIALLY_REFUNDED: 'payment_partially_refunded',
  PAYMENT_CHARGEBACK_REQUESTED: 'chargeback_requested',
  PAYMENT_CHARGEBACK_DISPUTE: 'chargeback_dispute',
  PAYMENT_AWAITING_CHARGEBACK_REVERSAL: 'chargeback_reversal_awaiting',
}

export function normalizeAsaasEventName(rawType: string): NormalizedEventType {
  return ASAAS_EVENT_TYPES[rawType] ?? 'ignored'
}

/** Inverso, para o fake emitir os mesmos nomes que a SPEC lista. */
export function asaasEventNameFor(type: Exclude<NormalizedEventType, 'ignored'>): string {
  const entry = Object.entries(ASAAS_EVENT_TYPES).find(([, t]) => t === type)
  if (!entry) throw new Error(`Sem nome de evento para ${type}`)
  return entry[0]
}
