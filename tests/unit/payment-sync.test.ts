import { readFileSync } from 'node:fs'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  canAdvanceSplit,
  canAdvanceStatus,
  isPaidStatus,
  planPaymentSync,
  type Charge,
  type ChargeStatus,
  type SplitStatus,
} from '@/modules/payments'
import { errorText, isLastAttempt, MAX_ATTEMPTS } from '@/modules/webhooks/domain/policy'

const charge = (over: Partial<Charge> = {}): Charge => ({
  providerPaymentId: 'pay_1',
  orderId: 'order-1',
  method: 'pix',
  status: 'pending',
  grossCents: 10_000n,
  netCents: 9_901n,
  devWalletId: 'wallet-1',
  devAmountCents: 8_500n,
  splitStatus: 'pending',
  checkoutUrl: null,
  pix: null,
  createdAt: new Date('2026-10-26T10:00:00Z'),
  paidAt: null,
  ...over,
})

interface Stored {
  orderId: string
  status: ChargeStatus
  splitStatus: SplitStatus
  grossCents: bigint
  devAmountCents: bigint
  devWalletId: string
  netCents: bigint | null
  escrowId: string | null
  confirmedAt: Date | null
}

const fresh = (): Stored => ({
  orderId: 'order-1',
  status: 'pending',
  splitStatus: 'pending',
  grossCents: 10_000n,
  devAmountCents: 8_500n,
  devWalletId: 'wallet-1',
  netCents: 9_901n,
  escrowId: null,
  confirmedAt: null,
})

/** Aplica o plano como o `applyPaymentEvent` faz (mesma ordem de campos). */
function step(stored: Stored, c: Charge) {
  const plan = planPaymentSync(stored, c)
  const next: Stored = {
    ...stored,
    status: plan.status,
    splitStatus: plan.splitStatus,
    netCents: plan.netCents,
    confirmedAt: plan.firstPaid ? (c.paidAt ?? new Date('2026-10-26T10:05:00Z')) : stored.confirmedAt,
  }
  return { next, plan }
}

describe('planPaymentSync: regras', () => {
  it('só avança; nunca volta', () => {
    expect(canAdvanceStatus('pending', 'received')).toBe(true)
    expect(canAdvanceStatus('received', 'pending')).toBe(false)
    expect(canAdvanceStatus('confirmed', 'received')).toBe(true)
    expect(canAdvanceStatus('received', 'confirmed')).toBe(false)
    expect(canAdvanceStatus('refunded', 'received')).toBe(false)
    expect(canAdvanceStatus('received', 'received')).toBe(false)
    expect(canAdvanceSplit('done', 'pending')).toBe(false)
    expect(canAdvanceSplit('pending', 'done')).toBe(true)
  })

  it('só cobrança pendente vence ou é apagada; paga nunca vira overdue', () => {
    expect(canAdvanceStatus('pending', 'overdue')).toBe(true)
    expect(canAdvanceStatus('pending', 'deleted')).toBe(true)
    expect(canAdvanceStatus('received', 'overdue')).toBe(false)
    expect(canAdvanceStatus('overdue', 'received')).toBe(false)
    expect(canAdvanceStatus('deleted', 'confirmed')).toBe(false)
  })

  it('pagamento visto pela primeira vez marca firstPaid; repetido não', () => {
    const paid = charge({ status: 'received', splitStatus: 'done', paidAt: new Date('2026-10-26T10:01:00Z') })
    const first = step(fresh(), paid)
    expect(first.plan.firstPaid).toBe(true)
    const again = step(first.next, paid)
    expect(again.plan.firstPaid).toBe(false)
    expect(again.plan.changed).toBe(false)
  })

  it('o líquido fica fixo depois da confirmação, mesmo que o gateway recalcule', () => {
    const paid = charge({ status: 'received', netCents: 9_901n, paidAt: new Date() })
    const first = step(fresh(), paid)
    const later = step(first.next, { ...paid, netCents: 9_000n })
    expect(later.next.netCents).toBe(9_901n)
  })

  it('antes de confirmar, o líquido acompanha a estimativa do gateway', () => {
    const plan = planPaymentSync(fresh(), charge({ netCents: 9_800n }))
    expect(plan.netCents).toBe(9_800n)
    expect(plan.firstPaid).toBe(false)
  })

  it('vencimento de cobrança pendente cancela; estorno depois de pago não', () => {
    expect(planPaymentSync(fresh(), charge({ status: 'overdue' })).cancelled).toBe(true)
    expect(planPaymentSync(fresh(), charge({ status: 'deleted' })).cancelled).toBe(true)
    const paid = step(fresh(), charge({ status: 'received', paidAt: new Date() })).next
    expect(planPaymentSync(paid, charge({ status: 'refunded' })).cancelled).toBe(false)
  })

  it('valor ou split diferente do gravado vira divergência, sem corrigir sozinho', () => {
    const plan = planPaymentSync(fresh(), charge({ grossCents: 10_100n, devAmountCents: 8_000n }))
    expect(plan.mismatches).toEqual(['gross_cents', 'dev_amount_cents'])
  })

  it('cobrança já estornada na primeira leitura conta como paga (o ledger precisa do lançamento)', () => {
    expect(isPaidStatus('refunded')).toBe(true)
    expect(isPaidStatus('chargeback')).toBe(true)
    expect(isPaidStatus('overdue')).toBe(false)
    expect(isPaidStatus('pending')).toBe(false)
    const first = planPaymentSync(fresh(), charge({ status: 'refunded', paidAt: new Date() }))
    expect(first.firstPaid).toBe(true)
  })
})

