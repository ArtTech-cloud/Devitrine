import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { withService, withUser, schema, type UserClaims } from '@/lib/db'
import type { PackageStatus, Tier, TierInput } from '../domain/tiers'

export interface TierRow {
  tier: Tier
  priceCents: bigint
  deliveryDays: number
  revisions: number
  scopeMd: string
}

export interface PackageRow {
  id: string
  devId: string
  categoryId: string
  slug: string
  title: string
  summary: string
  descriptionMd: string
  status: PackageStatus
  rejectReason: string | null
  publishedAt: Date | null
  updatedAt: Date
  tiers: TierRow[]
}

export interface CurationEvent {
  fromStatus: PackageStatus
  toStatus: PackageStatus
  reason: string | null
  createdAt: Date
}

export interface Category {
  id: string
  slug: string
  name: string
}

/** Mensagem do Postgres (o Drizzle embrulha o erro original na `cause`). */
export function pgMessage(e: unknown): string {
  const err = e as { message?: string; cause?: { message?: string } }
  return err?.cause?.message ?? err?.message ?? ''
}

export function pgCode(e: unknown): string | undefined {
  const err = e as { code?: string; cause?: { code?: string } }
  return err?.cause?.code ?? err?.code
}

type Db = Parameters<Parameters<typeof withUser>[1]>[0]

async function attachTiers(db: Db, pkgs: (typeof schema.packages.$inferSelect)[]): Promise<PackageRow[]> {
  if (pkgs.length === 0) return []
  const tiers = await db
    .select()
    .from(schema.packageTiers)
    .where(inArray(schema.packageTiers.packageId, pkgs.map((p) => p.id)))
    .orderBy(asc(schema.packageTiers.tier))
  return pkgs.map((p) => ({
    id: p.id,
    devId: p.devId,
    categoryId: p.categoryId,
    slug: p.slug,
    title: p.title,
    summary: p.summary,
    descriptionMd: p.descriptionMd,
    status: p.status,
    rejectReason: p.rejectReason,
    publishedAt: p.publishedAt,
    updatedAt: p.updatedAt,
    tiers: tiers
      .filter((t) => t.packageId === p.id)
      .map((t) => ({
        tier: t.tier,
        priceCents: t.priceCents,
        deliveryDays: t.deliveryDays,
        revisions: t.revisions,
        scopeMd: t.scopeMd,
      })),
  }))
}

export async function listCategories(): Promise<Category[]> {
  return withService((db) =>
    db
      .select({ id: schema.categories.id, slug: schema.categories.slug, name: schema.categories.name })
      .from(schema.categories)
      .where(eq(schema.categories.active, true))
      .orderBy(asc(schema.categories.name)),
  )
}

export async function listOwnPackages(claims: UserClaims): Promise<PackageRow[]> {
  return withUser(claims, async (db) => {
    const rows = await db
      .select()
      .from(schema.packages)
      .where(eq(schema.packages.devId, claims.sub))
      .orderBy(desc(schema.packages.updatedAt))
    return attachTiers(db, rows)
  })
}

/** A RLS só devolve pacote do próprio dev: id alheio é "não encontrado" (IDOR). */
export async function findOwnPackage(claims: UserClaims, id: string): Promise<PackageRow | null> {
  return withUser(claims, async (db) => {
    const rows = await db
      .select()
      .from(schema.packages)
      .where(and(eq(schema.packages.id, id), eq(schema.packages.devId, claims.sub)))
      .limit(1)
    return (await attachTiers(db, rows))[0] ?? null
  })
}

export async function listCurationEvents(claims: UserClaims, packageId: string): Promise<CurationEvent[]> {
  return withUser(claims, (db) =>
    db
      .select({
        fromStatus: schema.packageCurationEvents.fromStatus,
        toStatus: schema.packageCurationEvents.toStatus,
        reason: schema.packageCurationEvents.reason,
        createdAt: schema.packageCurationEvents.createdAt,
      })
      .from(schema.packageCurationEvents)
      .where(eq(schema.packageCurationEvents.packageId, packageId))
      .orderBy(desc(schema.packageCurationEvents.createdAt)),
  )
}

/** Fila do admin (RLS: só admin com aal2 lê pacotes alheios). */
export async function listPackagesForCuration(
  claims: UserClaims,
  status: PackageStatus = 'in_review',
): Promise<PackageRow[]> {
  return withUser(claims, async (db) => {
    const rows = await db
      .select()
      .from(schema.packages)
      .where(eq(schema.packages.status, status))
      .orderBy(asc(schema.packages.updatedAt))
      .limit(200)
    return attachTiers(db, rows)
  })
}

