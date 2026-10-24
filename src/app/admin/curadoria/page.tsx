import { DecisionForm } from '@/components/dev-forms'
import { Badge } from '@/components/ui/badge'
import { Card, CardTitle } from '@/components/ui/card'
import { decideDevAction, listCurationQueue, requireRole } from '@/modules/accounts'

export const dynamic = 'force-dynamic'

export default async function CurationPage() {
  await requireRole('admin')
  const devs = await listCurationQueue()
  return (
    <div className="space-y-4">
      <CardTitle>Curadoria de devs</CardTitle>
      {devs.length === 0 && <p className="text-sm text-muted-foreground">Nenhum dev cadastrado.</p>}
      {devs.map((d) => (
        <Card key={d.userId} className="space-y-2" data-testid="curation-row">
          <p className="font-medium">
            {d.displayName} <span className="text-sm text-muted-foreground">({d.email})</span>
          </p>
          <p className="text-sm">
            <Badge>{d.status}</Badge> KYC <Badge>{d.kycStatus}</Badge>
          </p>
          {d.bio && <p className="whitespace-pre-line text-sm">{d.bio}</p>}
          {d.portfolioLinks.length > 0 && (
            <ul className="list-disc pl-5 text-sm">
              {d.portfolioLinks.map((l) => (
                <li key={l}>
                  <a href={l} className="underline" target="_blank" rel="noreferrer noopener">
                    {l}
                  </a>
                </li>
              ))}
            </ul>
          )}
          <DecisionForm
            action={decideDevAction}
            devId={d.userId}
            options={
              d.status === 'approved'
                ? [{ status: 'suspended', label: 'Suspender' }]
                : d.status === 'suspended'
                  ? [{ status: 'approved', label: 'Reativar' }]
                  : [
                      { status: 'approved', label: 'Aprovar' },
                      { status: 'suspended', label: 'Suspender' },
                    ]
            }
          />
        </Card>
      ))}
    </div>
  )
}