describe('planPaymentSync: pago depois de cancelado (B2)', () => {
  const cancelled = (status: 'overdue' | 'deleted'): Stored => ({ ...fresh(), status })

  it.each([
    ['overdue', 'confirmed'],
    ['overdue', 'received'],
    ['overdue', 'refunded'],
    ['deleted', 'confirmed'],
    ['deleted', 'received'],
    ['deleted', 'chargeback'],
  ] as const)('gravado %s e pago no gateway (%s) vira paidAfterCancel, sem firstPaid nem avanço de status', (stored, gateway) => {
    const plan = planPaymentSync(cancelled(stored), charge({ status: gateway, paidAt: new Date() }))
    expect(plan.paidAfterCancel).toBe(true)
    expect(plan.status).toBe(stored)
    expect(plan.cancelled).toBe(false)
  })

  it('cobrança pendente que paga, ou vencida que continua vencida, não é paidAfterCancel', () => {
    expect(planPaymentSync(fresh(), charge({ status: 'received', paidAt: new Date() })).paidAfterCancel).toBe(false)
    expect(planPaymentSync(cancelled('overdue'), charge({ status: 'overdue' })).paidAfterCancel).toBe(false)
    expect(planPaymentSync(cancelled('overdue'), charge({ status: 'deleted' })).paidAfterCancel).toBe(false)
  })
})

describe('planPaymentSync: divergência de valores falha fechado (B3)', () => {
  it.each([
    ['bruto', { grossCents: 10_001n }, ['gross_cents']],
    ['parte do dev', { devAmountCents: 8_501n }, ['dev_amount_cents']],
    ['carteira', { devWalletId: 'wallet-outra' }, ['dev_wallet_id']],
    ['os três', { grossCents: 1n, devAmountCents: 1n, devWalletId: 'x' }, ['gross_cents', 'dev_amount_cents', 'dev_wallet_id']],
  ] as const)('%s diferente do gravado', (_name, patch, expected) => {
    const plan = planPaymentSync(fresh(), charge({ status: 'received', paidAt: new Date(), ...patch }))
    expect(plan.mismatches).toEqual(expected)
  })

  it('valores iguais não geram divergência', () => {
    expect(planPaymentSync(fresh(), charge({ status: 'received', paidAt: new Date() })).mismatches).toEqual([])
  })
})

// Vida possível de uma cobrança no gateway; cada lista é a sequência de estados que ela atravessa.
const t = (n: number) => new Date(Date.UTC(2026, 9, 26, 10, n))
const LIFECYCLES: Charge[][] = [
  [
    charge(),
    charge({ status: 'received', paidAt: t(1) }),
    charge({ status: 'received', splitStatus: 'done', paidAt: t(1) }),
  ],
  [
    charge({ method: 'card' }),
    charge({ method: 'card', status: 'confirmed', paidAt: t(1) }),
    charge({ method: 'card', status: 'confirmed', splitStatus: 'done', paidAt: t(1) }),
    charge({ method: 'card', status: 'received', splitStatus: 'done', paidAt: t(1) }),
    charge({ method: 'card', status: 'refunded', splitStatus: 'done', paidAt: t(1) }),
  ],
  [charge(), charge({ status: 'overdue' })],
  [charge(), charge({ status: 'deleted' })],
  [
    charge({ method: 'card' }),
    charge({ method: 'card', status: 'confirmed', splitStatus: 'blocked', paidAt: t(1) }),
    charge({ method: 'card', status: 'chargeback', splitStatus: 'blocked', paidAt: t(1) }),
  ],
]

