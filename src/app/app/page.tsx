import { redirect } from 'next/navigation'
import { getCurrentUser, homePathFor } from '@/modules/accounts'

export const dynamic = 'force-dynamic'

export default async function AppIndex() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  redirect(user.role === 'admin' && user.aal !== 'aal2' ? '/admin/mfa' : homePathFor(user.role))
}
