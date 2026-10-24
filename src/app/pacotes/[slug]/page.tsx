import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Card, CardTitle } from '@/components/ui/card'
import { formatBRL } from '@/lib/money'
import { absoluteUrl, jsonLd, priceForSchema } from '@/lib/seo'
import { TIER_LABEL, getPublicPackage } from '@/modules/catalog'

export const dynamic = 'force-dynamic'

const SLUG = /^[a-z0-9-]{1,100}$/

async function load(slug: string) {
  return SLUG.test(slug) ? getPublicPackage(slug) : null
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const pkg = await load((await params).slug)
  if (!pkg) return { title: 'Pacote não encontrado', robots: { index: false, follow: false } }
  const url = absoluteUrl(`/pacotes/${pkg.slug}`)
  return {
    title: pkg.title,
    description: pkg.summary,
    alternates: { canonical: url },
    openGraph: { type: 'website', title: pkg.title, description: pkg.summary, url, locale: 'pt_BR' },
  }
}

export default async function PackagePage({ params }: { params: Promise<{ slug: string }> }) {
  const pkg = await load((await params).slug)
  if (!pkg) notFound()
  const url = absoluteUrl(`/pacotes/${pkg.slug}`)
  const prices = pkg.tiers.map((t) => t.priceCents)
  const low = prices.reduce((a, b) => (b < a ? b : a))
  const high = prices.reduce((a, b) => (b > a ? b : a))
  const structured = {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name: pkg.title,
    description: pkg.summary,
    url,
    serviceType: pkg.categoryName,
    areaServed: { '@type': 'Country', name: 'BR' },
    provider: { '@type': 'Person', name: pkg.devName, url: absoluteUrl(`/devs/${pkg.devSlug}`) },
    offers: {
      '@type': 'AggregateOffer',
      priceCurrency: 'BRL',
      lowPrice: priceForSchema(low),
      highPrice: priceForSchema(high),
      offerCount: pkg.tiers.length,
      offers: pkg.tiers.map((t) => ({
        '@type': 'Offer',
        name: TIER_LABEL[t.tier],
        price: priceForSchema(t.priceCents),
        priceCurrency: 'BRL',
        url,
      })),
    },
  }
  return (
    <article className="space-y-4">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(structured) }} />
      <div className="space-y-2">
        <CardTitle>{pkg.title}</CardTitle>
        <p className="text-muted-foreground">{pkg.summary}</p>
        <p className="text-sm">
          <Badge>{pkg.categoryName}</Badge> por{' '}
          <Link href={`/devs/${pkg.devSlug}`} className="underline">
            {pkg.devName}
          </Link>
        </p>
      </div>
      {pkg.descriptionMd && <p className="whitespace-pre-line text-sm">{pkg.descriptionMd}</p>}
      <section aria-label="Níveis do pacote" className="grid gap-4 sm:grid-cols-3">
        {pkg.tiers.map((t) => (
          <Card key={t.tier} className="space-y-2" data-testid={`public-tier-${t.tier}`}>
            <h2 className="text-lg font-semibold">{TIER_LABEL[t.tier]}</h2>
            <p className="text-xl">{formatBRL(t.priceCents)}</p>
            <p className="text-sm text-muted-foreground">
              {t.deliveryDays} {t.deliveryDays === 1 ? 'dia' : 'dias'} · {t.revisions}{' '}
              {t.revisions === 1 ? 'revisão' : 'revisões'}
            </p>
            <p className="whitespace-pre-line text-sm">{t.scopeMd}</p>
          </Card>
        ))}
      </section>
    </article>
  )
}
