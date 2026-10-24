// API pública do módulo accounts.
export { getCurrentUser, requireRole } from './application/current-user'
export {
  signUpAction,
  signInAction,
  signOutAction,
  enrollTotp,
  verifyTotpAction,
} from './application/auth-actions'
export type { FormState } from './application/auth-actions'
export { homePathFor, decideAccess, ROLES, SIGNUP_ROLES } from './domain/roles'
export type { Role, CurrentUser, AuthLevel, AccessDecision } from './domain/roles'
