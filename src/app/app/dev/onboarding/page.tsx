import { ActionButton, DevProfileForm, KycForm } from '@/components/dev-forms'
import { Card, CardTitle } from '@/components/ui/card'
import {
  getOwnDevProfile,
  refreshKycAction,
  requireRole,
  saveDevProfileAction,
  startKycAction,
} from '@/modules/accounts'

export const dynamic = 'force-dynamic'

export default async function DevOnboarding() {
  await requireRole('dev')
  const profile = await getOwnDevProfile()
  return (
    <div className="space-y-4">
      <Card className="space-y-4">
        <CardTitle>Seu perfil</CardTitle>
        <DevProfileForm
          action={saveDevProfileAction}
          defaults={
            profile ? {
              displayName: profile.displayName,
              bio: profile.bio,
              portfolioLinks: profile.portfolioLinks,
            } : undefined
          }
        />
      </Card>
      {profile && (
        <Card className="space-y-4">
          <h2 className="text-xl font-semibold">Verificação de identidade (KYC)</h2>
          {profile.kycStatus === 'not_started' || profile.kycStatus === 'rejected' ? (
            <div className="space-y-4">
              {profile.kycStatus === 'rejected' && (
                <p role="alert" className="text-sm text-destructive">
                  Sua verificação foi recusada. Confira os dados e envie de novo.
                </p>
              )}
              <KycForm action={startKycAction} />
            </div>
          ) : (
            <div className="space-y-2 text-sm">
              <p data-testid="kyc-state">Situação: {profile.kycStatus}</p>
              {profile.kycLink && (
                <a href={profile.kycLink} className="underline" target="_blank" rel="noreferrer">
                  Concluir verificação no gateway
                </a>
              )}
              {profile.kycStatus === 'pending' && (
                <ActionButton action={refreshKycAction} label="Atualizar status" />
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
