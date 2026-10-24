/** Dinheiro: centavos inteiros (bigint) e taxas em basis points. Nunca ponto flutuante. */

export type Currency = 'BRL'

export interface Money {
  cents: bigint
  currency: Currency
}

export const BPS_DENOMINATOR = 10_000n

export function money(cents: bigint | number, currency: Currency = 'BRL'): Money {
  if (typeof cents === 'number' && !Number.isSafeInteger(cents)) {
    throw new RangeError('Valor em centavos precisa ser inteiro')
  }
  return { cents: BigInt(cents), currency }
}

/** Taxa = valor × bps / 10.000, arredondada para o centavo (metade para cima). */
export function feeCents(amountCents: bigint, feeBps: number): bigint {
  if (amountCents < 0n) throw new RangeError('Valor negativo')
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new RangeError('fee_bps precisa ser inteiro entre 0 e 10000')
  }
  const bps = BigInt(feeBps)
  return (amountCents * bps + BPS_DENOMINATOR / 2n) / BPS_DENOMINATOR
}

/** Parte do dev = valor − taxa; a soma sempre fecha. */
export function splitAmount(amountCents: bigint, feeBps: number) {
  const platformFeeCents = feeCents(amountCents, feeBps)
  return { platformFeeCents, devAmountCents: amountCents - platformFeeCents }
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error('Moedas diferentes')
  return { cents: a.cents + b.cents, currency: a.currency }
}

/** Formata em pt-BR, duas casas (ex.: R$ 1.234,56). */
export function formatBRL(cents: bigint): string {
  const negative = cents < 0n
  const abs = negative ? -cents : cents
  const reais = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const rest = (abs % 100n).toString().padStart(2, '0')
  return `${negative ? '-' : ''}R$ ${reais},${rest}`
}
