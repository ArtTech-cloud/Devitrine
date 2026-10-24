import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Card, CardTitle } from '@/components/ui/card'
import { formatBRL } from '@/lib/money'
import { absoluteUrl, jsonLd } from '@/lib/seo'
import { getPublicDev } from '@/modules/accounts'
import { getPublicPackagesByDev, lowestPriceCents } from '@/modules/catalog'

export const dynamic = 'force-dynamic'

const SLUG = /^[a-z0-9-]{1,100}$/

const load = async (slug: string) => (SLUG.test(slug) ? getPublicDev(slug) : null)

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const dev = await load((await params).slug)
  if (!dev) return { title: 'Dev não encontrado', robots: { index: false, follow: false } }
  const description = dev.bio.slice(0, 160) || `Pacotes de ${dev.displayName}`
  return {
    title: dev.displayName,
    description,
    alternates: { canonical: absoluteUrl(`/devs/${dev.slug}`) },
  }
}

export default async function DevPublicPage({ params }: { params: Promise<{ slug: string }> }) {
  const dev = await load((await params).slug)
  if (!dev) notFound()
  const packages = await getPublicPackagesByDev(dev.id)
  const structured = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: dev.displayName,
    url: absoluteUrl(`/devs/${dev.slug}`),
    description: dev.bio || undefined,
    sameAs: dev.portfolioLinks,
  }
  return (
    <div className="space-y-4">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(structured) }} />
      <CardTitle>{dev.displayName}</CardTitle>
      {dev.bio && <p className="whitespace-pre-line text-sm">{dev.bio}</p>}
      {dev.portfolioLinks.length > 0 && (
        <ul className="list-disc pl-5 text-sm">
          {dev.portfolioLinks.map((l) => (
            <li key={l}>
              <a href={l} className="underline" target="_blank" rel="noreferrer noopener nofollow ugc">
                {l}
              </a>
            </li>
          ))}
        </ul>
      )}
      <h2 className="text-xl font-semibold">Pacotes</h2>
      {packages.length === 0 && <p className="text-sm text-muted-foreground">Nenhum pacote publicado.</p>}
      {packages.map((p) => {
        const from = lowestPriceCents(p.tiers)
        return (
          <Card key={p.id} className="space-y-1">
            <Link href={`/pacotes/${p.slug}`} className="font-medium underline">
              {p.title}
            </Link>
            <p className="text-sm">{p.summary}</p>
            {from !== null && <p className="text-sm text-muted-foreground">a partir de {formatBRL(from)}</p>}
          </Card>
        )
      })}
    </div>
  )
}
