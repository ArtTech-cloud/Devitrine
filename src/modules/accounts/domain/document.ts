export function onlyDigits(value: string): string {
  return value.replace(/\D/g, '')
}

function checkDigit(digits: number[], weights: number[]): number {
  const sum = digits.reduce((acc, d, i) => acc + d * weights[i]!, 0)
  const rest = sum % 11
  return rest < 2 ? 0 : 11 - rest
}

export function isValidCpf(value: string): boolean {
  const s = onlyDigits(value)
  if (s.length !== 11 || /^(\d)\1{10}$/.test(s)) return false
  const d = [...s].map(Number)
  return (
    checkDigit(d.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]) === d[9] &&
    checkDigit(d.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]) === d[10]
  )
}

export function isValidCnpj(value: string): boolean {
  const s = onlyDigits(value)
  if (s.length !== 14 || /^(\d)\1{13}$/.test(s)) return false
  const d = [...s].map(Number)
  return (
    checkDigit(d.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === d[12] &&
    checkDigit(d.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === d[13]
  )
}

export type DocumentKind = 'cpf' | 'cnpj'

export function documentKind(value: string): DocumentKind | null {
  if (isValidCpf(value)) return 'cpf'
  if (isValidCnpj(value)) return 'cnpj'
  return null
}
