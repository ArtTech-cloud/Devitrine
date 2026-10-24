import type { UserClaims } from '@/lib/db'
import { newId } from '@/lib/ids'
import { slugify, withSuffix } from '@/lib/slug'
import { CATALOG_ERROR_MESSAGE } from '../domain/tiers'
import {
  findOwnPackage,
  findPackageAsService,
  insertPackage,
  pgCode,
  pgMessage,
  rejectPackage,
  runPackageAction,
  updatePackage,
  type PackageAction,
} from '../infra/packages-repository'
import type { PackageInput } from './schemas'

export interface Actor {
  id: string
  email: string
  aal?: 'aal1' | 'aal2'
}

export type ServiceResult<T = void> = { ok: true; value: T } | { ok: false; error: string }

const ok = <T>(value: T): ServiceResult<T> => ({ ok: true, value })
const fail = (error: string): ServiceResult<never> => ({ ok: false, error })
const claimsOf = (a: Actor): UserClaims => ({ sub: a.id, aal: a.aal ?? 'aal1' })

/** Traduz o erro de máquina das funções SQL; o que não é conhecido sobe (vira 500 e log). */
function mapError(e: unknown): ServiceResult<never> {
  const known = CATALOG_ERROR_MESSAGE[pgMessage(e)]
  if (known) return fail(known)
  if (pgCode(e) === '42501') return fail('Você não tem permissão para esta ação.')
  throw e
}

/** Cria o pacote em rascunho; o slug vem do título, com sufixo aleatório se já existir. */
export async function createPackage(actor: Actor, input: PackageInput): Promise<ServiceResult<{ id: string }>> {
  const claims = claimsOf(actor)
  const id = newId()
  const base = slugify(input.fields.title)
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? base : withSuffix(base, newId().replace(/-/g, '').slice(-5))
    try {
      await insertPackage(claims, id, slug, input.fields, input.tiers)
      return ok({ id })
    } catch (e) {
      if (pgCode(e) === '23505' && attempt < 4) continue
      if (pgCode(e) === '42501') return fail('Apenas dev aprovado cria pacotes.')
      throw e
    }
  }
  return fail('Não foi possível criar o pacote.')
}

/** Edita o pacote; pacote publicado, pausado ou em análise volta a rascunho (ADR-013). */
export async function editPackage(actor: Actor, packageId: string, input: PackageInput): Promise<ServiceResult> {
  try {
    const done = await updatePackage(claimsOf(actor), packageId, input.fields, input.tiers)
    return done ? ok(undefined) : fail(CATALOG_ERROR_MESSAGE.package_not_found!)
  } catch (e) {
    return mapError(e)
  }
}

async function run(actor: Actor, packageId: string, action: PackageAction): Promise<ServiceResult> {
  try {
    await runPackageAction(claimsOf(actor), packageId, action)
    return ok(undefined)
  } catch (e) {
    return mapError(e)
  }
}

export const submitPackage = (actor: Actor, packageId: string) => run(actor, packageId, 'submit')
export const withdrawPackage = (actor: Actor, packageId: string) => run(actor, packageId, 'withdraw')
export const pausePackage = (actor: Actor, packageId: string) => run(actor, packageId, 'pause')
export const resumePackage = (actor: Actor, packageId: string) => run(actor, packageId, 'resume')

/**
 * Aprovação do admin: antes de aprovar, religa o escrow do dev se ainda faltar (a chamada ao
 * gateway pode ter falhado na aprovação do perfil). A função SQL confere is_admin, aal2 e o guard.
 */
export async function approvePackage(
  admin: Actor,
  packageId: string,
  ensureEscrow: (devId: string) => Promise<unknown>,
): Promise<ServiceResult> {
  const pkg = await findPackageAsService(packageId)
  if (!pkg) return fail(CATALOG_ERROR_MESSAGE.package_not_found!)
  try {
    await ensureEscrow(pkg.devId)
  } catch {
    // o guard da aprovação recusa com escrow_not_enabled se o gateway ainda falha
  }
  return run(admin, packageId, 'approve')
}

export async function rejectPackageAs(admin: Actor, packageId: string, reason: string): Promise<ServiceResult> {
  try {
    await rejectPackage(claimsOf(admin), packageId, reason)
    return ok(undefined)
  } catch (e) {
    return mapError(e)
  }
}

export { findOwnPackage }
