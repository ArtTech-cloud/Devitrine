import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Compara o token recebido com o esperado em tempo constante (SPEC §9). Os dois lados passam por
 * SHA-256 antes do `timingSafeEqual`, o que iguala o tamanho e não vaza o comprimento do segredo.
 */
export function tokenMatches(received: string | null | undefined, expected: string): boolean {
  if (!received || !expected) return false
  const a = createHash('sha256').update(received).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}
