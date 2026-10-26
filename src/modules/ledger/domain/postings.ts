import { splitAmount } from '@/lib/money'
import { devAccount, platformAccount, type LedgerAccountRef } from './accounts'
import { LedgerError, newTx, type LedgerLine, type LedgerTx } from './transaction'

// Um construtor por evento da tabela "Lançamentos do ledger" (SPEC §6).
// G = valor bruto, F = taxa do gateway, D = parte do dev, P = G − D, W = valor de saque.
// Linhas de valor zero são omitidas (o ledger só aceita valores positivos).

interface Base {
  idempotencyKey: string
  orderId: string | null
  txId?: string
}

const debit = (account: LedgerAccountRef, amountCents: bigint): LedgerLine => ({
  account,
  direction: 'debit',
  amountCents,
})
const credit = (account: LedgerAccountRef, amountCents: bigint): LedgerLine => ({
  account,
  direction: 'credit',
  amountCents,
})
const nonZero = (lines: LedgerLine[]) => lines.filter((l) => l.amountCents !== 0n)

function requirePositive(name: string, value: bigint) {
  if (typeof value !== 'bigint' || value <= 0n) throw new LedgerError('invalid_line', `${name} precisa ser > 0`)
}

/** Pagamento confirmado: gateway_cash G − F e gateway_fees F contra escrow_liability G. `netCents` = G − F. */
export function paymentConfirmed(input: Base & { grossCents: bigint; netCents: bigint }): LedgerTx {
  requirePositive('grossCents', input.grossCents)
  if (input.netCents < 0n || input.netCents > input.grossCents) {
    throw new LedgerError('invalid_line', 'netCents precisa estar entre 0 e grossCents')
  }
  const feeCents = input.grossCents - input.netCents
  return newTx({
    kind: 'payment_confirmed',
    idempotencyKey: input.idempotencyKey,
    orderId: input.orderId,
    txId: input.txId,
    lines: nonZero([
      debit(platformAccount('gateway_cash'), input.netCents),
      debit(platformAccount('gateway_fees'), feeCents),
      credit(platformAccount('escrow_liability'), input.grossCents),
    ]),
  })
}

/** Pedido aprovado (liberação): escrow_liability G contra dev_payable D e platform_revenue P = G − D. */
export function orderRelease(
  input: Base & { devId: string; grossCents: bigint; devAmountCents: bigint },
): LedgerTx {
  requirePositive('grossCents', input.grossCents)
  requirePositive('devAmountCents', input.devAmountCents)
  if (input.devAmountCents > input.grossCents) {
    throw new LedgerError('invalid_line', 'A parte do dev não pode passar do valor bruto')
  }
  const platformCents = input.grossCents - input.devAmountCents
  return newTx({
    kind: 'order_release',
    idempotencyKey: input.idempotencyKey,
    orderId: input.orderId,
    txId: input.txId,
    lines: nonZero([
      debit(platformAccount('escrow_liability'), input.grossCents),
      credit(devAccount('dev_payable', input.devId), input.devAmountCents),
      credit(platformAccount('platform_revenue'), platformCents),
    ]),
  })
}

/** Garantia encerrada no gateway: dev_payable D → dev_available D. */
export function escrowFinished(input: Base & { devId: string; devAmountCents: bigint }): LedgerTx {
  requirePositive('devAmountCents', input.devAmountCents)
  return newTx({
    kind: 'escrow_finished',
    idempotencyKey: input.idempotencyKey,
    orderId: input.orderId,
    txId: input.txId,
    lines: [
      debit(devAccount('dev_payable', input.devId), input.devAmountCents),
      credit(devAccount('dev_available', input.devId), input.devAmountCents),
    ],
  })
}

/** Saque aprovado na validação: dev_available W → dev_withdrawal_pending W (sai do disponível na hora). */
export function withdrawalApproved(input: Base & { devId: string; amountCents: bigint }): LedgerTx {
  requirePositive('amountCents', input.amountCents)
  return newTx({
    kind: 'withdrawal_approved',
    idempotencyKey: input.idempotencyKey,
    orderId: input.orderId,
    txId: input.txId,
    lines: [
      debit(devAccount('dev_available', input.devId), input.amountCents),
      credit(devAccount('dev_withdrawal_pending', input.devId), input.amountCents),
    ],
  })
}

/** Saque concluído (`TRANSFER_DONE`): dev_withdrawal_pending W → gateway_cash W. */
export function withdrawalDone(input: Base & { devId: string; amountCents: bigint }): LedgerTx {
  requirePositive('amountCents', input.amountCents)
  return newTx({
    kind: 'withdrawal_done',
    idempotencyKey: input.idempotencyKey,
    orderId: input.orderId,
    txId: input.txId,
    lines: [
      debit(devAccount('dev_withdrawal_pending', input.devId), input.amountCents),
      credit(platformAccount('gateway_cash'), input.amountCents),
    ],
  })
}

