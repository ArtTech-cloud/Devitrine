import 'server-only'
import { requireRole } from '@/modules/accounts'
import {
  findOwnPackage,
  listCategories,
  listCurationEvents,
  listOwnPackages,
  listPackagesForCuration,
} from '../infra/packages-repository'
import type { PackageStatus } from '../domain/tiers'

const claimsOf = (u: { id: string; aal: 'aal1' | 'aal2' }) => ({ sub: u.id, aal: u.aal })

export async function getCategories() {
  await requireRole('dev', 'admin')
  return listCategories()
}

export async function getOwnPackages() {
  const user = await requireRole('dev')
  return listOwnPackages(claimsOf(user))
}

export async function getOwnPackage(id: string) {
  const user = await requireRole('dev')
  const pkg = await findOwnPackage(claimsOf(user), id)
  if (!pkg) return null
  return { pkg, history: await listCurationEvents(claimsOf(user), id) }
}

export async function getPackageCurationQueue(status: PackageStatus = 'in_review') {
  const admin = await requireRole('admin')
  return listPackagesForCuration(claimsOf(admin), status)
}
