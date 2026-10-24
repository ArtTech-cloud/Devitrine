import { AreaShell } from '@/components/area-shell'
import { requireRole } from '@/modules/accounts'

export const dynamic = 'force-dynamic'

export default async function DevArea() {
  const user = await requireRole('dev')
  return <AreaShell title="Área do dev" email={user.email} role={user.role} />
}
