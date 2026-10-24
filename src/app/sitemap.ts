import type { MetadataRoute } from 'next'
import { absoluteUrl } from '@/lib/seo'
import { getPublicDevSlugs } from '@/modules/accounts'
import { getPublicPackageSlugs } from '@/modules/catalog'

export const dynamic = 'force-dynamic'

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [packages, devs] = await Promise.all([getPublicPackageSlugs(), getPublicDevSlugs()])
  return [
    { url: absoluteUrl('/') },
    { url: absoluteUrl('/pacotes') },
    ...packages.map((p) => ({ url: absoluteUrl(`/pacotes/${p.slug}`), lastModified: p.publishedAt })),
    ...devs.map((slug) => ({ url: absoluteUrl(`/devs/${slug}`) })),
  ]
}
