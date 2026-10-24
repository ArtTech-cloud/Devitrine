import { describe, expect, it } from 'vitest'
import { hasRequiredTiers, lowestPriceCents, simulateNet } from '@/modules/catalog/domain/tiers'
import { packageSchema } from '@/modules/catalog/application/schemas'

const categoryId = '0198f8f0-0000-7000-8000-000000000001'
const base = {
  categoryId,
  title: 'Landing page completa',
  summary: 'Página de vendas responsiva e rápida',
  descriptionMd: '',
  basic_price: '500,00',
  basic_days: '7',
  basic_revisions: '1',
  basic_scope: 'Uma página com até 5 seções',
}

describe('domínio do catálogo', () => {
  it('simula taxa e valor do dev somando o preço', () => {
    const { feeCents, netCents } = simulateNet(50_001n, 1500)
    expect(feeCents + netCents).toBe(50_001n)
    expect(feeCents).toBe(7500n)
  })
  it('Básico é obrigatório; menor preço serve de "a partir de"', () => {
    expect(hasRequiredTiers([{ tier: 'standard' }])).toBe(false)
    expect(hasRequiredTiers([{ tier: 'basic' }, { tier: 'premium' }])).toBe(true)
    expect(lowestPriceCents([])).toBeNull()
    expect(lowestPriceCents([{ priceCents: 900n }, { priceCents: 300n }])).toBe(300n)
  })
})

describe('schema do pacote', () => {
  it('aceita só o Básico e converte reais em centavos', () => {
    const v = packageSchema.parse(base)
    expect(v.tiers).toHaveLength(1)
    expect(v.tiers[0]).toMatchObject({ tier: 'basic', priceCents: 50_000n, deliveryDays: 7, revisions: 1 })
  })
  it('nível vazio é ignorado; nível preenchido pela metade é recusado', () => {
    const three = packageSchema.parse({
      ...base,
      standard_price: '900,00',
      standard_days: '10',
      standard_scope: 'Até 10 seções e blog',
      premium_price: '',
    })
    expect(three.tiers.map((t) => t.tier)).toEqual(['basic', 'standard'])
    const half = packageSchema.safeParse({ ...base, standard_price: '900,00' })
    expect(half.success).toBe(false)
  })
  it('exige Básico e respeita os limites', () => {
    expect(packageSchema.safeParse({ ...base, basic_price: '', basic_scope: '' }).success).toBe(false)
    expect(packageSchema.safeParse({ ...base, basic_price: '100.000,01' }).success).toBe(false)
    expect(packageSchema.safeParse({ ...base, basic_days: '31' }).success).toBe(false)
    expect(packageSchema.safeParse({ ...base, basic_revisions: '11' }).success).toBe(false)
    expect(packageSchema.safeParse({ ...base, basic_price: '0' }).success).toBe(false)
    expect(packageSchema.safeParse({ ...base, title: 'abc' }).success).toBe(false)
    expect(packageSchema.safeParse({ ...base, categoryId: 'x' }).success).toBe(false)
  })
})
