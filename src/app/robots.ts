import type { MetadataRoute } from 'next'
import { absoluteUrl } from '@/lib/seo'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: ['/', '/pacotes', '/devs'], disallow: ['/app', '/admin', '/api', '/login', '/signup'] },
    sitemap: absoluteUrl('/sitemap.xml'),
  }
}
