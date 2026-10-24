import { notFound } from 'next/navigation'
import { PackageActionButton, PackageForm, type PackageDefaults } from '@/components/package-forms'
import { Badge } from '@/components/ui/badge'
import { Card, CardTitle } from '@/components/ui/card'
import { getNumberSetting } from '@/lib/settings'
import {
  PACKAGE_STATUS_LABEL,
  editPackageAction,
  getCategories,
  getOwnPackage,
  pausePackageAction,
  resumePackageAction,
  submitPackageAction,
  withdrawPackageAction,
} from '@/modules/catalog'
import type { PackageRow } from '@/modules/catalog'

export const dynamic = 'force-dynamic'

const reais = (cents: bigint) => {
  const s = cents.toString().padStart(3, '0')
  return `${s.slice(0, -2)},${s.slice(-2)}`
}

function defaultsOf(p: PackageRow): PackageDefaults {
  return {
    packageId: p.id,
    categoryId: p.categoryId,
    title: p.title,
    summary: p.summary,
    descriptionMd: p.descriptionMd,
    tiers: Object.fromEntries(
      p.tiers.map((t) => [
        t.tier,
        { price: reais(t.priceCents), days: String(t.deliveryDays), revisions: String(t.revisions), scope: t.scopeMd },
      ]),
    ),
  }
}

export default async function EditPackagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const [found, categories, feeBps] = await Promise.all([
    getOwnPackage(id),
    getCategories(),
    getNumberSetting('platform_fee_bps_first_order'),
  ])
  if (!found) notFound()
  const { pkg, history } = found
  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <CardTitle>{pkg.title}</CardTitle>
        <p className="text-sm">
          Status <Badge data-testid="package-status">{PACKAGE_STATUS_LABEL[pkg.status]}</Badge>
        </p>
        {pkg.rejectReason && pkg.status === 'draft' && (
          <p role="alert" className="text-sm text-destructive">
            Devolvido pela curadoria: {pkg.rejectReason}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {pkg.status === 'draft' && (
            <PackageActionButton action={submitPackageAction} packageId={pkg.id} label="Enviar para análise" variant="default" />
          )}
          {pkg.status === 'in_review' && (
            <PackageActionButton action={withdrawPackageAction} packageId={pkg.id} label="Voltar para rascunho" />
          )}
          {pkg.status === 'published' && (
            <PackageActionButton action={pausePackageAction} packageId={pkg.id} label="Pausar" />
          )}
          {pkg.status === 'paused' && (
            <PackageActionButton action={resumePackageAction} packageId={pkg.id} label="Voltar ao ar" />
          )}
        </div>
        {pkg.status !== 'draft' && (
          <p className="text-xs text-muted-foreground">
            Editar um pacote que não é rascunho o devolve a rascunho: ele sai do ar até nova aprovação.
          </p>
        )}
      </Card>
      <Card className="space-y-4">
        <h2 className="text-xl font-semibold">Editar</h2>
        <PackageForm
          action={editPackageAction}
          categories={categories}
          defaults={defaultsOf(pkg)}
          feeBps={feeBps}
          submitLabel="Salvar"
        />
      </Card>
      {history.length > 0 && (
        <Card className="space-y-2">
          <h2 className="text-xl font-semibold">Histórico</h2>
          <ul className="space-y-1 text-sm">
            {history.map((h) => (
              <li key={h.createdAt.toISOString()}>
                {h.createdAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}:{' '}
                {PACKAGE_STATUS_LABEL[h.fromStatus]} → {PACKAGE_STATUS_LABEL[h.toStatus]}
                {h.reason ? ` (${h.reason})` : ''}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
