export const ROLES = ['client', 'dev', 'admin'] as const
export type Role = (typeof ROLES)[number]

/** Papéis que podem ser escolhidos no cadastro público. Admin só por convite. */
export const SIGNUP_ROLES = ['client', 'dev'] as const
export type SignupRole = (typeof SIGNUP_ROLES)[number]

export type AuthLevel = 'aal1' | 'aal2'

export interface CurrentUser {
  id: string
  email: string
  role: Role
  aal: AuthLevel
}

export function homePathFor(role: Role): string {
  switch (role) {
    case 'admin':
      return '/admin'
    case 'dev':
      return '/app/dev'
    default:
      return '/app/client'
  }
}

export type AccessDecision = 'allow' | 'login' | 'forbidden' | 'mfa'

/** Admin sem segundo fator nunca passa (TOTP obrigatório). */
export function decideAccess(user: CurrentUser | null, allowed: readonly Role[]): AccessDecision {
  if (!user) return 'login'
  if (!allowed.includes(user.role)) return 'forbidden'
  if (user.role === 'admin' && user.aal !== 'aal2') return 'mfa'
  return 'allow'
}
