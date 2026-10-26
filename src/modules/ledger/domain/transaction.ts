import { newId } from '@/lib/ids'
import type { Direction, LedgerAccountRef } from './accounts'

export type LedgerTxKind =
  | 'payment_confirmed'
  | 'order_release'
  | 'escrow_finished'
  | 'withdrawal_approved'
  | 'withdrawal_done'
  | 'withdrawal_failed'
  | 'refund_total'
  | 'refund_partial'
  | 'chargeback_after_release'

export interface LedgerLine {
  account: LedgerAccountRef
  direction: Direction
  /** Centavos inteiros, sempre positivos; o sentido vem de `direction`. */
  amountCents: bigint
}

/** Um lote: todas as linhas entram juntas ou nenhuma entra (débitos = créditos). */
export interface LedgerTx {
  txId: string
  kind: LedgerTxKind
  /** Chave do evento de negócio que gerou o lote; repetir o evento não lança de novo. */
  idempotencyKey: string
  orderId: string | null
  lines: LedgerLine[]
}

export type LedgerErrorCode = 'unbalanced' | 'invalid_line' | 'idempotency_conflict'

export class LedgerError extends Error {
  readonly code: LedgerErrorCode
  constructor(code: LedgerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LedgerError'
    this.code = code
  }
}

export function totals(lines: readonly LedgerLine[]): { debits: bigint; credits: bigint } {
  let debits = 0n
  let credits = 0n
  for (const l of lines) {
    if (l.direction === 'debit') debits += l.amountCents
    else credits += l.amountCents
  }
  return { debits, credits }
}

/** Rejeita o lote inteiro se alguma linha for inválida ou se débitos ≠ créditos. */
export function assertBalanced(lines: readonly LedgerLine[]): void {
  if (lines.length < 2) throw new LedgerError('invalid_line', 'Lote precisa de ao menos duas linhas')
  for (const l of lines) {
    if (typeof l.amountCents !== 'bigint' || l.amountCents <= 0n) {
      throw new LedgerError('invalid_line', 'Cada linha precisa de valor inteiro positivo em centavos')
    }
    if (l.direction !== 'debit' && l.direction !== 'credit') {
      throw new LedgerError('invalid_line', 'Direção inválida')
    }
  }
  const { debits, credits } = totals(lines)
  if (debits !== credits) {
    throw new LedgerError('unbalanced', `Lote não fecha: débitos ${debits} ≠ créditos ${credits}`)
  }
}

export function newTx(input: Omit<LedgerTx, 'txId'> & { txId?: string }): LedgerTx {
  assertBalanced(input.lines)
  return { ...input, txId: input.txId ?? newId() }
}
