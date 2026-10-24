import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm'
import { withService, withUser, schema, type UserClaims } from '@/lib/db'
import type { DevStatus } from '../domain/dev-status'
import type { KycState } from '../domain/recipient-gateway'

export interface DevProfile {
  userId: string
  slug: string
  displayName: string
  bio: string
  portfolioLinks: string[]
  status: DevStatus
  kycStatus: KycState
  providerAccountId: string | null
  walletId: string | null
  kycLink: string | null
  escrowEnabledAt: Date | null
  kycCheckedAt: Date | null
  createdAt: Date
}

export interface CurationRow extends DevProfile {
  email: string
}

type Row = typeof schema.devProfiles.$inferSelect

function toProfile(r: Row): DevProfile {
  return {
    userId: r.userId,
    slug: r.slug,
    displayName: r.displayName,
    bio: r.bio,
    portfolioLinks: Array.isArray(r.portfolioLinks) ? (r.portfolioLinks as string[]) : [],
    status: r.status,
    kycStatus: r.kycStatus,
    providerAccountId: r.providerAccountId,
    walletId: r.walletId,
    kycLink: r.kycLink,
    escrowEnabledAt: r.escrowEnabledAt,
    kycCheckedAt: r.kycCheckedAt,
    createdAt: r.createdAt,
  }
}

/** Código SQLSTATE do erro do Postgres (o Drizzle embrulha na `cause`). */
export function pgCode(e: unknown): string | undefined {
  const err = e as { code?: string; cause?: { code?: string } }
  return err?.cause?.code ?? err?.code
}

/** Lê o perfil do próprio dev com a RLS ligada. */
export async function findOwnProfile(claims: UserClaims): Promise<DevProfile | null> {
  return withUser(claims, async (db) => {
    const [row] = await db
      .select()
      .from(schema.devProfiles)
      .where(eq(schema.devProfiles.userId, claims.sub))
      .limit(1)
    return row ? toProfile(row) : null
  })
}

/** O INSERT lista só as colunas com GRANT (o Drizzle incluiria todas e o Postgres recusaria). */
export async function insertOwnProfile(
  claims: UserClaims,
  v: { slug: string; displayName: string; bio: string; portfolioLinks: string[] },
): Promise<void> {
  await withUser(claims, (db) =>
    db.execute(sql`insert into dev_profiles (user_id, slug, display_name, bio, portfolio_links)
      values (${claims.sub}, ${v.slug}, ${v.displayName}, ${v.bio}, ${JSON.stringify(v.portfolioLinks)}::jsonb)`),
  )
}

export async function updateOwnProfile(
  claims: UserClaims,
  v: { displayName: string; bio: string; portfolioLinks: string[] },
): Promise<boolean> {
  const rows = await withUser(claims, (db) =>
    db
      .update(schema.devProfiles)
      .set({ displayName: v.displayName, bio: v.bio, portfolioLinks: v.portfolioLinks })
      .where(eq(schema.devProfiles.userId, claims.sub))
      .returning({ id: schema.devProfiles.userId }),
  )
  return rows.length > 0
}

/** Servidor: lê qualquer perfil (casos de uso que já checaram a posse). */
export async function findProfileAsService(devId: string): Promise<DevProfile | null> {
  return withService(async (db) => {
    const [row] = await db
      .select()
      .from(schema.devProfiles)
      .where(eq(schema.devProfiles.userId, devId))
      .limit(1)
    return row ? toProfile(row) : null
  })
}

/**
 * Reserva o início do KYC de forma atômica (duas requisições não criam duas subcontas). Também
 * retoma uma reserva abandonada: pendente, sem subconta e parada há mais de 2 minutos.
 */
export async function claimKycStart(devId: string): Promise<boolean> {
  const rows = await withService((db) =>
    db
      .update(schema.devProfiles)
      .set({ kycStatus: 'pending' })
      .where(
        and(
          eq(schema.devProfiles.userId, devId),
          or(
            eq(schema.devProfiles.kycStatus, 'not_started'),
            and(
              eq(schema.devProfiles.kycStatus, 'pending'),
              isNull(schema.devProfiles.providerAccountId),
              lt(schema.devProfiles.updatedAt, sql`now() - interval '2 minutes'`),
            ),
          ),
        ),
      )
      .returning({ id: schema.devProfiles.userId }),
  )
  return rows.length > 0
}

export async function releaseKycClaim(devId: string): Promise<void> {
  await withService((db) =>
    db
      .update(schema.devProfiles)
      .set({ kycStatus: 'not_started' })
      .where(and(eq(schema.devProfiles.userId, devId), isNull(schema.devProfiles.providerAccountId))),
  )
}

export async function saveRecipient(
  devId: string,
  v: { accountId: string; walletId: string; onboardingUrl: string | null },
): Promise<void> {
  await withService((db) =>
    db
      .update(schema.devProfiles)
      .set({
        providerAccountId: v.accountId,
        walletId: v.walletId,
        kycLink: v.onboardingUrl,
        kycStatus: 'pending',
      })
      .where(eq(schema.devProfiles.userId, devId)),
  )
}

/** Reserva a consulta de KYC respeitando o intervalo mínimo; false = ainda no intervalo. */
export async function claimKycRefresh(devId: string, minSeconds: number): Promise<boolean> {
  const rows = await withService((db) =>
    db
      .update(schema.devProfiles)
      .set({ kycCheckedAt: sql`now()` })
      .where(
        and(
          eq(schema.devProfiles.userId, devId),
          or(
            isNull(schema.devProfiles.kycCheckedAt),
            lt(schema.devProfiles.kycCheckedAt, sql`now() - make_interval(secs => ${minSeconds})`),
          ),
        ),
      )
      .returning({ id: schema.devProfiles.userId }),
  )
  return rows.length > 0
}

export async function saveKycStatus(
  devId: string,
  v: { kycStatus: KycState; kycLink: string | null },
): Promise<void> {
  await withService((db) =>
    db
      .update(schema.devProfiles)
      .set({ kycStatus: v.kycStatus, kycLink: v.kycLink })
      .where(eq(schema.devProfiles.userId, devId)),
  )
}

export async function markEscrowEnabled(devId: string): Promise<void> {
  await withService((db) =>
    db
      .update(schema.devProfiles)
      .set({ escrowEnabledAt: new Date() })
      .where(and(eq(schema.devProfiles.userId, devId), isNull(schema.devProfiles.escrowEnabledAt))),
  )
}

/** Fila da curadoria: lida com a RLS do admin (aal2). */
export async function listForCuration(
  claims: UserClaims,
  status?: DevStatus,
): Promise<CurationRow[]> {
  return withUser(claims, async (db) => {
    const rows = await db
      .select({ p: schema.devProfiles, email: schema.users.email })
      .from(schema.devProfiles)
      .innerJoin(schema.users, eq(schema.users.id, schema.devProfiles.userId))
      .where(status ? eq(schema.devProfiles.status, status) : undefined)
      .orderBy(desc(schema.devProfiles.createdAt))
      .limit(200)
    return rows.map((r) => ({ ...toProfile(r.p), email: r.email }))
  })
}

export async function setDevStatus(
  claims: UserClaims,
  devId: string,
  status: DevStatus,
  reason: string,
): Promise<void> {
  await withUser(claims, (db) =>
    db.execute(sql`select admin_set_dev_status(${devId}, ${status}::dev_status, ${reason})`),
  )
}
