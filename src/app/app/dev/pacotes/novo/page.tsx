import { Card, CardTitle } from '@/components/ui/card'
import { PackageForm } from '@/components/package-forms'
import { getNumberSetting } from '@/lib/settings'
import { createPackageAction, getCategories } from '@/modules/catalog'

export const dynamic = 'force-dynamic'

export default async function NewPackagePage() {
  const [categories, feeBps] = await Promise.all([getCategories(), getNumberSetting('platform_fee_bps_first_order')])
  return (
    <Card className="space-y-4">
      <CardTitle>Novo pacote</CardTitle>
      <PackageForm action={createPackageAction} categories={categories} feeBps={feeBps} submitLabel="Criar rascunho" />
    </Card>
  )
}
