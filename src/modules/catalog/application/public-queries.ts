import 'server-only'
import {
  findPublicPackage,
  listPublicCategories,
  listPublicPackageSlugs,
  listPublicPackages,
  listPublicPackagesByDev,
} from '../infra/public-repository'

// Leituras da vitrine pública: sem login, só pelas views públicas.
export const getPublicPackages = listPublicPackages
export const getPublicPackage = findPublicPackage
export const getPublicPackagesByDev = listPublicPackagesByDev
export const getPublicCategories = listPublicCategories
export const getPublicPackageSlugs = listPublicPackageSlugs
