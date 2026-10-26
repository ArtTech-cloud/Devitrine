// API pública do módulo ledger. Só ele escreve em ledger_entries (ADR-004, ADR-018).
export {
  postLedgerTx,
  getBalanceCents,
  getDevSpendableCents,
  getAllBalances,
  checkLedgerTx,
} from './application/ledger-service'
export {
  paymentConfirmed,
  orderRelease,
  escrowFinished,
  withdrawalApproved,
  withdrawalDone,
  withdrawalFailed,
  refundTotal,
  refundPartial,
  partialRefundSplit,
  chargebackAfterRelease,
} from './domain/postings'
export {
  PLATFORM_ACCOUNT_CODES,
  DEV_ACCOUNT_CODES,
  normalSide,
  platformAccount,
  devAccount,
  accountKey,
} from './domain/accounts'
export type { LedgerAccountCode, LedgerAccountRef, Direction } from './domain/accounts'
export { LedgerError, assertBalanced, newTx, totals } from './domain/transaction'
export type { LedgerTx, LedgerLine, LedgerTxKind, LedgerErrorCode } from './domain/transaction'
export type { LedgerTxState, PostResult } from './infra/ledger-repository'
