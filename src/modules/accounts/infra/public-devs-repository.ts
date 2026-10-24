import { sql } from 'drizzle-orm'
import { withService } from '@/lib/db'

export interface PublicDev {
  id: string
  slug: string
  displayName: string
  bio: string
  portfolioLinks: string[]
}

/** Lê só a view `public_dev_profiles` (dev aprovado com KYC aprovado); nunca a tabela. */
export async function findPublicDevBySlug(slug: string): Promise<PublicDev | null> {
  const rows = await withService((db) =>
    db.execute(sql`select id, slug, display_name, bio, portfolio_links from public_dev_profiles where slug = ${slug} limit 1`),
  )
  const r = rows[0] as
    | { id: string; slug: string; display_name: string; bio: string; portfolio_links: string[] | null }
    | undefined
  if (!r) return null
  return { id: r.id, slug: r.slug, displayName: r.display_name, bio: r.bio, portfolioLinks: r.portfolio_links ?? [] }
}

export async function listPublicDevSlugs(): Promise<string[]> {
  const rows = await withService((db) => db.execute(sql`select slug from public_dev_profiles order by slug`))
  return rows.map((r) => (r as { slug: string }).slug)
}
