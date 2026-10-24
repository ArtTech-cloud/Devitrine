import type { DevStatus } from './dev-status'
import type { KycState } from './recipient-gateway'

/** Intervalo mínimo entre consultas de KYC por dev, para não esgotar a quota da API do gateway. */
export const KYC_REFRESH_MIN_SECONDS = 30

/** Segundos até a próxima consulta liberada; 0 se já pode consultar. */
export function kycRetryAfterSeconds(checkedAt: Date | null, now: Date): number {
  if (!checkedAt) return 0
  const wait = KYC_REFRESH_MIN_SECONDS - (now.getTime() - checkedAt.getTime()) / 1000
  return wait > 0 ? Math.ceil(wait) : 0
}

/** Escrow só para dev aprovado na curadoria e com KYC aprovado (mensalidade por subconta, SPEC §8). */
export function shouldEnableEscrow(p: {
  devStatus: DevStatus
  kycStatus: KycState
  hasAccount: boolean
  escrowEnabledAt: Date | null
}): boolean {
  return p.devStatus === 'approved' && p.kycStatus === 'approved' && p.hasAccount && !p.escrowEnabledAt
}

/** O gateway nunca volta para "not_started": uma subconta criada fica ao menos pendente. */
export function normalizeKyc(state: KycState): Exclude<KycState, 'not_started'> {
  return state === 'not_started' ? 'pending' : state
}
