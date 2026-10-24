import 'server-only'
import { findPublicDevBySlug, listPublicDevSlugs } from '../infra/public-devs-repository'

// Perfil público do dev: sem login, só pela view `public_dev_profiles`.
export const getPublicDev = findPublicDevBySlug
export const getPublicDevSlugs = listPublicDevSlugs
