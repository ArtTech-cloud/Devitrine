import { splitAmount } from '@/lib/money'

export const TIERS = ['basic', 'standard', 'premium'] as const
export type Tier = (typeof TIERS)[number]

export const TIER_LABEL: Record<Tier, string> = {
  basic: 'Básico',
  standard: 'Padrão',
  premium: 'Premium',
}

export type PackageStatus = 'draft' | 'in_review' | 'published' | 'paused'

export const PACKAGE_STATUS_LABEL: Record<PackageStatus, string> = {
  draft: 'Rascunho',
  in_review: 'Em análise',
  published: 'Publicado',
  paused: 'Pausado',
}

/** Limites espelhados nos CHECKs da migração 0010 (ADR-013). */
export const LIMITS = {
  maxPriceCents: 10_000_000n,
  maxDeliveryDays: 30,
  maxRevisions: 10,
} as const

export interface TierInput {
  tier: Tier
  priceCents: bigint
  deliveryDays: number
  revisions: number
  scopeMd: string
}

/** "Até três níveis": o Básico é obrigatório, os outros são opcionais. */
export function hasRequiredTiers(tiers: readonly { tier: Tier }[]): boolean {
  return tiers.some((t) => t.tier === 'basic')
}

/** Simulação do editor: quanto sobra para o dev com a taxa da primeira venda. */
export function simulateNet(priceCents: bigint, feeBps: number) {
  const { platformFeeCents, devAmountCents } = splitAmount(priceCents, feeBps)
  return { feeCents: platformFeeCents, netCents: devAmountCents }
}

/** Para a vitrine e as listas: "a partir de" é o menor preço entre os níveis. */
export function lowestPriceCents(tiers: readonly { priceCents: bigint }[]): bigint | null {
  if (tiers.length === 0) return null
  return tiers.reduce((min, t) => (t.priceCents < min ? t.priceCents : min), tiers[0]!.priceCents)
}

/** Erros de máquina levantados pelas funções SQL do catálogo (migração 0010). */
export const CATALOG_ERROR_MESSAGE: Record<string, string> = {
  dev_not_approved: 'Seu perfil ainda não foi aprovado pela curadoria.',
  kyc_not_approved: 'Conclua a verificação de identidade (KYC) para publicar.',
  escrow_not_enabled: 'A conta de recebimento ainda não está pronta. Tente de novo em instantes.',
  tiers_incomplete: 'Preencha ao menos o nível Básico.',
  invalid_transition: 'Esta ação não vale para o status atual do pacote.',
  package_not_found: 'Pacote não encontrado.',
  not_admin: 'Apenas admin com verificação em duas etapas decide.',
  reason_required: 'Informe o motivo.',
}
