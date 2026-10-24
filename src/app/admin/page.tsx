import { AreaShell } from '@/components/area-shell'
import { requireRole } from '@/modules/accounts'

export const dynamic = 'force-dynamic'

export default async function AdminArea() {
  const user = await requireRole('admin')
  return <AreaShell title="Painel admin" email={user.email} role={user.role} />
}