export async function findPackageAsService(id: string): Promise<{ id: string; devId: string; status: PackageStatus } | null> {
  return withService(async (db) => {
    const [row] = await db
      .select({ id: schema.packages.id, devId: schema.packages.devId, status: schema.packages.status })
      .from(schema.packages)
      .where(eq(schema.packages.id, id))
      .limit(1)
    return row ?? null
  })
}

export interface PackageFields {
  categoryId: string
  title: string
  summary: string
  descriptionMd: string
}

async function writeTiers(db: Db, packageId: string, tiers: TierInput[]): Promise<void> {
  const keep = tiers.map((t) => t.tier)
  await db.execute(
    sql`delete from package_tiers where package_id = ${packageId} and tier <> all (${sql.raw(
      `array[${keep.map((t) => `'${t}'`).join(',')}]::package_tier[]`,
    )})`,
  )
  for (const t of tiers) {
    await db.execute(sql`insert into package_tiers (package_id, tier, price_cents, delivery_days, revisions, scope_md)
      values (${packageId}, ${t.tier}::package_tier, ${t.priceCents.toString()}::bigint, ${t.deliveryDays}, ${t.revisions}, ${t.scopeMd})
      on conflict (package_id, tier) do update set price_cents = excluded.price_cents,
        delivery_days = excluded.delivery_days, revisions = excluded.revisions, scope_md = excluded.scope_md`)
  }
}

/** Os INSERTs listam só as colunas com GRANT (o Drizzle incluiria todas e o Postgres recusaria). */
export async function insertPackage(
  claims: UserClaims,
  id: string,
  slug: string,
  f: PackageFields,
  tiers: TierInput[],
): Promise<void> {
  await withUser(claims, async (db) => {
    await db.execute(sql`insert into packages (id, dev_id, category_id, slug, title, summary, description_md)
      values (${id}, ${claims.sub}, ${f.categoryId}, ${slug}, ${f.title}, ${f.summary}, ${f.descriptionMd})`)
    await writeTiers(db, id, tiers)
  })
}

/**
 * Edita o pacote do dono. Pacote fora de rascunho volta a rascunho na mesma transação (sai da
 * vitrine até nova aprovação). Devolve false se o pacote não é do dev.
 */
export async function updatePackage(
  claims: UserClaims,
  id: string,
  f: PackageFields,
  tiers: TierInput[],
): Promise<boolean> {
  return withUser(claims, async (db) => {
    const [cur] = await db
      .select({ status: schema.packages.status })
      .from(schema.packages)
      .where(and(eq(schema.packages.id, id), eq(schema.packages.devId, claims.sub)))
    // Sem FOR UPDATE: a política de UPDATE só vale para rascunho; quem trava a linha é catalog_withdraw_package.
    if (!cur) return false
    if (cur.status !== 'draft') await db.execute(sql`select catalog_withdraw_package(${id})`)
    const updated = await db
      .update(schema.packages)
      .set({ categoryId: f.categoryId, title: f.title, summary: f.summary, descriptionMd: f.descriptionMd })
      .where(eq(schema.packages.id, id))
      .returning({ id: schema.packages.id })
    // Dev suspenso: a RLS não deixa editar; desfaz também o retorno a rascunho.
    if (updated.length === 0) throw new Error('package_not_found')
    await writeTiers(db, id, tiers)
    return true
  })
}

export type PackageAction = 'submit' | 'withdraw' | 'pause' | 'resume' | 'approve'

const FUNCTION_OF: Record<PackageAction, ReturnType<typeof sql>> = {
  submit: sql`catalog_submit_package`,
  withdraw: sql`catalog_withdraw_package`,
  pause: sql`catalog_pause_package`,
  resume: sql`catalog_resume_package`,
  approve: sql`admin_approve_package`,
}

export async function runPackageAction(claims: UserClaims, id: string, action: PackageAction): Promise<void> {
  await withUser(claims, (db) => db.execute(sql`select ${FUNCTION_OF[action]}(${id})`))
}

export async function rejectPackage(claims: UserClaims, id: string, reason: string): Promise<void> {
  await withUser(claims, (db) => db.execute(sql`select admin_reject_package(${id}, ${reason})`))
}
