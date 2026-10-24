import { redirect } from 'next/navigation'
import { MfaForm } from '@/components/mfa-form'
import { enrollTotp, getCurrentUser, verifyTotpAction } from '@/modules/accounts'

export const dynamic = 'force-dynamic'

export default async function AdminMfaPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (user.role !== 'admin') redirect('/app')
  if (user.aal === 'aal2') redirect('/admin')
  const enrollment = await enrollTotp()
  if (!enrollment) redirect('/login')
  return <MfaForm {...enrollment} action={verifyTotpAction} />
}
