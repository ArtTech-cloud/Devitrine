import 'server-only'
import { and, eq, gte, lte, sql } from 'drizzle-orm'
import { schema, type Db } from '@/lib/db'
import type { ChargeStatus, SplitStatus, WebhookProvider } from '../domain/provider'

export type PaymentRow = typeof schema.payments.$inferSelect

export function pgCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } } | null
  return e?.cause?.code ?? e?.code
}

/** Serializa o trabalho sobre a mesma chave dentro da transação (liberado no COMMIT ou ROLLBACK). */
export async function advisoryLock(db: Db, key: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
}

export async function findPaymentByProviderId(
  db: Db,
  provider: WebhookProvider,
  providerPaymentId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<PaymentRow | undefined> {
  const q = db
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.provider, provider), eq(schema.payments.providerPaymentId, providerPaymentId)))
  const [row] = opts.forUpdate ? await q.for('update') : await q
  return row
}

export async function findOpenPaymentForOrder(db: Db, orderId: string): Promise<PaymentRow | undefined> {
  const [row] = await db
    .select()
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.orderId, orderId),
        sql`${schema.payments.status} in ('pending', 'confirmed', 'received')`,
      ),
    )
  return row
}

export async function insertPayment(db: Db, row: typeof schema.payments.$inferInsert): Promise<PaymentRow> {
  const [created] = await db.insert(schema.payments).values(row).returning()
  return created!
}

export async function updatePayment(
  db: Db,
  id: string,
  patch: {
    status: ChargeStatus
    splitStatus: SplitStatus
    netCents: bigint | null
    escrowId?: string | null
    confirmedAt?: Date
  },
): Promise<void> {
  await db
    .update(schema.payments)
    .set({
      status: patch.status,
      splitStatus: patch.splitStatus,
      netCents: patch.netCents,
      ...(patch.escrowId !== undefined ? { escrowId: patch.escrowId } : {}),
      ...(patch.confirmedAt ? { confirmedAt: patch.confirmedAt } : {}),
    })
    .where(eq(schema.payments.id, id))
}

export async function listPaymentsCreatedBetween(db: Db, from: Date, to: Date): Promise<PaymentRow[]> {
  return db
    .select()
    .from(schema.payments)
    .where(and(gte(schema.payments.createdAt, from), lte(schema.payments.createdAt, to)))
}

export async function findIdempotencyKey(db: Db, scope: string, key: string) {
  const [row] = await db
    .select()
    .from(schema.idempotencyKeys)
    .where(and(eq(schema.idempotencyKeys.scope, scope), eq(schema.idempotencyKeys.key, key)))
  return row
}

export async function insertIdempotencyKey(
  db: Db,
  row: { scope: string; key: string; requestHash: string; resultRef: string },
): Promise<void> {
  await db.insert(schema.idempotencyKeys).values(row)
}

export async function insertReconciliationRun(
  db: Db,
  row: typeof schema.reconciliationRuns.$inferInsert,
): Promise<void> {
  await db.insert(schema.reconciliationRuns).values(row)
}
