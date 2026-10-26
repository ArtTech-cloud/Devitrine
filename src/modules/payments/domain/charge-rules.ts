import { PaymentProviderError } from './errors'
import type { CreateChargeInput } from './provider'

/** Teto de uma cobrança no MVP, alinhado ao preço máximo de um nível de pacote (R$ 100.000,00). */
export const MAX_CHARGE_CENTS = 10_000_000n

/**
 * Regras que valem para qualquer adaptador antes de ir ao gateway: valores inteiros positivos e
 * a parte do dev (D) dentro do valor cheio (G). O encaixe de D no líquido só se confere depois,
 * com o `netCents` que o gateway devolve (`assertSplitFitsNet`).
 */
export function assertChargeInput(input: CreateChargeInput): void {
  const { grossCents, devAmountCents } = input
  if (typeof grossCents !== 'bigint' || typeof devAmountCents !== 'bigint') {
    throw new PaymentProviderError('validation', 'Valores precisam ser bigint em centavos')
  }
  if (grossCents <= 0n || grossCents > MAX_CHARGE_CENTS) {
    throw new PaymentProviderError('validation', 'Valor da cobrança fora do intervalo permitido')
  }
  if (devAmountCents <= 0n || devAmountCents > grossCents) {
    throw new PaymentProviderError('validation', 'A parte do dev precisa estar entre 0 e o valor da cobrança')
  }
  if (input.method !== 'pix' && input.method !== 'card') {
    throw new PaymentProviderError('validation', 'Método de pagamento inválido')
  }
  if (!input.devWalletId.trim()) throw new PaymentProviderError('validation', 'devWalletId é obrigatório')
  if (!input.orderId.trim()) throw new PaymentProviderError('validation', 'orderId é obrigatório')
  if (!input.idempotencyKey.trim()) {
    throw new PaymentProviderError('validation', 'Chave de idempotência é obrigatória')
  }
  const { name, cpfCnpj, email } = input.customer
  if (!name.trim() || !cpfCnpj.trim() || !email.trim()) {
    throw new PaymentProviderError('validation', 'Cliente precisa de nome, documento e e-mail')
  }
}

/** O split é calculado sobre o líquido: a parte do dev (D) precisa caber em `netCents` (SPEC §8, item 4). */
export function splitFitsNet(devAmountCents: bigint, netCents: bigint): boolean {
  return devAmountCents <= netCents
}

/** Impressão digital dos parâmetros de uma chamada, para detectar a mesma chave com conteúdo diferente. */
export function fingerprint(parts: readonly (string | bigint | number | null | undefined)[]): string {
  return JSON.stringify(parts.map((p) => (typeof p === 'bigint' ? `${p}n` : (p ?? null))))
}
