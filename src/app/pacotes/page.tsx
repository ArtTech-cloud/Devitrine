import type { Metadata } from 'next'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Card, CardTitle } from '@/components/ui/card'
import { formatBRL } from '@/lib/money'
import { absoluteUrl } from '@/lib/seo'
import { getPublicCategories, getPublicPackages, lowestPriceCents } from '@/modules/catalog'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Pacotes de serviços digitais',
  description: 'Pacotes fechados de devs independentes, com preço, prazo e revisões definidos e pagamento em custódia.',
  alternates: { canonical: absoluteUrl('/pacotes') },
}

export default async function PackagesIndex({ searchParams }: { searchParams: Promise<{ categoria?: string }> }) {
  const { categoria } = await searchParams
  const categorySlug = typeof categoria === 'string' && /^[a-z0-9-]{1,80}$/.test(categoria) ? categoria : undefined
  const [packages, categories] = await Promise.all([getPublicPackages(categorySlug), getPublicCategories()])
  return (
    <div className="space-y-4">
      <CardTitle>Pacotes de serviços digitais</CardTitle>
      {categories.length > 0 && (
        <nav aria-label="Categorias" className="flex flex-wrap gap-3 text-sm">
          <Link href="/pacotes" className={categorySlug ? 'underline' : 'font-medium'}>
            Todas
          </Link>
          {categories.map((c) => (
            <Link
              key={c.slug}
              href={`/pacotes?categoria=${c.slug}`}
              className={categorySlug === c.slug ? 'font-medium' : 'underline'}
            >
              {c.name}
            </Link>
          ))}
        </nav>
      )}
      {packages.length === 0 && <p className="text-sm text-muted-foreground">Nenhum pacote publicado ainda.</p>}
      {packages.map((p) => {
        const from = lowestPriceCents(p.tiers)
        return (
          <Card key={p.id} className="space-y-1" data-testid="public-package">
            <Link href={`/pacotes/${p.slug}`} className="text-lg font-medium underline">
              {p.title}
            </Link>
            <p className="text-sm">{p.summary}</p>
            <p className="text-sm text-muted-foreground">
              <Badge>{p.categoryName}</Badge> por {p.devName}
              {from !== null && <> · a partir de {formatBRL(from)}</>}
            </p>
          </Card>
        )
      })}
    </div>
  )
}
