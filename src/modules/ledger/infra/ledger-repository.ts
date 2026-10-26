import 'server-only'
import { sql } from 'drizzle-orm'
import type { Db } from '@/lib/db'
import type { LedgerAccountRef } from '../domain/accounts'
import { LedgerError, type LedgerTx } from '../domain/transaction'

export type PostResult = 'posted' | 'duplicate'

function pgCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } } | null
  return e?.cause?.code ?? e?.code
}

/**
 * Única escrita em ledger_entries: chama `ledger_post`, que valida o lote inteiro e é idempotente
 * pela chave. Roda na transação de `db`, então o chamador pode juntar o lançamento a `transition()`.
 */
export async function insertLedgerTx(db: Db, tx: LedgerTx): Promise<PostResult> {
  const lines = tx.lines.map((l) => ({
    code: l.account.code,
    owner_id: 'ownerId' in l.account ? l.account.ownerId : null,
    direction: l.direction,
    amount_cents: l.amountCents.toString(),
  }))
  try {
    const rows = await db.execute<{ result: PostResult }>(
      sql`select public.ledger_post(${tx.txId}::uuid, ${tx.kind}, ${tx.idempotencyKey},
        ${tx.orderId}::uuid, ${JSON.stringify(lines)}::jsonb) as result`,
    )
    return rows[0]!.result
  } catch (error) {
    const code = pgCode(error)
    if (code === '23505') throw new LedgerError('idempotency_conflict', 'Chave de idempotência reutilizada com outro conteúdo', { cause: error })
    if (code === '23514') throw new LedgerError('unbalanced', 'Lote recusado pelo banco', { cause: error })
    throw error
  }
}

export async function readBalanceCents(db: Db, account: LedgerAccountRef): Promise<bigint> {
  const owner = 'ownerId' in account ? account.ownerId : null
  const rows = await db.execute<{ balance: string }>(
    sql`select public.ledger_balance(${account.code}, ${owner}::uuid)::text as balance`,
  )
  return BigInt(rows[0]!.balance)
}

/** Todos os saldos de uma vez (conciliação e testes). Chave = `accountKey`. */
export async function readAllBalances(db: Db): Promise<Map<string, bigint>> {
  const rows = await db.execute<{ code: string; owner_id: string | null; balance: string }>(
    sql`select a.code, a.owner_id,
        coalesce(sum(case when e.direction = a.normal_side then e.amount_cents else -e.amount_cents end), 0)::text as balance
      from public.ledger_accounts a left join public.ledger_entries e on e.account_id = a.id
      group by a.id, a.code, a.owner_id`,
  )
  const out = new Map<string, bigint>()
  for (const r of rows) {
    const key = r.owner_id ? `${r.code}:${r.owner_id}` : r.code
    out.set(key, BigInt(r.balance))
  }
  return out
}

