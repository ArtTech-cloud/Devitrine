import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { splitAmount } from '@/lib/money'
import { accountKey, normalSide } from '@/modules/ledger/domain/accounts'
import {
  chargebackAfterRelease,
  escrowFinished,
  orderRelease,
  partialRefundSplit,
  paymentConfirmed,
  refundPartial,
  refundTotal,
  withdrawalApproved,
  withdrawalDone,
  withdrawalFailed,
} from '@/modules/ledger/domain/postings'
import {
  assertBalanced,
  LedgerError,
  newTx,
  totals,
  type LedgerTx,
} from '@/modules/ledger/domain/transaction'
import { devAccount, platformAccount } from '@/modules/ledger/domain/accounts'

const DEV = '0192f1e0-0000-7000-8000-000000000001'
const ORDER = '0192f1e0-0000-7000-8000-0000000000aa'

/** Livro-razão em memória com a mesma regra de saldo do banco (lado normal da conta). */
function balances(txs: LedgerTx[]): Map<string, bigint> {
  const out = new Map<string, bigint>()
  for (const tx of txs) {
    for (const l of tx.lines) {
      const key = accountKey(l.account)
      const sign = l.direction === normalSide(l.account.code) ? 1n : -1n
      out.set(key, (out.get(key) ?? 0n) + sign * l.amountCents)
    }
  }
  return out
}
const bal = (m: Map<string, bigint>, key: string) => m.get(key) ?? 0n

const gross = fc.bigInt({ min: 100n, max: 10_000_000n })
const feeBps = fc.integer({ min: 0, max: 5000 })

describe('assertBalanced / newTx', () => {
  it('recusa lote que não fecha, com menos de 2 linhas ou valor não positivo', () => {
    const line = (amountCents: bigint, direction: 'debit' | 'credit') => ({
      account: platformAccount('gateway_cash'),
      direction,
      amountCents,
    })
    const base = { kind: 'payment_confirmed' as const, idempotencyKey: 'k', orderId: null }
    expect(() => newTx({ ...base, lines: [line(10n, 'debit'), line(9n, 'credit')] })).toThrow(LedgerError)
    expect(() => newTx({ ...base, lines: [line(10n, 'debit')] })).toThrow(LedgerError)
    expect(() => newTx({ ...base, lines: [line(0n, 'debit'), line(0n, 'credit')] })).toThrow(LedgerError)
    expect(() => newTx({ ...base, lines: [line(-5n, 'debit'), line(-5n, 'credit')] })).toThrow(LedgerError)
    expect(() => newTx({ ...base, lines: [line(10n, 'debit'), line(10n, 'credit')] })).not.toThrow()
  })

  it('o código do erro distingue lote desbalanceado de linha inválida', () => {
    const base = { kind: 'payment_confirmed' as const, idempotencyKey: 'k', orderId: null }
    const l = (a: bigint, d: 'debit' | 'credit') => ({ account: platformAccount('gateway_cash'), direction: d, amountCents: a })
    try {
      newTx({ ...base, lines: [l(10n, 'debit'), l(9n, 'credit')] })
      expect.unreachable()
    } catch (e) {
      expect((e as LedgerError).code).toBe('unbalanced')
    }
    try {
      newTx({ ...base, lines: [l(0n, 'debit'), l(0n, 'credit')] })
      expect.unreachable()
    } catch (e) {
      expect((e as LedgerError).code).toBe('invalid_line')
    }
  })
})

