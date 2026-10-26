import 'server-only'
import type { Db } from '@/lib/db'
import { newId } from '@/lib/ids'
import { checkLedgerTx, paymentConfirmed } from '@/modules/ledger'
import { isPaidStatus } from '../domain/payment-sync'
import type { AlertSink } from '../domain/ports'
import type { Charge, PaymentProvider } from '../domain/provider'
import {
  findPaymentByProviderId,
  insertReconciliationRun,
  listPaymentsCreatedBetween,
  type PaymentRow,
} from '../infra/payments-repository'
import { paymentConfirmedKey } from './apply-event'

/** Janela da conciliação diária (SPEC §9). */
export const RECONCILIATION_WINDOW_HOURS = 72
/** Eventos ainda em voo não são divergência: cobranças mexidas há menos que isto só contam se faltarem dados. */
export const RECONCILIATION_GRACE_MINUTES = 15

export type DivergenceKind =
  | 'missing_payment_row'
  | 'missing_at_provider'
  | 'status_mismatch'
  | 'split_mismatch'
  | 'amount_mismatch'
  | 'net_mismatch'
  | 'ledger_missing'
  | 'ledger_mismatch'
  | 'ledger_without_payment'
  | 'unbooked_reversal'

export interface Divergence {
  kind: DivergenceKind
  providerPaymentId: string
  orderId: string | null
  detail: string
}

export interface ReconciliationReport {
  runId: string
  windowFrom: Date
  windowTo: Date
  chargesChecked: number
  divergences: Divergence[]
}

const REVERSALS = new Set<Charge['status']>(['refunded', 'partially_refunded', 'chargeback'])

/**
 * Compara as cobranças (e os splits) das últimas 72 h no gateway com `payments` e com o ledger. Só lê; grava o
 * resultado em `reconciliation_runs` e dispara um alerta por divergência (o painel do admin, na Fase 4, lista
 * as execuções). Estorno e chargeback aparecem como divergência até a Fase 3 lançá-los no ledger.
 */
export async function reconcilePayments(
  db: Db,
  provider: PaymentProvider,
  alert: AlertSink,
  opts: { now?: Date } = {},
): Promise<ReconciliationReport> {
  const now = opts.now ?? new Date()
  const windowFrom = new Date(now.getTime() - RECONCILIATION_WINDOW_HOURS * 3_600_000)
  const grace = new Date(now.getTime() - RECONCILIATION_GRACE_MINUTES * 60_000)
  const charges = await provider.listCharges({ from: windowFrom, to: now })
  const divergences: Divergence[] = []
  const seen = new Set<string>()

  for (const charge of charges) {
    seen.add(charge.providerPaymentId)
    const row = await findPaymentByProviderId(db, provider.name, charge.providerPaymentId)
    const inFlight = (charge.paidAt ?? charge.createdAt) > grace
    const add = (kind: DivergenceKind, detail: string) =>
      divergences.push({
        kind,
        providerPaymentId: charge.providerPaymentId,
        orderId: row?.orderId ?? charge.orderId,
        detail,
      })

    if (!row) {
      if (!inFlight) add('missing_payment_row', 'Cobrança existe no gateway e não em payments')
      continue
    }
    if (charge.grossCents !== row.grossCents) {
      add('amount_mismatch', `bruto: gateway ${charge.grossCents}, payments ${row.grossCents}`)
    }
    if (charge.devAmountCents !== row.devAmountCents || charge.devWalletId !== row.devWalletId) {
      add('amount_mismatch', `split do dev: gateway ${charge.devAmountCents}, payments ${row.devAmountCents}`)
    }
    if (!inFlight) {
      if (charge.status !== row.status) add('status_mismatch', `gateway ${charge.status}, payments ${row.status}`)
      if (charge.splitStatus !== row.splitStatus) {
        add('split_mismatch', `gateway ${charge.splitStatus}, payments ${row.splitStatus}`)
      }
    }
    await checkLedger(db, provider, charge, row, inFlight, add)
  }

  for (const row of await listPaymentsCreatedBetween(db, windowFrom, now)) {
    if (row.provider === provider.name && !seen.has(row.providerPaymentId) && row.createdAt <= grace) {
      divergences.push({
        kind: 'missing_at_provider',
        providerPaymentId: row.providerPaymentId,
        orderId: row.orderId,
        detail: 'Cobrança existe em payments e não no gateway',
      })
    }
  }

  const runId = newId()
  await insertReconciliationRun(db, {
    id: runId,
    windowFrom,
    windowTo: now,
    chargesChecked: charges.length,
    divergences,
  })
  for (const d of divergences) {
    alert({
      severity: 'critical',
      code: `reconciliation_${d.kind}`,
      message: d.detail,
      context: { orderId: d.orderId, providerPaymentId: d.providerPaymentId, runId },
    })
  }
  return { runId, windowFrom, windowTo: now, chargesChecked: charges.length, divergences }
}

async function checkLedger(
  db: Db,
  provider: PaymentProvider,
  charge: Charge,
  row: PaymentRow,
  inFlight: boolean,
  add: (kind: DivergenceKind, detail: string) => void,
) {
  const key = paymentConfirmedKey(provider.name, charge.providerPaymentId)
  if (!isPaidStatus(charge.status)) {
    // Cobrança não paga no gateway não pode ter lançamento de pagamento.
    if (row.confirmedAt) add('ledger_without_payment', `payments marca pago, gateway ${charge.status}`)
    return
  }
  if (REVERSALS.has(charge.status)) {
    add('unbooked_reversal', `${charge.status}: o lançamento de estorno ou chargeback é da Fase 3`)
  }
  if (!row.confirmedAt || row.netCents === null) {
    if (!inFlight) add('ledger_missing', 'Gateway marca pago e payments ainda não confirmou o pagamento')
    return
  }
  if (charge.netCents !== null && charge.netCents !== row.netCents) {
    add('net_mismatch', `líquido: gateway ${charge.netCents}, payments ${row.netCents}`)
  }
  const expected = paymentConfirmed({
    idempotencyKey: key,
    orderId: row.orderId,
    grossCents: row.grossCents,
    netCents: row.netCents,
  })
  const state = await checkLedgerTx(db, expected)
  if (state === 'missing') add('ledger_missing', 'Pagamento confirmado sem lançamento no ledger')
  if (state === 'mismatch') add('ledger_mismatch', 'Lançamento do ledger com conteúdo diferente do esperado')
}