/** Saque falhou ou foi cancelado: dev_withdrawal_pending W → dev_available W. */
export function withdrawalFailed(input: Base & { devId: string; amountCents: bigint }): LedgerTx {
  requirePositive('amountCents', input.amountCents)
  return newTx({
    kind: 'withdrawal_failed',
    idempotencyKey: input.idempotencyKey,
    orderId: input.orderId,
    txId: input.txId,
    lines: [
      debit(devAccount('dev_withdrawal_pending', input.devId), input.amountCents),
      credit(devAccount('dev_available', input.devId), input.amountCents),
    ],
  })
}

/** Reembolso total antes da liberação: escrow_liability G → gateway_cash G. */
export function refundTotal(input: Base & { grossCents: bigint }): LedgerTx {
  requirePositive('grossCents', input.grossCents)
  return newTx({
    kind: 'refund_total',
    idempotencyKey: input.idempotencyKey,
    orderId: input.orderId,
    txId: input.txId,
    lines: [
      debit(platformAccount('escrow_liability'), input.grossCents),
      credit(platformAccount('gateway_cash'), input.grossCents),
    ],
  })
}

/**
 * Parte do dev (D′) e da plataforma (P′) sobre o que sobra depois de um reembolso parcial R:
 * taxa de `feeBps` sobre G − R (SPEC §6, "P′ sobre G − R"); D′ = (G − R) − P′, então a soma fecha.
 */
export function partialRefundSplit(grossCents: bigint, refundCents: bigint, feeBps: number) {
  if (refundCents <= 0n || refundCents >= grossCents) {
    throw new LedgerError('invalid_line', 'Reembolso parcial precisa estar entre 0 e o valor bruto')
  }
  const { platformFeeCents, devAmountCents } = splitAmount(grossCents - refundCents, feeBps)
  return { devPayableCents: devAmountCents, platformRevenueCents: platformFeeCents }
}

/**
 * Reembolso parcial R na disputa: escrow_liability G contra gateway_cash R, dev_payable D′ e
 * platform_revenue P′, com R + D′ + P′ = G.
 */
export function refundPartial(
  input: Base & {
    devId: string
    grossCents: bigint
    refundCents: bigint
    devPayableCents: bigint
    platformRevenueCents: bigint
  },
): LedgerTx {
  requirePositive('grossCents', input.grossCents)
  requirePositive('refundCents', input.refundCents)
  if (input.devPayableCents < 0n || input.platformRevenueCents < 0n) {
    throw new LedgerError('invalid_line', 'D′ e P′ não podem ser negativos')
  }
  if (input.refundCents + input.devPayableCents + input.platformRevenueCents !== input.grossCents) {
    throw new LedgerError('unbalanced', 'R + D′ + P′ precisa ser igual ao valor bruto')
  }
  return newTx({
    kind: 'refund_partial',
    idempotencyKey: input.idempotencyKey,
    orderId: input.orderId,
    txId: input.txId,
    lines: nonZero([
      debit(platformAccount('escrow_liability'), input.grossCents),
      credit(platformAccount('gateway_cash'), input.refundCents),
      credit(devAccount('dev_payable', input.devId), input.devPayableCents),
      credit(platformAccount('platform_revenue'), input.platformRevenueCents),
    ]),
  })
}

/**
 * Chargeback depois da liberação: dev_receivable D e platform_revenue P contra gateway_cash G.
 * Supõe que a plataforma arca com a contestação e cobra o dev depois (SPEC §6; confirmar no Asaas, §14).
 */
export function chargebackAfterRelease(
  input: Base & { devId: string; grossCents: bigint; devAmountCents: bigint },
): LedgerTx {
  requirePositive('grossCents', input.grossCents)
  requirePositive('devAmountCents', input.devAmountCents)
  if (input.devAmountCents > input.grossCents) {
    throw new LedgerError('invalid_line', 'A parte do dev não pode passar do valor bruto')
  }
  const platformCents = input.grossCents - input.devAmountCents
  return newTx({
    kind: 'chargeback_after_release',
    idempotencyKey: input.idempotencyKey,
    orderId: input.orderId,
    txId: input.txId,
    lines: nonZero([
      debit(devAccount('dev_receivable', input.devId), input.devAmountCents),
      debit(platformAccount('platform_revenue'), platformCents),
      credit(platformAccount('gateway_cash'), input.grossCents),
    ]),
  })
}