describe('lançamentos da SPEC §6', () => {
  it('pagamento confirmado: caixa líquido + taxa = escrow bruto', () => {
    const tx = paymentConfirmed({ idempotencyKey: 'p', orderId: ORDER, grossCents: 10_000n, netCents: 9_700n })
    const b = balances([tx])
    expect(bal(b, 'gateway_cash')).toBe(9_700n)
    expect(bal(b, 'gateway_fees')).toBe(300n)
    expect(bal(b, 'escrow_liability')).toBe(10_000n)
  })

  it('sem taxa do gateway omite a linha de taxa e continua fechando', () => {
    const tx = paymentConfirmed({ idempotencyKey: 'p', orderId: ORDER, grossCents: 5_000n, netCents: 5_000n })
    expect(tx.lines).toHaveLength(2)
    expect(() => assertBalanced(tx.lines)).not.toThrow()
  })

  it('liberação + garantia encerrada: escrow zera e o dev fica com D disponível', () => {
    const G = 10_000n
    const { platformFeeCents, devAmountCents: D } = splitAmount(G, 1500)
    const txs = [
      paymentConfirmed({ idempotencyKey: 'a', orderId: ORDER, grossCents: G, netCents: 9_800n }),
      orderRelease({ idempotencyKey: 'b', orderId: ORDER, devId: DEV, grossCents: G, devAmountCents: D }),
      escrowFinished({ idempotencyKey: 'c', orderId: ORDER, devId: DEV, devAmountCents: D }),
    ]
    const b = balances(txs)
    expect(bal(b, 'escrow_liability')).toBe(0n)
    expect(bal(b, `dev_payable:${DEV}`)).toBe(0n)
    expect(bal(b, `dev_available:${DEV}`)).toBe(D)
    expect(bal(b, 'platform_revenue')).toBe(platformFeeCents)
  })

  it('reembolso total zera o escrow e devolve o caixa', () => {
    const txs = [
      paymentConfirmed({ idempotencyKey: 'a', orderId: ORDER, grossCents: 7_000n, netCents: 6_900n }),
      refundTotal({ idempotencyKey: 'r', orderId: ORDER, grossCents: 7_000n }),
    ]
    const b = balances(txs)
    expect(bal(b, 'escrow_liability')).toBe(0n)
    expect(bal(b, 'gateway_cash')).toBe(6_900n - 7_000n) // a taxa do gateway não volta (assumido)
  })

  it('reembolso parcial: R + D′ + P′ = G e escrow zera', () => {
    const G = 10_000n
    const R = 4_000n
    const { devPayableCents, platformRevenueCents } = partialRefundSplit(G, R, 1500)
    expect(R + devPayableCents + platformRevenueCents).toBe(G)
    const txs = [
      paymentConfirmed({ idempotencyKey: 'a', orderId: ORDER, grossCents: G, netCents: 9_800n }),
      refundPartial({
        idempotencyKey: 'r',
        orderId: ORDER,
        devId: DEV,
        grossCents: G,
        refundCents: R,
        devPayableCents,
        platformRevenueCents,
      }),
    ]
    expect(bal(balances(txs), 'escrow_liability')).toBe(0n)
  })

  it('reembolso parcial com R + D′ + P′ ≠ G é recusado', () => {
    expect(() =>
      refundPartial({
        idempotencyKey: 'r',
        orderId: ORDER,
        devId: DEV,
        grossCents: 10_000n,
        refundCents: 4_000n,
        devPayableCents: 5_000n,
        platformRevenueCents: 999n,
      }),
    ).toThrow(LedgerError)
  })

  it('chargeback depois da liberação deixa o dev devendo D (dev_receivable)', () => {
    const G = 10_000n
    const D = 8_500n
    const txs = [
      paymentConfirmed({ idempotencyKey: 'a', orderId: ORDER, grossCents: G, netCents: 9_800n }),
      orderRelease({ idempotencyKey: 'b', orderId: ORDER, devId: DEV, grossCents: G, devAmountCents: D }),
      escrowFinished({ idempotencyKey: 'c', orderId: ORDER, devId: DEV, devAmountCents: D }),
      chargebackAfterRelease({ idempotencyKey: 'd', orderId: ORDER, devId: DEV, grossCents: G, devAmountCents: D }),
    ]
    const b = balances(txs)
    expect(bal(b, `dev_receivable:${DEV}`)).toBe(D)
    expect(bal(b, 'platform_revenue')).toBe(0n)
    expect(bal(b, 'gateway_cash')).toBe(9_800n - G)
  })

  it('ciclo de saque: aprovado tira do disponível; concluído sai do caixa; falho devolve', () => {
    const W = 3_000n
    const base = [
      escrowFinished({ idempotencyKey: 'c', orderId: ORDER, devId: DEV, devAmountCents: 8_500n }),
    ]
    const approved = withdrawalApproved({ idempotencyKey: 'w1', orderId: null, devId: DEV, amountCents: W })
    const b1 = balances([...base, approved])
    expect(bal(b1, `dev_available:${DEV}`)).toBe(8_500n - W)
    expect(bal(b1, `dev_withdrawal_pending:${DEV}`)).toBe(W)
    const done = balances([
      ...base,
      approved,
      withdrawalDone({ idempotencyKey: 'w2', orderId: null, devId: DEV, amountCents: W }),
    ])
    expect(bal(done, `dev_withdrawal_pending:${DEV}`)).toBe(0n)
    const failed = balances([
      ...base,
      approved,
      withdrawalFailed({ idempotencyKey: 'w3', orderId: null, devId: DEV, amountCents: W }),
    ])
    expect(bal(failed, `dev_available:${DEV}`)).toBe(8_500n)
    expect(bal(failed, `dev_withdrawal_pending:${DEV}`)).toBe(0n)
  })

  it('recusa valores inválidos nos construtores', () => {
    expect(() => paymentConfirmed({ idempotencyKey: 'x', orderId: null, grossCents: 0n, netCents: 0n })).toThrow(LedgerError)
    expect(() => paymentConfirmed({ idempotencyKey: 'x', orderId: null, grossCents: 100n, netCents: 101n })).toThrow(LedgerError)
    expect(() => orderRelease({ idempotencyKey: 'x', orderId: null, devId: DEV, grossCents: 100n, devAmountCents: 101n })).toThrow(LedgerError)
    expect(() => withdrawalApproved({ idempotencyKey: 'x', orderId: null, devId: DEV, amountCents: 0n })).toThrow(LedgerError)
    expect(() => partialRefundSplit(100n, 100n, 1000)).toThrow(LedgerError)
  })

  it('conta de dev exige dono; conta da plataforma não aceita dono', () => {
    expect(devAccount('dev_available', DEV)).toEqual({ code: 'dev_available', ownerId: DEV })
    expect(platformAccount('escrow_liability')).toEqual({ code: 'escrow_liability' })
  })
})

