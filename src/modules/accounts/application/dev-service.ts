import type { UserClaims } from '@/lib/db'
import { withContext } from '@/lib/logger'
import { newId } from '@/lib/ids'
import { getNumberSetting } from '@/lib/settings'
import { kycRetryAfterSeconds, normalizeKyc, shouldEnableEscrow, KYC_REFRESH_MIN_SECONDS } from '../domain/kyc'
import { slugify, withSuffix } from '@/lib/slug'
import type { DevStatus } from '../domain/dev-status'
import type { RecipientGateway } from '../domain/recipient-gateway'
import {
  claimKycRefresh,
  claimKycStart,
  findOwnProfile,
  findProfileAsService,
  insertOwnProfile,
  markEscrowEnabled,
  pgCode,
  releaseKycClaim,
  restartRejectedKyc,
  saveKycStatus,
  saveRecipient,
  setDevStatus,
  updateOwnProfile,
  type DevProfile,
} from '../infra/dev-profiles-repository'
import type { DevProfileInput, KycInput } from './schemas-dev'

export interface Actor {
  id: string
  email: string
  aal?: 'aal1' | 'aal2'
}

export type ServiceResult<T = void> = { ok: true; value: T } | { ok: false; error: string }

const ok = <T>(value: T): ServiceResult<T> => ({ ok: true, value })
const fail = (error: string): ServiceResult<never> => ({ ok: false, error })
const claimsOf = (a: Actor): UserClaims => ({ sub: a.id, aal: a.aal ?? 'aal1' })

/** Cria o perfil (slug derivado do nome, com sufixo se já existir) ou atualiza o existente. */
export async function saveDevProfile(actor: Actor, input: DevProfileInput): Promise<ServiceResult<DevProfile>> {
  const claims = claimsOf(actor)
  const current = await findOwnProfile(claims)
  if (current) {
    const updated = await updateOwnProfile(claims, input)
    if (!updated) return fail('Seu perfil está suspenso e não pode ser editado.')
  } else {
    const base = slugify(input.displayName)
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = attempt === 0 ? base : withSuffix(base, newId().replace(/-/g, '').slice(-5))
      try {
        await insertOwnProfile(claims, { slug, ...input })
        break
      } catch (e) {
        if (pgCode(e) === '23505' && attempt < 4) continue
        if (pgCode(e) === '42501') return fail('Apenas contas de dev criam perfil de dev.')
        throw e
      }
    }
  }
  const profile = await findOwnProfile(claims)
  return profile ? ok(profile) : fail('Não foi possível salvar o perfil.')
}

/** Liga o escrow da subconta quando as duas condições (curadoria e KYC) estão atendidas. */
export async function enableEscrowIfReady(devId: string, gateway: RecipientGateway): Promise<boolean> {
  const p = await findProfileAsService(devId)
  if (
    !p?.providerAccountId ||
    !shouldEnableEscrow({
      devStatus: p.status,
      kycStatus: p.kycStatus,
      hasAccount: true,
      escrowEnabledAt: p.escrowEnabledAt,
    })
  ) {
    return false
  }
  const daysToExpire = await getNumberSetting('escrow_days_to_expire')
  await gateway.enableEscrow(p.providerAccountId, {
    daysToExpire,
    isFeePayer: false,
    idempotencyKey: `escrow:${devId}`,
  })
  await markEscrowEnabled(devId)
  return true
}

/**
 * Cria a subconta do dev no gateway (uma vez por tentativa) e guarda o link de verificação.
 * Com o KYC recusado, o dev reenvia os dados e uma nova tentativa começa (ADR-012).
 */
export async function startKyc(
  actor: Actor,
  input: KycInput,
  gateway: RecipientGateway,
): Promise<ServiceResult<DevProfile>> {
  const profile = await findOwnProfile(claimsOf(actor))
  if (!profile) return fail('Preencha o perfil antes de iniciar a verificação.')
  if (profile.status === 'suspended') return fail('Seu perfil está suspenso.')
  let attempts = profile.kycAttempts
  if (profile.kycStatus === 'rejected') {
    const restarted = await restartRejectedKyc(actor.id)
    if (restarted) {
      attempts += 1
      withContext({ requestId: newId() }).info({ previous: restarted.previousAccountId }, 'KYC recusado: reenvio iniciado')
    }
  }
  if (!(await claimKycStart(actor.id))) return fail('A verificação já foi iniciada.')
  try {
    const ref = await gateway.createRecipient({
      devUserId: actor.id,
      email: actor.email,
      idempotencyKey: `kyc:${actor.id}:${attempts}`,
      ...input,
    })
    await saveRecipient(actor.id, ref)
  } catch (e) {
    await releaseKycClaim(actor.id)
    withContext({ requestId: newId() }).error({ err: (e as Error).message }, 'criação de subconta falhou')
    return fail('Não foi possível iniciar a verificação agora. Tente novamente em instantes.')
  }
  const updated = await findProfileAsService(actor.id)
  return updated ? ok(updated) : fail('Perfil não encontrado.')
}

/** Consulta o KYC no gateway, no máximo uma vez a cada 30 s por dev. */
export async function refreshKyc(
  actor: Actor,
  gateway: RecipientGateway,
  now = new Date(),
): Promise<ServiceResult<DevProfile>> {
  const profile = await findOwnProfile(claimsOf(actor))
  if (!profile?.providerAccountId) return fail('Inicie a verificação primeiro.')
  const wait = kycRetryAfterSeconds(profile.kycCheckedAt, now)
  if (wait > 0 || !(await claimKycRefresh(actor.id, KYC_REFRESH_MIN_SECONDS))) {
    return fail(`Aguarde ${wait || KYC_REFRESH_MIN_SECONDS} segundos para consultar de novo.`)
  }
  try {
    const status = await gateway.getRecipientStatus(profile.providerAccountId)
    await saveKycStatus(actor.id, { kycStatus: normalizeKyc(status.kyc), kycLink: status.onboardingUrl })
    await enableEscrowIfReady(actor.id, gateway)
  } catch (e) {
    withContext({ requestId: newId() }).error({ err: (e as Error).message }, 'consulta de KYC falhou')
    return fail('Não foi possível consultar a verificação agora.')
  }
  const updated = await findProfileAsService(actor.id)
  return updated ? ok(updated) : fail('Perfil não encontrado.')
}

/** Curadoria: só admin (a função SQL confere is_admin e aal2); aprovar tenta ligar o escrow. */
export async function decideDev(
  admin: Actor,
  devId: string,
  status: Extract<DevStatus, 'approved' | 'suspended'>,
  reason: string,
  gateway: RecipientGateway,
): Promise<ServiceResult> {
  try {
    await setDevStatus(claimsOf(admin), devId, status, reason)
  } catch (e) {
    const code = pgCode(e)
    if (code === '42501') return fail('Apenas admin com verificação em duas etapas decide.')
    if (code === 'P0001') return fail('Transição de status inválida para este dev.')
    if (code === 'P0002') return fail('Dev não encontrado.')
    throw e
  }
  if (status === 'approved') {
    try {
      await enableEscrowIfReady(devId, gateway)
    } catch (e) {
      // A aprovação já valeu; o escrow é religado quando o KYC for consultado de novo.
      withContext({ requestId: newId() }).error({ err: (e as Error).message }, 'escrow não ligado após aprovação')
    }
  }
  return ok(undefined)
}
