import type { Charge, ChargeStatus, SplitStatus } from './provider'

// Regras puras de como a cobrança gravada acompanha a do gateway (SPEC §9, passo 6). O job sempre busca o
// recurso no provedor e aplica o estado atual, não o do evento: assim o mesmo estado final vale para qualquer
// ordem e repetição. Um estado só avança (nunca volta), para uma consulta atrasada não desfazer um evento mais novo.

const STATUS_RANK: Readonly<Record<ChargeStatus, number>> = {
  pending: 0,
  confirmed: 1,
  received: 2,
  partially_refunded: 3,
  refunded: 4,
  chargeback: 4,
  overdue: 4,
  deleted: 4,
}

/** Estados em que o cliente pagou: o ledger precisa ter o lançamento de pagamento confirmado. */
const PAID_IMPLYING: ReadonlySet<ChargeStatus> = new Set([
  'confirmed',
  'received',
  'partially_refunded',
  'refunded',
  'chargeback',
])

const SPLIT_RANK: Readonly<Record<SplitStatus, number>> = { pending: 0, blocked: 1, done: 2, cancelled: 3 }

export const isPaidStatus = (s: ChargeStatus): boolean => PAID_IMPLYING.has(s)

/** Só `pending` pode ir para `overdue` ou `deleted`; só cobrança paga pode ser estornada ou contestada. */
export function canAdvanceStatus(from: ChargeStatus, to: ChargeStatus): boolean {
  if (from === to) return false
  if (to === 'overdue' || to === 'deleted') return from === 'pending'
  if (from === 'overdue' || from === 'deleted') return false
  return STATUS_RANK[to] > STATUS_RANK[from]
}

export function canAdvanceSplit(from: SplitStatus, to: SplitStatus): boolean {
  return SPLIT_RANK[to] > SPLIT_RANK[from]
}

export interface StoredPayment {
  status: ChargeStatus
  splitStatus: SplitStatus
  grossCents: bigint
  devAmountCents: bigint
  netCents: bigint | null
  escrowId: string | null
  confirmedAt: Date | null
}

export interface PaymentSyncPlan {
  status: ChargeStatus
  splitStatus: SplitStatus
  netCents: bigint | null
  /** Primeira vez que o pagamento aparece como pago: grava `confirmed_at`, lança no ledger e avisa o pedido. */
  firstPaid: boolean
  /** Cobrança venceu ou foi apagada sem pagamento: o pedido volta a `cancelled`. */
  cancelled: boolean
  /** Estado que o gateway não respeita (valores diferentes dos gravados): vira alerta, nunca é corrigido sozinho. */
  mismatches: string[]
  changed: boolean
}

export function planPaymentSync(stored: StoredPayment, charge: Charge): PaymentSyncPlan {
  const status = canAdvanceStatus(stored.status, charge.status) ? charge.status : stored.status
  const splitStatus = canAdvanceSplit(stored.splitStatus, charge.splitStatus) ? charge.splitStatus : stored.splitStatus
  // O líquido só é fixado quando o pagamento é confirmado; antes disso é estimativa do gateway.
  const netCents = stored.confirmedAt ? stored.netCents : (charge.netCents ?? stored.netCents)
  const firstPaid = !stored.confirmedAt && isPaidStatus(status)
  const cancelled = stored.status === 'pending' && (status === 'overdue' || status === 'deleted')
  const mismatches: string[] = []
  if (charge.grossCents !== stored.grossCents) mismatches.push('gross_cents')
  if (charge.devAmountCents !== stored.devAmountCents) mismatches.push('dev_amount_cents')
  return {
    status,
    splitStatus,
    netCents,
    firstPaid,
    cancelled,
    mismatches,
    changed: status !== stored.status || splitStatus !== stored.splitStatus || netCents !== stored.netCents,
  }
}
