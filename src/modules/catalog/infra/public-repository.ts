import { sql } from 'drizzle-orm'
import { withService } from '@/lib/db'
import type { Tier } from '../domain/tiers'

export interface PublicTier {
  tier: Tier
  priceCents: bigint
  deliveryDays: number
  revisions: number
  scopeMd: string
}

export interface PublicPackage {
  id: string
  slug: string
  title: string
  summary: string
  descriptionMd: string
  publishedAt: Date
  categorySlug: string
  categoryName: string
  devId: string
  devSlug: string
  devName: string
  tiers: PublicTier[]
}

type PkgRow = {
  id: string
  slug: string
  title: string
  summary: string
  description_md: string
  published_at: Date
  category_slug: string
  category_name: string
  dev_id: string
  dev_slug: string
  dev_name: string
}
type TierRow = {
  package_id: string
  tier: Tier
  price_cents: string | bigint
  delivery_days: number
  revisions: number
  scope_md: string
}

const ORDER = { basic: 0, standard: 1, premium: 2 } as const

/** Lê só as views públicas (vitrine do ADR-013); rascunho, análise e dev suspenso nunca aparecem. */
async function load(where: ReturnType<typeof sql>, limit = 100): Promise<PublicPackage[]> {
  return withService(async (db) => {
    const pkgs = (await db.execute(
      sql`select * from public_packages ${where} order by published_at desc, id limit ${limit}`,
    )) as unknown as PkgRow[]
    if (pkgs.length === 0) return []
    const ids = sql.join(pkgs.map((p) => sql`${p.id}::uuid`), sql`, `)
    const tiers = (await db.execute(
      sql`select * from public_package_tiers where package_id in (${ids})`,
    )) as unknown as TierRow[]
    return pkgs.map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      summary: p.summary,
      descriptionMd: p.description_md,
      publishedAt: new Date(p.published_at),
      categorySlug: p.category_slug,
      categoryName: p.category_name,
      devId: p.dev_id,
      devSlug: p.dev_slug,
      devName: p.dev_name,
      tiers: tiers
        .filter((t) => t.package_id === p.id)
        .map((t) => ({
          tier: t.tier,
          priceCents: BigInt(t.price_cents),
          deliveryDays: t.delivery_days,
          revisions: t.revisions,
          scopeMd: t.scope_md,
        }))
        .sort((a, b) => ORDER[a.tier] - ORDER[b.tier]),
    }))
  })
}

export const listPublicPackages = (categorySlug?: string) =>
  load(categorySlug ? sql`where category_slug = ${categorySlug}` : sql``)

export async function findPublicPackage(slug: string): Promise<PublicPackage | null> {
  return (await load(sql`where slug = ${slug}`, 1))[0] ?? null
}

export const listPublicPackagesByDev = (devId: string) => load(sql`where dev_id = ${devId}::uuid`)

export async function listPublicCategories(): Promise<{ slug: string; name: string }[]> {
  const rows = await withService((db) =>
    db.execute(sql`select distinct category_slug as slug, category_name as name from public_packages order by 2`),
  )
  return rows as unknown as { slug: string; name: string }[]
}

/** Para o sitemap: slug e data de publicação de cada pacote visível. */
export async function listPublicPackageSlugs(): Promise<{ slug: string; publishedAt: Date }[]> {
  const rows = await withService((db) =>
    db.execute(sql`select slug, published_at from public_packages order by published_at desc limit 5000`),
  )
  return (rows as unknown as { slug: string; published_at: Date }[]).map((r) => ({
    slug: r.slug,
    publishedAt: new Date(r.published_at),
  }))
}
