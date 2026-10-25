'use server'

import { redirect } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/auth/supabase'
import { withContext } from '@/lib/logger'
import { allowAuthAttempt, clientIp } from '@/lib/rate-limit'
import { newId } from '@/lib/ids'
import { signInSchema, signUpSchema, totpCodeSchema } from './schemas'
import { getCurrentUser } from './current-user'

export interface FormState {
  error?: string
  info?: string
}

const TOO_MANY = 'Muitas tentativas. Aguarde alguns minutos e tente de novo.'

/** Rate limit antes do Supabase Auth (ADR-011); se o contador falhar, nega em vez de liberar. */
async function throttled(action: 'signin' | 'signup', email: string): Promise<boolean> {
  const ip = await clientIp()
  try {
    if (await allowAuthAttempt(action, ip, email)) return false
  } catch (e) {
    withContext({ requestId: newId() }).error({ err: e, action }, 'rate limit indisponível')
    return true
  }
  withContext({ requestId: newId() }).warn({ action }, 'login bloqueado por rate limit')
  return true
}

export async function signUpAction(_: FormState, formData: FormData): Promise<FormState> {
  const parsed = signUpSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos' }
  if (await throttled('signup', parsed.data.email)) return { error: TOO_MANY }
  const supabase = await createSupabaseServerClient()
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: { data: { signup_role: parsed.data.role } },
  })
  if (error) {
    withContext({ requestId: newId() }).warn({ code: error.code }, 'signup falhou')
    return { error: 'Não foi possível criar a conta. Tente novamente.' }
  }
  if (!data.session) return { info: 'Confira seu e-mail para confirmar o cadastro.' }
  redirect('/app')
}

export async function signInAction(_: FormState, formData: FormData): Promise<FormState> {
  const parsed = signInSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Dados inválidos' }
  if (await throttled('signin', parsed.data.email)) return { error: TOO_MANY }
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.auth.signInWithPassword(parsed.data)
  if (error) return { error: 'E-mail ou senha incorretos.' }
  redirect('/app')
}

export async function signOutAction(): Promise<void> {
  const supabase = await createSupabaseServerClient()
  await supabase.auth.signOut({ scope: 'global' })
  redirect('/login')
}

/** Inicia o cadastro do TOTP; devolve o QR Code e o id do fator. */
export async function enrollTotp() {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') return null
  const supabase = await createSupabaseServerClient()
  const { data: factors } = await supabase.auth.mfa.listFactors()
  const verified = factors?.totp ?? []
  if (verified.length > 0) return { factorId: verified[0]!.id, qrCode: null, secret: null }
  for (const f of factors?.all ?? []) {
    if (f.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: f.id })
  }
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' })
  if (error || !data) return null
  return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret }
}

export async function verifyTotpAction(_: FormState, formData: FormData): Promise<FormState> {
  const parsed = totpCodeSchema.safeParse({ code: formData.get('code') })
  const factorId = String(formData.get('factorId') ?? '')
  if (!parsed.success || !factorId) return { error: 'Informe o código de 6 dígitos.' }
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') return { error: 'Acesso negado.' }
  const supabase = await createSupabaseServerClient()
  const { data: challenge, error: cErr } = await supabase.auth.mfa.challenge({ factorId })
  if (cErr || !challenge) return { error: 'Não foi possível validar. Tente de novo.' }
  const { error } = await supabase.auth.mfa.verify({
    factorId,
    challengeId: challenge.id,
    code: parsed.data.code,
  })
  if (error) return { error: 'Código incorreto.' }
  redirect('/admin')
}