describe('planPaymentSync: propriedades (qualquer ordem e repetição chega ao mesmo estado)', () => {
  it('entregas em ordem qualquer, com repetição, terminando no estado atual do gateway, convergem e pagam uma vez', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: LIFECYCLES.length - 1 }),
        fc.array(fc.nat(), { maxLength: 25 }),
        (which, picks) => {
          const life = LIFECYCLES[which]!
          const final = life[life.length - 1]!
          // Leituras atrasadas (qualquer ponto da vida) e, no fim, a leitura do estado atual.
          const reads = [...picks.map((n) => life[n % life.length]!), final]
          let stored = fresh()
          let paidCount = 0
          let cancelCount = 0
          for (const read of reads) {
            const { next, plan } = step(stored, read)
            if (plan.firstPaid) paidCount++
            if (plan.cancelled) cancelCount++
            stored = next
          }
          expect(stored.status).toBe(final.status)
          expect(stored.splitStatus).toBe(final.splitStatus)
          expect(paidCount).toBe(isPaidStatus(final.status) ? 1 : 0)
          expect(cancelCount).toBeLessThanOrEqual(1)
          expect(cancelCount).toBe(final.status === 'overdue' || final.status === 'deleted' ? 1 : 0)
          // Depois de confirmado, o líquido nunca muda.
          if (stored.confirmedAt) expect(stored.netCents).toBe(9_901n)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('reaplicar o mesmo estado é um no-op', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: LIFECYCLES.length - 1 }),
        fc.nat({ max: 10 }),
        (which, repeats) => {
          const life = LIFECYCLES[which]!
          const final = life[life.length - 1]!
          let stored = fresh()
          stored = step(stored, final).next
          for (let i = 0; i < repeats; i++) {
            const { next, plan } = step(stored, final)
            expect(plan.firstPaid).toBe(false)
            expect(plan.cancelled).toBe(false)
            expect(plan.changed).toBe(false)
            stored = next
          }
        },
      ),
    )
  })
})

describe('política da caixa de entrada', () => {
  it('a 10ª tentativa é a última', () => {
    expect(isLastAttempt(MAX_ATTEMPTS - 1)).toBe(false)
    expect(isLastAttempt(MAX_ATTEMPTS)).toBe(true)
    expect(MAX_ATTEMPTS).toBe(10)
  })

  it('o texto de erro gravado é truncado', () => {
    expect(errorText(new Error('x'.repeat(2000))).length).toBeLessThanOrEqual(500)
    expect(errorText('falhou')).toBe('falhou')
  })

  it('o job de processamento tenta MAX_ATTEMPTS vezes (retries = MAX_ATTEMPTS - 1)', () => {
    const source = readFileSync('src/jobs/webhooks.ts', 'utf8')
    const retries = Number(/retries:\s*(\d+)/.exec(source)?.[1])
    expect(retries).toBe(MAX_ATTEMPTS - 1)
  })
})

describe('planPaymentSync: conferências da confirmação (L4)', () => {
  const paid = (over: Partial<Charge> = {}) => charge({ status: 'received', paidAt: new Date(), ...over })

  it('cobrança de outro pedido (externalReference) falha fechado', () => {
    expect(planPaymentSync(fresh(), paid({ orderId: 'order-OUTRO' })).mismatches).toEqual(['order_id'])
    expect(planPaymentSync(fresh(), paid()).mismatches).toEqual([])
  })

  it('carteira diferente da gravada falha fechado', () => {
    expect(planPaymentSync(fresh(), paid({ devWalletId: 'wallet-outra' })).mismatches).toEqual(['dev_wallet_id'])
  })

  it('parte do dev maior que o líquido real na primeira confirmação sinaliza splitExceedsNet', () => {
    const stored = { ...fresh(), devAmountCents: 9_950n }
    expect(planPaymentSync(stored, paid({ devAmountCents: 9_950n, netCents: 9_901n })).splitExceedsNet).toBe(true)
    // D = líquido cabe (D ≤ net).
    expect(planPaymentSync(stored, paid({ devAmountCents: 9_950n, netCents: 9_950n })).splitExceedsNet).toBe(false)
    // Ainda pendente: é estimativa, não há confirmação para barrar.
    expect(planPaymentSync(stored, charge({ devAmountCents: 9_950n, netCents: 9_901n })).splitExceedsNet).toBe(false)
  })

  it('depois de confirmada, o líquido fica o gravado e splitExceedsNet não reaparece', () => {
    const confirmed = { ...fresh(), status: 'received' as const, confirmedAt: new Date() }
    expect(planPaymentSync(confirmed, paid({ netCents: 1n })).splitExceedsNet).toBe(false)
  })
})
