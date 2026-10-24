import type { CookieOptions } from '@supabase/ssr'

/** Flags de cookie de sessão exigidas pela SPEC §10: httpOnly, SameSite=Lax e Secure em produção. */
export function hardenCookieOptions(options?: CookieOptions): CookieOptions {
  return { ...options, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' }
}
