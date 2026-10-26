import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { schema, type Db } from '@/lib/db'
import type { WebhookStatus } from '../domain/policy'

export interface InboxEvent {
  id: string
  provider: 'asaas' | 'stripe' | 'fake'
  eventId: string
  type: string
  rawType: string
  providerPaymentId: string | null
  splitId: string | null
}

export interface EventStatus {
  status: WebhookStatus
  attempts: number
}

export function pgCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } } | null
  return e?.cause?.code ?? e?.code
}

/** Grava o evento. `inserted = false` quando `(provider, event_id)` já existia (reentrega): devolve o id existente. */
export async function insertEvent(
  db: Db,
  row: typeof schema.webhookEvents.$inferInsert,
): Promise<{ id: string; inserted: boolean }> {
  const created = await db
    .insert(schema.webhookEvents)
    .values(row)
    .onConflictDoNothing({ target: [schema.webhookEvents.provider, schema.webhookEvents.eventId] })
    .returning({ id: schema.webhookEvents.id })
  if (created[0]) return { id: created[0].id, inserted: true }
  const [existing] = await db
    .select({ id: schema.webhookEvents.id })
    .from(schema.webhookEvents)
    .where(
      sql`${schema.webhookEvents.provider} = ${row.provider} and ${schema.webhookEvents.eventId} = ${row.eventId}`,
    )
  return { id: existing!.id, inserted: false }
}

export async function findEvent(db: Db, id: string) {
  const [row] = await db.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.id, id))
  return row
}

export async function readStatus(db: Db, id: string): Promise<EventStatus | undefined> {
  const rows = await db.execute<{ status: WebhookStatus; attempts: number }>(
    sql`select status, attempts from public.webhook_event_status where id = ${id}::uuid`,
  )
  return rows[0]
}

export async function insertRun(
  db: Db,
  id: string,
  outcome: 'processed' | 'ignored' | 'failed' | 'dead' | 'requeued',
  error?: string,
): Promise<void> {
  await db.insert(schema.webhookEventRuns).values({ webhookEventId: id, outcome, error: error ?? null })
}

/** Eventos parados em `received` há mais que `graceSeconds` (a varredura de 5 minutos reenfileira). */
export async function findStuckReceived(db: Db, graceSeconds: number, limit: number): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(
    sql`select id from public.webhook_event_status
      where status = 'received' and coalesce(last_run_at, received_at) < now() - make_interval(secs => ${graceSeconds})
      order by received_at limit ${limit}`,
  )
  return rows.map((r) => r.id)
}

/** Trilha de auditoria do reprocesso manual (única porta de escrita no audit_log para o servidor). */
export async function writeAudit(
  db: Db,
  actorId: string,
  action: string,
  entityId: string,
  diff: Record<string, unknown>,
): Promise<void> {
  await db.execute(
    sql`select public.write_audit(${actorId}::uuid, ${action}, 'webhook_event', ${entityId}, ${JSON.stringify(diff)}::jsonb)`,
  )
}

export async function advisoryLock(db: Db, key: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`)
}
