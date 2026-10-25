'use server'

import { revalidatePath } from 'next/cache'
import { getRecipientGateway } from '@/lib/composition'
import { requireRole } from './current-user'
import { curationDecisionSchema, devProfileSchema, kycSchema } from './schemas-dev'
import { decideDev, refreshKyc, saveDevProfile, startKyc } from './dev-service'
import type { FormState } from './auth-actions'

const firstIssue = (e: { issues: { message: string }[] }) => e.issues[0]?.message ?? 'Dados inválidos'

export async function saveDevProfileAction(_: FormState, formData: FormData): Promise<FormState> {
  const user = await requireRole('dev')
  const parsed = devProfileSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: firstIssue(parsed.error) }
  const res = await saveDevProfile(user, parsed.data)
  if (!res.ok) return { error: res.error }
  revalidatePath('/app/dev')
  if (res.value.sentToReview) {
    return { info: 'Perfil salvo. Como o nome mudou, seu perfil e seus pacotes saem da vitrine até nova análise.' }
  }
  return { info: 'Perfil salvo.' }
}

export async function startKycAction(_: FormState, formData: FormData): Promise<FormState> {
  const user = await requireRole('dev')
  const parsed = kycSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: firstIssue(parsed.error) }
  const res = await startKyc(user, parsed.data, getRecipientGateway())
  if (!res.ok) return { error: res.error }
  revalidatePath('/app/dev')
  return { info: 'Verificação iniciada.' }
}

export async function refreshKycAction(): Promise<FormState> {
  const user = await requireRole('dev')
  const res = await refreshKyc(user, getRecipientGateway())
  if (!res.ok) return { error: res.error }
  revalidatePath('/app/dev')
  return { info: 'Status atualizado.' }
}

export async function decideDevAction(_: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireRole('admin')
  const parsed = curationDecisionSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: firstIssue(parsed.error) }
  const res = await decideDev(admin, parsed.data.devId, parsed.data.status, parsed.data.reason, getRecipientGateway())
  if (!res.ok) return { error: res.error }
  revalidatePath('/admin/curadoria')
  return { info: parsed.data.status === 'approved' ? 'Dev aprovado.' : 'Dev suspenso.' }
}

export async function listCurationQueue(status?: 'pending' | 'approved' | 'suspended') {
  const admin = await requireRole('admin')
  const { listForCuration } = await import('../infra/dev-profiles-repository')
  return listForCuration({ sub: admin.id, aal: admin.aal }, status)
}

export async function getOwnDevProfile() {
  const user = await requireRole('dev')
  const { findOwnProfile } = await import('../infra/dev-profiles-repository')
  return findOwnProfile({ sub: user.id, aal: user.aal })
}
