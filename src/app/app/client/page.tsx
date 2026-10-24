import { AreaShell } from '@/components/area-shell'
import { requireRole } from '@/modules/accounts'

export const dynamic = 'force-dynamic'

export default async function ClientArea() {
  const user = await requireRole('client')
  return <AreaShell title="Área do cliente" email={user.email} role={user.role} />
}