describe('propriedades (fast-check): débitos = créditos em qualquer sequência', () => {
  it('todo lançamento gerado fecha', () => {
    fc.assert(
      fc.property(gross, feeBps, fc.integer({ min: 0, max: 600 }), (G, bps, gatewayFeeBps) => {
        const fee = (G * BigInt(gatewayFeeBps)) / 10_000n
        const { devAmountCents: D } = splitAmount(G, bps)
        if (D <= 0n) return true
        const txs = [
          paymentConfirmed({ idempotencyKey: 'a', orderId: ORDER, grossCents: G, netCents: G - fee }),
          orderRelease({ idempotencyKey: 'b', orderId: ORDER, devId: DEV, grossCents: G, devAmountCents: D }),
          escrowFinished({ idempotencyKey: 'c', orderId: ORDER, devId: DEV, devAmountCents: D }),
          withdrawalApproved({ idempotencyKey: 'd', orderId: null, devId: DEV, amountCents: D }),
          withdrawalDone({ idempotencyKey: 'e', orderId: null, devId: DEV, amountCents: D }),
        ]
        for (const tx of txs) {
          const t = totals(tx.lines)
          expect(t.debits).toBe(t.credits)
        }
        return true
      }),
    )
  })

  it('pagar → liberar → encerrar garantia: escrow zera e o dev fica com exatamente D', () => {
    fc.assert(
      fc.property(gross, feeBps, (G, bps) => {
        const { devAmountCents: D, platformFeeCents: P } = splitAmount(G, bps)
        if (D <= 0n) return true
        const b = balances([
          paymentConfirmed({ idempotencyKey: 'a', orderId: ORDER, grossCents: G, netCents: G - 1n }),
          orderRelease({ idempotencyKey: 'b', orderId: ORDER, devId: DEV, grossCents: G, devAmountCents: D }),
          escrowFinished({ idempotencyKey: 'c', orderId: ORDER, devId: DEV, devAmountCents: D }),
        ])
        expect(bal(b, 'escrow_liability')).toBe(0n)
        expect(bal(b, `dev_available:${DEV}`)).toBe(D)
        expect(bal(b, 'platform_revenue')).toBe(P)
        expect(D + P).toBe(G)
        return true
      }),
    )
  })

  it('reembolso parcial: R + D′ + P′ = G para qualquer R válido', () => {
    fc.assert(
      fc.property(gross, feeBps, fc.bigInt({ min: 0n, max: 10_000_000n }), (G, bps, seed) => {
        const R = 1n + (seed % (G - 1n))
        const { devPayableCents: Dp, platformRevenueCents: Pp } = partialRefundSplit(G, R, bps)
        expect(R + Dp + Pp).toBe(G)
        const tx = refundPartial({
          idempotencyKey: 'r',
          orderId: ORDER,
          devId: DEV,
          grossCents: G,
          refundCents: R,
          devPayableCents: Dp,
          platformRevenueCents: Pp,
        })
        const t = totals(tx.lines)
        expect(t.debits).toBe(t.credits)
        return true
      }),
    )
  })

  it('saque nunca deixa o disponível negativo no modelo em que só se saca o que há', () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 1n, max: 50_000n }), { minLength: 1, maxLength: 20 }), (withdrawals) => {
        const txs: LedgerTx[] = [
          escrowFinished({ idempotencyKey: 'seed', orderId: ORDER, devId: DEV, devAmountCents: 100_000n }),
        ]
        let available = 100_000n
        withdrawals.forEach((w, i) => {
          if (w > available) return // o webhook de validação recusaria
          txs.push(withdrawalApproved({ idempotencyKey: `w${i}`, orderId: null, devId: DEV, amountCents: w }))
          available -= w
        })
        const b = balances(txs)
        expect(bal(b, `dev_available:${DEV}`)).toBe(available)
        expect(available >= 0n).toBe(true)
        return true
      }),
    )
  })
})
