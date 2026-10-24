import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Card, CardTitle } from '@/components/ui/card'
import { formatBRL } from '@/lib/money'
import { PACKAGE_STATUS_LABEL, getOwnPackages, lowestPriceCents } from '@/modules/catalog'

export const dynamic = 'force-dynamic'

export default async function PackagesPage() {
  const packages = await getOwnPackages()
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <CardTitle>Meus pacotes</CardTitle>
        <Link href="/app/dev/pacotes/novo" className="text-sm underline">
          Novo pacote
        </Link>
      </div>
      {packages.length === 0 && <p className="text-sm text-muted-foreground">Você ainda não criou pacotes.</p>}
      {packages.map((p) => {
        const from = lowestPriceCents(p.tiers)
        return (
          <Card key={p.id} className="space-y-1" data-testid="package-row">
            <Link href={`/app/dev/pacotes/${p.id}`} className="font-medium underline">
              {p.title}
            </Link>
            <p className="text-sm">
              <Badge>{PACKAGE_STATUS_LABEL[p.status]}</Badge>
              {from !== null && <span className="ml-2 text-muted-foreground">a partir de {formatBRL(from)}</span>}
            </p>
            {p.rejectReason && p.status === 'draft' && (
              <p className="text-sm text-destructive">Devolvido pela curadoria: {p.rejectReason}</p>
            )}
          </Card>
        )
      })}
    </div>
  )
}
