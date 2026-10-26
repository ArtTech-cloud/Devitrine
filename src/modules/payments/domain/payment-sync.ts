import { splitFitsNet } from './charge-rules'
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

/**
 * Só `pending` pode ir para `overdue` ou `deleted`; só cobrança paga pode ser estornada ou contestada.
 * De `overdue` ou `deleted` nada avança: se o gateway depois mostra pago, é `paidAfterCancel`, não uma transição.
 */
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
  orderId: string
  status: ChargeStatus
  splitStatus: SplitStatus
  grossCents: bigint
  devAmountCents: bigint
  devWalletId: string
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
  /**
   * Gateway mostra a cobrança paga, mas ela estava gravada como vencida ou apagada (o pedido já foi cancelado).
   * Nunca confirma o pedido nem lança sozinho: alerta crítico e decisão humana (SPEC §9, `paid_after_cancel`).
   */
  paidAfterCancel: boolean
  /**
   * Valores do gateway diferentes dos gravados (bruto, parte do dev ou carteira). Falha fechado: o evento não
   * lança no ledger, não confirma o pedido e não muda nada; fica em retry com alerta (SPEC §9).
   */
  mismatches: string[]
  /**
   * Na primeira vez paga, a parte do dev não cabe no líquido real (SPEC §8, item 4): o gateway bloquearia o split.
   * Falha fechado, como a divergência: nada é lançado nem confirmado até uma pessoa resolver.
   */
  splitExceedsNet: boolean
  changed: boolean
}

export function planPaymentSync(stored: StoredPayment, charge: Charge): PaymentSyncPlan {
  const status = canAdvanceStatus(stored.status, charge.status) ? charge.status : stored.status
  const splitStatus = canAdvanceSplit(stored.splitStatus, charge.splitStatus) ? charge.splitStatus : stored.splitStatus
  // O líquido só é fixado quando o pagamento é confirmado; antes disso é estimativa do gateway.
  const netCents = stored.confirmedAt ? stored.netCents : (charge.netCents ?? stored.netCents)
  const firstPaid = !stored.confirmedAt && isPaidStatus(status)
  const cancelled = stored.status === 'pending' && (status === 'overdue' || status === 'deleted')
  const paidAfterCancel =
    (stored.status === 'overdue' || stored.status === 'deleted') && isPaidStatus(charge.status)
  const mismatches: string[] = []
  // `charge.orderId` é o externalReference da cobrança: ela precisa ser deste pedido.
  if (charge.orderId !== stored.orderId) mismatches.push('order_id')
  if (charge.grossCents !== stored.grossCents) mismatches.push('gross_cents')
  if (charge.devAmountCents !== stored.devAmountCents) mismatches.push('dev_amount_cents')
  if (charge.devWalletId !== stored.devWalletId) mismatches.push('dev_wallet_id')
  return {
    status,
    splitStatus,
    netCents,
    firstPaid,
    cancelled,
    paidAfterCancel,
    mismatches,
    splitExceedsNet: firstPaid && netCents !== null && !splitFitsNet(stored.devAmountCents, netCents),
    changed: status !== stored.status || splitStatus !== stored.splitStatus || netCents !== stored.netCents,
  }
}
