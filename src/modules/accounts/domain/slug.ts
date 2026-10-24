const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

export function isValidSlug(slug: string): boolean {
  return slug.length >= 3 && slug.length <= 60 && SLUG_RE.test(slug)
}

/** "João da Silva" -> "joao-da-silva"; nome sem letras ou dígitos vira "dev-novo". */
export function slugify(text: string): string {
  const base = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '')
  if (base.length >= 3) return base
  return base ? `dev-${base}` : 'dev-novo'
}

export function withSuffix(slug: string, suffix: string): string {
  return `${slug.slice(0, 50).replace(/-+$/g, '')}-${suffix}`
}
