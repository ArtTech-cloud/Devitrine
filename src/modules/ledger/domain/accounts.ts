// Plano de contas do razão (SPEC §6). Contas da plataforma não têm dono; as `dev_*` têm um por dev.
export const PLATFORM_ACCOUNT_CODES = [
  'gateway_cash',
  'gateway_fees',
  'escrow_liability',
  'platform_revenue',
] as const

export const DEV_ACCOUNT_CODES = [
  'dev_payable',
  'dev_available',
  'dev_withdrawal_pending',
  'dev_receivable',
] as const

export type PlatformAccountCode = (typeof PLATFORM_ACCOUNT_CODES)[number]
export type DevAccountCode = (typeof DEV_ACCOUNT_CODES)[number]
export type LedgerAccountCode = PlatformAccountCode | DevAccountCode

export type LedgerAccountRef =
  | { code: PlatformAccountCode }
  | { code: DevAccountCode; ownerId: string }

export type Direction = 'debit' | 'credit'

const DEBIT_NORMAL: readonly LedgerAccountCode[] = ['gateway_cash', 'gateway_fees', 'dev_receivable']

/** Lado em que a conta aumenta; o saldo é lado normal − lado oposto. Igual a `ledger_normal_side` no banco. */
export function normalSide(code: LedgerAccountCode): Direction {
  return DEBIT_NORMAL.includes(code) ? 'debit' : 'credit'
}

export const platformAccount = (code: PlatformAccountCode): LedgerAccountRef => ({ code })
export const devAccount = (code: DevAccountCode, ownerId: string): LedgerAccountRef => ({ code, ownerId })

export function accountKey(ref: LedgerAccountRef): string {
  return 'ownerId' in ref ? `${ref.code}:${ref.ownerId}` : ref.code
}
