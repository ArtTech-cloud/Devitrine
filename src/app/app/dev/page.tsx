import Link from 'next/link'
import { AreaShell } from '@/components/area-shell'
import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { getOwnDevProfile, requireRole } from '@/modules/accounts'

export const dynamic = 'force-dynamic'

const DEV_LABEL = { pending: 'Em análise', approved: 'Aprovado', suspended: 'Suspenso' } as const
const KYC_LABEL = {
  not_started: 'Não iniciada',
  pending: 'Em análise',
  approved: 'Aprovada',
  rejected: 'Recusada',
} as const

export default async function DevArea() {
  const user = await requireRole('dev')
  const profile = await getOwnDevProfile()
  return (
    <div className="space-y-4">
      <AreaShell title="Área do dev" email={user.email} role={user.role} />
      <Card className="space-y-2">
        {profile ? (
          <>
            <p className="text-sm">
              Perfil <Badge data-testid="dev-status">{DEV_LABEL[profile.status]}</Badge> · Verificação{' '}
              <Badge data-testid="kyc-status">{KYC_LABEL[profile.kycStatus]}</Badge>
            </p>
            <Link href="/app/dev/onboarding" className="block text-sm underline">
              Editar perfil e verificação
            </Link>
            <Link href="/app/dev/pacotes" className="block text-sm underline">
              Meus pacotes
            </Link>
          </>
        ) : (
          <Link href="/app/dev/onboarding" className="text-sm underline">
            Complete seu perfil para começar a vender
          </Link>
        )}
      </Card>
    </div>
  )
}
