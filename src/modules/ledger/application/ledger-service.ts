import 'server-only'
import type { Db } from '@/lib/db'
import { devAccount, type LedgerAccountRef } from '../domain/accounts'
import { assertBalanced, type LedgerTx } from '../domain/transaction'
import { insertLedgerTx, readAllBalances, readBalanceCents, type PostResult } from '../infra/ledger-repository'

/**
 * Lança um lote no ledger dentro da transação de `db` (a mesma de `transition()`, no job de webhook).
 * Valida o fechamento antes de ir ao banco; o banco valida de novo. Repetir a chave não lança de novo.
 */
export async function postLedgerTx(db: Db, tx: LedgerTx): Promise<PostResult> {
  assertBalanced(tx.lines)
  return insertLedgerTx(db, tx)
}

/** Saldo derivado dos lançamentos (nunca é coluna). */
export function getBalanceCents(db: Db, account: LedgerAccountRef): Promise<bigint> {
  return readBalanceCents(db, account)
}

/** Saldo disponível do dev = dev_available − dev_receivable (SPEC §6); é o que o saque pode usar. */
export async function getDevSpendableCents(db: Db, devId: string): Promise<bigint> {
  const available = await readBalanceCents(db, devAccount('dev_available', devId))
  const receivable = await readBalanceCents(db, devAccount('dev_receivable', devId))
  return available - receivable
}

export function getAllBalances(db: Db): Promise<Map<string, bigint>> {
  return readAllBalances(db)
}
