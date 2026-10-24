import { redirect } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/auth/supabase'
import { findRoleByUserId } from '../infra/users-repository'
import {
  decideAccess,
  homePathFor,
  type AuthLevel,
  type CurrentUser,
  type Role,
} from '../domain/roles'

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const supabase = await createSupabaseServerClient()
  const { data } = await supabase.auth.getClaims()
  const claims = data?.claims
  if (!claims?.sub) return null
  const aal = (claims.aal as AuthLevel | undefined) ?? 'aal1'
  const row = await findRoleByUserId({ sub: claims.sub, aal })
  if (!row) return null
  return { id: claims.sub, email: row.email, role: row.role, aal }
}

/** Guarda de caso de uso: exige login, papel e (para admin) segundo fator. */
export async function requireRole(...allowed: Role[]): Promise<CurrentUser> {
  const user = await getCurrentUser()
  const decision = decideAccess(user, allowed)
  if (decision === 'login') redirect('/login')
  if (decision === 'mfa') redirect('/admin/mfa')
  if (decision === 'forbidden' || !user) redirect(user ? homePathFor(user.role) : '/login')
  return user
}
