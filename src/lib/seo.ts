/** URL pública do site (canonical, sitemap, JSON-LD). Defina NEXT_PUBLIC_SITE_URL em produção. */
export function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '')
}

export const absoluteUrl = (path: string) => `${siteUrl()}${path}`

/** Centavos em reais com ponto decimal, sem ponto flutuante (formato do schema.org). */
export function priceForSchema(cents: bigint): string {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`
}

/** Serializa JSON-LD para `<script>`: escapa `<`, `>` e `&` para o conteúdo do dev não fechar a tag. */
export function jsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
}
