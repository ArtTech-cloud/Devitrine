import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { addMoney, feeCents, formatBRL, money, splitAmount } from '@/lib/money'

describe('feeCents', () => {
  it('calcula taxa em basis points', () => {
    expect(feeCents(10_000n, 1500)).toBe(1500n) // 15% de R$ 100,00
    expect(feeCents(10_000n, 1000)).toBe(1000n)
    expect(feeCents(10_000n, 500)).toBe(500n)
  })

  it('arredonda para o centavo (metade para cima)', () => {
    expect(feeCents(333n, 1500)).toBe(50n) // 49,95 -> 50
    expect(feeCents(1n, 5000)).toBe(1n) // 0,5 -> 1
    expect(feeCents(1n, 4999)).toBe(0n)
    expect(feeCents(10n, 1500)).toBe(2n) // 1,5 -> 2
  })

  it('rejeita entradas inválidas', () => {
    expect(() => feeCents(-1n, 1000)).toThrow(RangeError)
    expect(() => feeCents(100n, 10_001)).toThrow(RangeError)
    expect(() => feeCents(100n, 1.5)).toThrow(RangeError)
    expect(() => feeCents(100n, -1)).toThrow(RangeError)
  })
})

describe('splitAmount', () => {
  it('taxa + parte do dev sempre fecha o valor', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000_000n }),
        fc.integer({ min: 0, max: 10_000 }),
        (amount, bps) => {
          const { platformFeeCents, devAmountCents } = splitAmount(amount, bps)
          expect(platformFeeCents + devAmountCents).toBe(amount)
          expect(platformFeeCents).toBeGreaterThanOrEqual(0n)
          expect(devAmountCents).toBeGreaterThanOrEqual(0n)
        },
      ),
    )
  })

  it('taxa nunca passa do valor', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 1_000_000n }), fc.integer({ min: 0, max: 10_000 }), (a, bps) => {
        expect(feeCents(a, bps) <= a).toBe(true)
      }),
    )
  })
})

describe('money helpers', () => {
  it('soma moedas iguais e recusa diferentes', () => {
    expect(addMoney(money(100), money(250)).cents).toBe(350n)
    expect(() => addMoney(money(1), { cents: 1n, currency: 'USD' as 'BRL' })).toThrow()
  })

  it('recusa centavos não inteiros', () => {
    expect(() => money(10.5)).toThrow(RangeError)
  })

  it('formata em pt-BR', () => {
    expect(formatBRL(123_456n)).toBe('R$ 1.234,56')
    expect(formatBRL(5n)).toBe('R$ 0,05')
    expect(formatBRL(-100n)).toBe('-R$ 1,00')
  })
})
