'use server'

import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { ensureDevEscrow, requireRole } from '@/modules/accounts'
import { packageIdSchema, packageSchema, rejectSchema } from './schemas'
import {
  approvePackage,
  createPackage,
  editPackage,
  pausePackage,
  rejectPackageAs,
  resumePackage,
  submitPackage,
  withdrawPackage,
} from './package-service'

type FormState = { error?: string; info?: string; fieldErrors?: Record<string, string> }

const issuesOf = (e: { issues: { message: string; path: PropertyKey[] }[] }): FormState => ({
  error: e.issues[0]?.message ?? 'Dados inválidos',
  fieldErrors: Object.fromEntries(e.issues.map((i) => [String(i.path[0] ?? ''), i.message])),
})

export async function createPackageAction(_: FormState, formData: FormData): Promise<FormState> {
  const user = await requireRole('dev')
  const parsed = packageSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return issuesOf(parsed.error)
  const res = await createPackage(user, parsed.data)
  if (!res.ok) return { error: res.error }
  revalidatePath('/app/dev/pacotes')
  redirect(`/app/dev/pacotes/${res.value.id}`)
}

export async function editPackageAction(_: FormState, formData: FormData): Promise<FormState> {
  const user = await requireRole('dev')
  const id = packageIdSchema.safeParse(Object.fromEntries(formData))
  if (!id.success) return { error: 'Pacote inválido' }
  const parsed = packageSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return issuesOf(parsed.error)
  const res = await editPackage(user, id.data.packageId, parsed.data)
  if (!res.ok) return { error: res.error }
  revalidatePath('/app/dev/pacotes')
  return { info: 'Pacote salvo como rascunho.' }
}

const devTransition =
  (run: typeof submitPackage, info: string) =>
  async (_: FormState, formData: FormData): Promise<FormState> => {
    const user = await requireRole('dev')
    const id = packageIdSchema.safeParse(Object.fromEntries(formData))
    if (!id.success) return { error: 'Pacote inválido' }
    const res = await run(user, id.data.packageId)
    if (!res.ok) return { error: res.error }
    revalidatePath('/app/dev/pacotes')
    return { info }
  }

export const submitPackageAction = devTransition(submitPackage, 'Enviado para análise.')
export const withdrawPackageAction = devTransition(withdrawPackage, 'Pacote voltou para rascunho.')
export const pausePackageAction = devTransition(pausePackage, 'Pacote pausado.')
export const resumePackageAction = devTransition(resumePackage, 'Pacote voltou ao ar.')

export async function approvePackageAction(_: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireRole('admin')
  const id = packageIdSchema.safeParse(Object.fromEntries(formData))
  if (!id.success) return { error: 'Pacote inválido' }
  const res = await approvePackage(admin, id.data.packageId, ensureDevEscrow)
  if (!res.ok) return { error: res.error }
  revalidatePath('/admin/curadoria')
  return { info: 'Pacote publicado.' }
}

export async function rejectPackageAction(_: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireRole('admin')
  const parsed = rejectSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return issuesOf(parsed.error)
  const res = await rejectPackageAs(admin, parsed.data.packageId, parsed.data.reason)
  if (!res.ok) return { error: res.error }
  revalidatePath('/admin/curadoria')
  return { info: 'Pacote devolvido ao dev.' }
}
