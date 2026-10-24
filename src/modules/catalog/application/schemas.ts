import { z } from 'zod'
import { parseBRL } from '@/lib/money'
import { LIMITS, TIERS, type Tier, type TierInput } from '../domain/tiers'

const intInRange = (label: string, min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+$/, `${label}: informe um número inteiro`)
    .transform(Number)
    .pipe(z.number().min(min, `${label}: mínimo ${min}`).max(max, `${label}: máximo ${max}`))

/** Um nível do formulário: nível vazio (sem preço) é ignorado; preenchido, precisa estar completo. */
function parseTier(tier: Tier, raw: Record<string, unknown>, ctx: z.RefinementCtx): TierInput | null {
  const get = (k: string) => String(raw[`${tier}_${k}`] ?? '').trim()
  const price = get('price')
  const scope = get('scope')
  if (!price && !scope) return null
  const fail = (message: string, field: string) => ctx.addIssue({ code: 'custom', message, path: [`${tier}_${field}`] })
  const priceCents = parseBRL(price)
  if (priceCents === null || priceCents <= 0n) {
    fail(`Nível ${tier}: informe o preço em reais`, 'price')
    return null
  }
  if (priceCents > LIMITS.maxPriceCents) {
    fail('Preço máximo de R$ 100.000,00', 'price')
    return null
  }
  const days = intInRange('Prazo', 1, LIMITS.maxDeliveryDays).safeParse(get('days'))
  if (!days.success) {
    fail(days.error.issues[0]?.message ?? 'Prazo inválido', 'days')
    return null
  }
  const revisions = intInRange('Revisões', 0, LIMITS.maxRevisions).safeParse(get('revisions') || '0')
  if (!revisions.success) {
    fail(revisions.error.issues[0]?.message ?? 'Revisões inválidas', 'revisions')
    return null
  }
  if (scope.length < 10 || scope.length > 5000) {
    fail('Descreva o que está incluso (10 a 5000 caracteres)', 'scope')
    return null
  }
  return { tier, priceCents, deliveryDays: days.data, revisions: revisions.data, scopeMd: scope }
}

export const packageSchema = z
  .object({
    categoryId: z.string().uuid('Escolha uma categoria'),
    title: z.string().trim().min(5, 'Título: mínimo 5 caracteres').max(80, 'Título: máximo 80 caracteres'),
    summary: z.string().trim().min(10, 'Resumo: mínimo 10 caracteres').max(160, 'Resumo: máximo 160 caracteres'),
    descriptionMd: z.string().trim().max(10_000, 'Descrição: máximo 10000 caracteres').default(''),
  })
  .passthrough()
  .transform((v, ctx) => {
    const tiers: TierInput[] = []
    for (const t of TIERS) {
      const parsed = parseTier(t, v as Record<string, unknown>, ctx)
      if (parsed) tiers.push(parsed)
    }
    if (!tiers.some((t) => t.tier === 'basic')) {
      ctx.addIssue({ code: 'custom', message: 'Preencha ao menos o nível Básico', path: ['basic_price'] })
      return z.NEVER
    }
    return {
      fields: { categoryId: v.categoryId, title: v.title, summary: v.summary, descriptionMd: v.descriptionMd },
      tiers,
    }
  })
export type PackageInput = z.output<typeof packageSchema>

export const packageIdSchema = z.object({ packageId: z.string().uuid() })

export const rejectSchema = z.object({
  packageId: z.string().uuid(),
  reason: z.string().trim().min(3, 'Informe o motivo (mínimo 3 caracteres)').max(500),
})
