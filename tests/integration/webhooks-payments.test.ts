import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import type { OrderPaymentEffects, PaymentAlert } from '@/modules/payments'
import type { WebhookDeps } from '@/modules/webhooks'
import { FakeRecipientGateway } from '@/modules/accounts/infra/fake-recipient-gateway'
import { FakePaymentProvider, type FakeWebhookBody } from '@/modules/payments/infra/fake-payment-provider'
import { asService, createUser, DATABASE_URL } from './harness'

process.env.DATABASE_URL ??= DATABASE_URL
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-key'

const { createOrderCharge, paymentConfirmedKey, PaymentProviderError, reconcilePayments } = await import(
  '@/modules/payments'
)
const {
  createAuthFailureThrottle,
  handleWebhookRequest,
  MAX_ATTEMPTS,
  processWebhookEvent,
  receiveWebhook,
  reprocessWebhook,
  sweepStuckWebhooks,
  WebhookDeadError,
} = await import('@/modules/webhooks')
const { isAdminUser } = await import('@/lib/auth/admin')
const { isUuidV7 } = await import('@/lib/ids')
const { logger } = await import('@/lib/logger')
const { withProviderTimeout } = await import('@/modules/payments/infra/timeout-payment-provider')
const { schema } = await import('@/lib/db')
const { paymentConfirmed, postLedgerTx } = await import('@/modules/ledger')

const customer = { name: 'Cliente Teste', cpfCnpj: '12345678909', email: 'cliente@example.com' }

/** Efeito no pedido de mentira: grava as chamadas e pode ser mandado falhar. */
class RecordingOrders implements OrderPaymentEffects {
  confirmed: string[] = []
  cancelled: string[] = []
  failWith: Error | null = null
  async onPaymentConfirmed(_db: unknown, input: { orderId: string }) {
    if (this.failWith) throw this.failWith
    this.confirmed.push(input.orderId)
  }
  async onPaymentCancelled(_db: unknown, input: { orderId: string }) {
    if (this.failWith) throw this.failWith
    this.cancelled.push(input.orderId)
  }
}

function setup(opts: { enqueueFails?: boolean; createDelayMs?: number } = {}) {
  const provider = new FakePaymentProvider(new FakeRecipientGateway(), { createDelayMs: opts.createDelayMs })
  const orders = new RecordingOrders()
  const alerts: PaymentAlert[] = []
  const queue: string[] = []
  const state = { enqueueFails: opts.enqueueFails ?? false }
  const clock = { now: 1_000_000 }
  const deps: WebhookDeps = {
    provider,
    orders,
    alert: (a) => alerts.push(a),
    enqueue: async (ids) => {
      if (state.enqueueFails) throw new Error('fila fora do ar')
      queue.push(...ids)
    },
    run: (fn) => asService(fn),
    isAdmin: isAdminUser,
    authFailures: createAuthFailureThrottle(60_000, () => clock.now),
  }
  return { provider, orders, alerts, queue, state, clock, deps }
}
type Ctx = ReturnType<typeof setup>

async function newCharge(ctx: Ctx, over: { method?: 'pix' | 'card'; grossCents?: bigint; devAmountCents?: bigint } = {}) {
  const dev = await createUser({ signupRole: 'dev' })
  const orderId = randomUUID()
  const input = {
    orderId,
    devId: dev.id,
    customer,
    method: over.method ?? ('pix' as const),
    grossCents: over.grossCents ?? 10_000n,
    devWalletId: `wallet-${dev.id}`,
    devAmountCents: over.devAmountCents ?? 8_500n,
    idempotencyKey: `charge-${orderId}`,
  }
  const result = await asService((db) => createOrderCharge(db, ctx.provider, input, ctx.deps.alert))
  return { dev, orderId, input, ...result }
}

const deliver = (ctx: Ctx, event: FakeWebhookBody, token?: string | null) => {
  const d = ctx.provider.delivery(event, token)
  return receiveWebhook(d.rawBody, d.headers, ctx.deps)
}

/** Processa tudo que está na fila, como o Inngest faria; falhas ficam para o teste conferir. */
async function drain(ctx: Ctx): Promise<unknown[]> {
  const errors: unknown[] = []
  while (ctx.queue.length > 0) {
    const id = ctx.queue.shift()!
    try {
      await processWebhookEvent(id, ctx.deps)
    } catch (e) {
      errors.push(e)
    }
  }
  return errors
}

const ledgerTxCount = (key: string) =>
  asService(async (db) => {
    const r = await db.execute<{ n: number }>(
      sql`select count(*)::int n from public.ledger_transactions where idempotency_key = ${key}`,
    )
    return r[0]!.n
  })

const paymentRow = (providerPaymentId: string) =>
  asService(async (db) => {
    const r = await db.execute<{ status: string; split_status: string; confirmed_at: Date | null; net_cents: string | null }>(
      sql`select status, split_status, confirmed_at, net_cents::text from public.payments where provider = 'fake' and provider_payment_id = ${providerPaymentId}`,
    )
    return r[0]!
  })

const eventStatus = (id: string) =>
  asService(async (db) => {
    const r = await db.execute<{ status: string; attempts: number; last_error: string | null }>(
      sql`select status, attempts, last_error from public.webhook_event_status where id = ${id}::uuid`,
    )
    return r[0]!
  })

const eventIdOf = (ctx: Ctx, n = 0) => ctx.queue[n]!

const future = () => new Date(Date.now() + 3_600_000)
const mine = <T extends { providerPaymentId: string }>(ctx: Ctx, ds: T[]) =>
  ds.filter((d) => ctx.provider.charges.has(d.providerPaymentId))

describe('portão da Fase 2: pagamento com webhook entregue três vezes', () => {
  it('gera um único lançamento, o pedido é avisado uma vez e a conciliação não acusa divergência', async () => {
    const ctx = setup()
    const c = await newCharge(ctx)
    const events = ctx.provider.simulatePayment(c.charge.providerPaymentId)
    expect(events.map((e) => e.event)).toEqual(['PAYMENT_RECEIVED', 'PAYMENT_SPLIT_DONE'])

    for (const event of events) {
      for (let i = 0; i < 3; i++) expect((await deliver(ctx, event)).status).toBe(200)
    }
    // Duas linhas em `webhook_events` (uma por evento), apesar de seis entregas.
    const stored = await asService((db) =>
      db.execute<{ n: number }>(
        sql`select count(*)::int n from public.webhook_events where payload->'payment'->>'id' = ${c.charge.providerPaymentId}`,
      ),
    )
    expect(stored[0]!.n).toBe(2)

    expect(await drain(ctx)).toEqual([])
    const key = paymentConfirmedKey('fake', c.charge.providerPaymentId)
    expect(await ledgerTxCount(key)).toBe(1)
    expect(ctx.orders.confirmed).toEqual([c.orderId])
    const row = await paymentRow(c.charge.providerPaymentId)
    expect(row.status).toBe('received')
    expect(row.split_status).toBe('done')
    expect(row.net_cents).toBe('9901')

    const report = await asService((db) => reconcilePayments(db, ctx.provider, ctx.deps.alert, { now: future() }))
    expect(mine(ctx, report.divergences)).toEqual([])
    expect(report.chargesChecked).toBeGreaterThanOrEqual(1)
  })

  it('a conciliação grava a execução em reconciliation_runs', async () => {
    const ctx = setup()
    const report = await asService((db) => reconcilePayments(db, ctx.provider, ctx.deps.alert, { now: future() }))
    const r = await asService((db) =>
      db.execute<{ n: number }>(sql`select count(*)::int n from public.reconciliation_runs where id = ${report.runId}::uuid`),
    )
    expect(r[0]!.n).toBe(1)
  })

  it('o mesmo evento processado em paralelo gera um único efeito', async () => {
    const ctx = setup()
    const c = await newCharge(ctx)
    const [pay] = ctx.provider.simulatePayment(c.charge.providerPaymentId)
    await deliver(ctx, pay!)
    const id = eventIdOf(ctx)
    const results = await Promise.all([1, 2, 3].map(() => processWebhookEvent(id, ctx.deps)))
    expect(results.filter((r) => r === 'processed')).toHaveLength(1)
    expect(results.filter((r) => r === 'skipped')).toHaveLength(2)
    expect(await ledgerTxCount(paymentConfirmedKey('fake', c.charge.providerPaymentId))).toBe(1)
    expect(ctx.orders.confirmed).toHaveLength(1)
  })

  it('cartão: confirmado e depois recebido chega ao mesmo estado final, com um lançamento', async () => {
    const ctx = setup()
    const c = await newCharge(ctx, { method: 'card' })
    const events = ctx.provider.simulatePayment(c.charge.providerPaymentId)
    for (const e of events) await deliver(ctx, e)
    await drain(ctx)
    expect(await ledgerTxCount(paymentConfirmedKey('fake', c.charge.providerPaymentId))).toBe(1)
    expect((await paymentRow(c.charge.providerPaymentId)).status).toBe('confirmed')
  })
})

describe('webhook fora de ordem', () => {
  it('PAYMENT_SPLIT_DONE antes de PAYMENT_RECEIVED chega ao mesmo estado e a um único lançamento', async () => {
    const final = async (reverse: boolean) => {
      const ctx = setup()
      const c = await newCharge(ctx)
      const events = ctx.provider.simulatePayment(c.charge.providerPaymentId)
      for (const e of reverse ? [...events].reverse() : events) await deliver(ctx, e)
      expect(await drain(ctx)).toEqual([])
      expect(await ledgerTxCount(paymentConfirmedKey('fake', c.charge.providerPaymentId))).toBe(1)
      expect(ctx.orders.confirmed).toHaveLength(1)
      const row = await paymentRow(c.charge.providerPaymentId)
      return { status: row.status, split: row.split_status, net: row.net_cents }
    }
    expect(await final(true)).toEqual(await final(false))
  })
})

describe('autenticação e validação do endpoint', () => {
  const count = () =>
    asService(async (db) => (await db.execute<{ n: number }>(sql`select count(*)::int n from public.webhook_events`))[0]!.n)

  it('token inválido ou ausente retorna 401 e não grava nem enfileira nada', async () => {
    const ctx = setup()
    const c = await newCharge(ctx)
    const [pay] = ctx.provider.simulatePayment(c.charge.providerPaymentId)
    const before = await count()
    expect((await deliver(ctx, pay!, 'token-errado')).status).toBe(401)
    expect((await deliver(ctx, pay!, null)).status).toBe(401)
    expect(await count()).toBe(before)
    expect(ctx.queue).toEqual([])
  })

  it('corpo ilegível com token válido retorna 400; corpo acima de 1 MB retorna 413; nada é gravado', async () => {
    const ctx = setup()
    const before = await count()
    const headers = ctx.provider.delivery({ id: 'x', event: 'x', dateCreated: '' }).headers
    expect((await receiveWebhook('{não é json', headers, ctx.deps)).status).toBe(400)
    expect((await receiveWebhook(JSON.stringify({ foo: 1 }), headers, ctx.deps)).status).toBe(400)
    expect((await receiveWebhook('x'.repeat(1_000_001), headers, ctx.deps)).status).toBe(413)
    expect(await count()).toBe(before)
    expect(ctx.queue).toEqual([])
  })

  it('evento de tipo desconhecido é gravado e processado como ignorado, sem efeito', async () => {
    const ctx = setup()
    const event: FakeWebhookBody = { id: `evt_${randomUUID()}`, event: 'ACCOUNT_STATUS_QUALQUER', dateCreated: new Date().toISOString() }
    expect((await deliver(ctx, event)).status).toBe(200)
    const id = eventIdOf(ctx)
    expect(await drain(ctx)).toEqual([])
    expect((await eventStatus(id)).status).toBe('ignored')
  })
})

describe('reentrega, fila e varredura', () => {
  it('evento já concluído: 200 sem reprocessar e sem enfileirar de novo', async () => {
    const ctx = setup()
    const c = await newCharge(ctx)
    const [pay] = ctx.provider.simulatePayment(c.charge.providerPaymentId)
    await deliver(ctx, pay!)
    await drain(ctx)
    const again = await deliver(ctx, pay!)
    expect(again).toEqual({ status: 200, body: { ok: true, duplicate: true } })
    expect(ctx.queue).toEqual([])
  })

  it('falha ao enfileirar: 500 (o provedor reenvia) e a reentrega enfileira o evento já gravado', async () => {
    const ctx = setup({ enqueueFails: true })
    const c = await newCharge(ctx)
    const [pay] = ctx.provider.simulatePayment(c.charge.providerPaymentId)
    expect((await deliver(ctx, pay!)).status).toBe(500)
    expect(ctx.queue).toEqual([])
    ctx.state.enqueueFails = false
    const retry = await deliver(ctx, pay!)
    expect(retry.status).toBe(200)
    expect(ctx.queue).toHaveLength(1)
    await drain(ctx)
    expect(await ledgerTxCount(paymentConfirmedKey('fake', c.charge.providerPaymentId))).toBe(1)
  })

  it('evento gravado e não enfileirado é recolhido pela varredura (só depois da carência)', async () => {
    const ctx = setup({ enqueueFails: true })
    const c = await newCharge(ctx)
    const [pay] = ctx.provider.simulatePayment(c.charge.providerPaymentId)
    expect((await deliver(ctx, pay!)).status).toBe(500)
    ctx.state.enqueueFails = false

    // Recém-gravado: dentro da carência, a varredura não disputa com o envio normal.
    const [justStored] = await asService((db) =>
      db.execute<{ id: string }>(
        sql`select id from public.webhook_events where provider = 'fake' and payload->'payment'->>'id' = ${c.charge.providerPaymentId}`,
      ),
    )
    await sweepStuckWebhooks(ctx.deps)
    expect(ctx.queue).not.toContain(justStored!.id)

    // Um evento antigo parado em `received` é reenfileirado.
    const oldId = randomUUID()
    await asService((db) =>
      db.insert(schema.webhookEvents).values({
        id: oldId,
        provider: 'fake',
        eventId: `evt_old_${oldId}`,
        type: 'ignored',
        rawType: 'ALGUM_EVENTO',
        payload: {},
        receivedAt: new Date(Date.now() - 10 * 60_000),
      }),
    )
    const swept = await sweepStuckWebhooks(ctx.deps)
    expect(swept.requeued).toBeGreaterThanOrEqual(1)
    expect(ctx.queue).toContain(oldId)
    await drain(ctx)
    expect((await eventStatus(oldId)).status).toBe('ignored')
    // Concluído, deixa de ser recolhido.
    ctx.queue.length = 0
    await sweepStuckWebhooks(ctx.deps)
    expect(ctx.queue).not.toContain(oldId)
  })
})

describe('job que sempre falha', () => {
  it('termina em failed na 10ª tentativa, com alerta crítico e nenhum efeito parcial no ledger; o admin reprocessa', async () => {
    const ctx = setup()
    const c = await newCharge(ctx)
    const [pay] = ctx.provider.simulatePayment(c.charge.providerPaymentId)
    await deliver(ctx, pay!)
    const id = eventIdOf(ctx)
    ctx.queue.length = 0
    ctx.orders.failWith = new Error('orders indisponível')

    const errors: unknown[] = []
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const err = await processWebhookEvent(id, ctx.deps).catch((e: unknown) => e)
      errors.push(err)
      const status = await eventStatus(id)
      expect(status.attempts).toBe(i)
      expect(status.status).toBe(i < MAX_ATTEMPTS ? 'retrying' : 'failed')
    }
    expect(errors.slice(0, -1).every((e) => !(e instanceof WebhookDeadError))).toBe(true)
    expect(errors[MAX_ATTEMPTS - 1]).toBeInstanceOf(WebhookDeadError)
    expect((await eventStatus(id)).last_error).toContain('orders indisponível')

    // A transação desfez tudo: nem lançamento, nem pagamento confirmado.
    expect(await ledgerTxCount(paymentConfirmedKey('fake', c.charge.providerPaymentId))).toBe(0)
    expect((await paymentRow(c.charge.providerPaymentId)).confirmed_at).toBeNull()
    expect((await paymentRow(c.charge.providerPaymentId)).status).toBe('pending')
    const failed = ctx.alerts.filter((a) => a.code === 'webhook_failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]!.severity).toBe('critical')

    // Depois de `failed`, o job não tenta sozinho.
    expect(await processWebhookEvent(id, ctx.deps)).toBe('skipped')

    // Reprocesso manual: zera a contagem, audita e reenfileira.
    const admin = await createUser({ appRole: 'admin' })
    ctx.orders.failWith = null
    expect(await reprocessWebhook(id, admin.id, ctx.deps)).toBe('requeued')
    expect(ctx.queue).toEqual([id])
    expect((await eventStatus(id)).attempts).toBe(0)
    expect(await drain(ctx)).toEqual([])
    expect((await eventStatus(id)).status).toBe('processed')
    expect(await ledgerTxCount(paymentConfirmedKey('fake', c.charge.providerPaymentId))).toBe(1)
    expect(ctx.orders.confirmed).toEqual([c.orderId])
    const audit = await asService((db) =>
      db.execute<{ n: number }>(
        sql`select count(*)::int n from public.audit_log where action = 'webhook.reprocess' and entity_id = ${id} and actor_id = ${admin.id}::uuid`,
      ),
    )
    expect(audit[0]!.n).toBe(1)

    // Evento concluído não pode ser reprocessado (evita duplo efeito por clique).
    expect(await reprocessWebhook(id, admin.id, ctx.deps)).toBe('not_failed')
    expect(await reprocessWebhook(randomUUID(), admin.id, ctx.deps)).toBe('not_found')
  })

  it('cobrança ainda não gravada em payments é erro com retry, nunca descarte', async () => {
    const ctx = setup()
    // Cobrança existe no gateway, mas nunca passou por createOrderCharge (corrida com a criação).
    const raw = await ctx.provider.createCharge({
      orderId: randomUUID(),
      customer,
      method: 'pix',
      grossCents: 10_000n,
      devWalletId: 'wallet-x',
      devAmountCents: 8_500n,
      idempotencyKey: `k-${randomUUID()}`,
    })
    const [pay] = ctx.provider.simulatePayment(raw.providerPaymentId)
    await deliver(ctx, pay!)
    const id = eventIdOf(ctx)
    await expect(processWebhookEvent(id, ctx.deps)).rejects.toThrow()
    expect((await eventStatus(id)).status).toBe('retrying')
  })
})

describe('reembolso, chargeback e divergência de split', () => {
  it('estorno atualiza o status, alerta que o lançamento é da Fase 3 e a conciliação o aponta', async () => {
    const ctx = setup()
    const c = await newCharge(ctx)
    for (const e of ctx.provider.simulatePayment(c.charge.providerPaymentId)) await deliver(ctx, e)
    await drain(ctx)
    await ctx.provider.refund(c.charge.providerPaymentId, 'full', `refund-${randomUUID()}`)
    await deliver(ctx, ctx.provider.refundEvent(c.charge.providerPaymentId))
    expect(await drain(ctx)).toEqual([])
    expect((await paymentRow(c.charge.providerPaymentId)).status).toBe('refunded')
    expect(ctx.alerts.some((a) => a.code === 'reversal_not_booked')).toBe(true)
    // O lançamento do pagamento continua um só.
    expect(await ledgerTxCount(paymentConfirmedKey('fake', c.charge.providerPaymentId))).toBe(1)

    const report = await asService((db) => reconcilePayments(db, ctx.provider, ctx.deps.alert, { now: future() }))
    expect(mine(ctx, report.divergences).map((d) => d.kind)).toEqual(['unbooked_reversal'])
  })

  it('split acima do líquido: o gateway bloqueia, a confirmação falha fechado e há alerta crítico (L4)', async () => {
    const ctx = setup()
    // Parte do dev acima do líquido do Pix (9.901): o gateway bloqueia o split.
    const c = await newCharge(ctx, { devAmountCents: 9_950n })
    expect(ctx.alerts.some((a) => a.code === 'split_exceeds_net')).toBe(true)
    const before = ctx.alerts.length
    for (const e of ctx.provider.simulatePayment(c.charge.providerPaymentId)) await deliver(ctx, e)
    expect((await drain(ctx)).length).toBeGreaterThan(0)
    // Nada é confirmado nem lançado enquanto a parte do dev não couber no líquido (ADR-020 item 22).
    const row = await paymentRow(c.charge.providerPaymentId)
    expect(row.confirmed_at).toBeNull()
    expect(ctx.orders.confirmed).toEqual([])
    expect(await ledgerTxCount(paymentConfirmedKey('fake', c.charge.providerPaymentId))).toBe(0)
    expect(
      ctx.alerts.slice(before).some((a) => a.code === 'split_exceeds_net' && a.severity === 'critical'),
    ).toBe(true)
  })

  it('cobrança vencida cancela o pedido; repetir não cancela de novo', async () => {
    const ctx = setup()
    const c = await newCharge(ctx)
    const overdue = ctx.provider.simulateOverdue(c.charge.providerPaymentId)
    await deliver(ctx, overdue)
    await deliver(ctx, overdue)
    await drain(ctx)
    expect(ctx.orders.cancelled).toEqual([c.orderId])
    expect(ctx.orders.confirmed).toEqual([])
    expect(await ledgerTxCount(paymentConfirmedKey('fake', c.charge.providerPaymentId))).toBe(0)
  })
})

describe('createOrderCharge: idempotência', () => {
  it('mesma chave e mesmo pedido devolve a mesma cobrança sem criar outra no gateway', async () => {
    const ctx = setup()
    const c = await newCharge(ctx)
    const again = await asService((db) => createOrderCharge(db, ctx.provider, c.input, ctx.deps.alert))
    expect(again.replayed).toBe(true)
    expect(again.payment.id).toBe(c.payment.id)
    expect(again.charge.providerPaymentId).toBe(c.charge.providerPaymentId)
    expect(ctx.provider.calls.createCharge).toBe(1)
    const keys = await asService((db) =>
      db.execute<{ n: number; ref: string }>(
        sql`select count(*)::int n, max(result_ref) ref from public.idempotency_keys where scope = 'payments.create_charge' and key = ${c.input.idempotencyKey}`,
      ),
    )
    expect(keys[0]!.n).toBe(1)
    expect(keys[0]!.ref).toBe(c.charge.providerPaymentId)
  })

  it('mesma chave com valor diferente é conflito e nada é cobrado', async () => {
    const ctx = setup()
    const c = await newCharge(ctx)
    await expect(
      asService((db) => createOrderCharge(db, ctx.provider, { ...c.input, grossCents: 20_000n }, ctx.deps.alert)),
    ).rejects.toMatchObject({ code: 'idempotency_mismatch' })
    expect(ctx.provider.calls.createCharge).toBe(1)
  })

  it('chamadas simultâneas com a mesma chave criam uma única cobrança', async () => {
    const ctx = setup()
    const dev = await createUser({ signupRole: 'dev' })
    const orderId = randomUUID()
    const input = {
      orderId,
      devId: dev.id,
      customer,
      method: 'pix' as const,
      grossCents: 10_000n,
      devWalletId: 'wallet-c',
      devAmountCents: 8_500n,
      idempotencyKey: `charge-${orderId}`,
    }
    const results = await Promise.all(
      [1, 2, 3].map(() => asService((db) => createOrderCharge(db, ctx.provider, input, ctx.deps.alert))),
    )
    expect(new Set(results.map((r) => r.payment.id)).size).toBe(1)
    expect(results.filter((r) => !r.replayed)).toHaveLength(1)
    expect(ctx.provider.calls.createCharge).toBe(1)
  })

  it('o pedido não ganha uma segunda cobrança aberta, nem com outra chave', async () => {
    const ctx = setup()
    const c = await newCharge(ctx)
    await expect(
      asService((db) =>
        createOrderCharge(db, ctx.provider, { ...c.input, idempotencyKey: `outra-${randomUUID()}` }, ctx.deps.alert),
      ),
    ).rejects.toBeInstanceOf(PaymentProviderError)
    // E o índice único parcial segura mesmo que a checagem da aplicação seja contornada.
    await expect(
      asService((db) =>
        db.insert(schema.payments).values({
          id: randomUUID(),
          orderId: c.orderId,
          provider: 'fake',
          providerPaymentId: `dup-${randomUUID()}`,
          method: 'pix',
          status: 'pending',
          devId: c.dev.id,
          devWalletId: 'w',
          grossCents: 100n,
          devAmountCents: 50n,
        }),
      ),
    ).rejects.toThrow()
  })

  it('depois que a cobrança vence, o pedido pode ganhar uma nova', async () => {
    const ctx = setup()
    const c = await newCharge(ctx)
    await deliver(ctx, ctx.provider.simulateOverdue(c.charge.providerPaymentId))
    await drain(ctx)
    const second = await asService((db) =>
      createOrderCharge(db, ctx.provider, { ...c.input, idempotencyKey: `nova-${randomUUID()}` }, ctx.deps.alert),
    )
    expect(second.replayed).toBe(false)
    expect(second.charge.providerPaymentId).not.toBe(c.charge.providerPaymentId)
  })
})

describe('conciliação detecta divergências', () => {
  it('cobrança no gateway sem linha em payments', async () => {
    const ctx = setup()
    const raw = await ctx.provider.createCharge({
      orderId: randomUUID(),
      customer,
      method: 'pix',
      grossCents: 10_000n,
      devWalletId: 'w',
      devAmountCents: 8_500n,
      idempotencyKey: `k-${randomUUID()}`,
    })
    const report = await asService((db) => reconcilePayments(db, ctx.provider, ctx.deps.alert, { now: future() }))
    expect(mine(ctx, report.divergences)).toMatchObject([
      { kind: 'missing_payment_row', providerPaymentId: raw.providerPaymentId },
    ])
    expect(ctx.alerts.some((a) => a.code === 'reconciliation_missing_payment_row')).toBe(true)
  })

  it('linha em payments que o gateway não conhece', async () => {
    const ctx = setup()
    const dev = await createUser({ signupRole: 'dev' })
    const pid = `fantasma-${randomUUID()}`
    await asService((db) =>
      db.insert(schema.payments).values({
        id: randomUUID(),
        orderId: randomUUID(),
        provider: 'fake',
        providerPaymentId: pid,
        method: 'pix',
        status: 'pending',
        devId: dev.id,
        devWalletId: 'w',
        grossCents: 10_000n,
        devAmountCents: 8_500n,
      }),
    )
    const report = await asService((db) => reconcilePayments(db, ctx.provider, ctx.deps.alert, { now: future() }))
    expect(report.divergences).toContainEqual(expect.objectContaining({ kind: 'missing_at_provider', providerPaymentId: pid }))
  })

  it('pago no gateway, webhook nunca processado: status e lançamento divergem', async () => {
    const ctx = setup()
    const c = await newCharge(ctx)
    ctx.provider.simulatePayment(c.charge.providerPaymentId)
    const report = await asService((db) => reconcilePayments(db, ctx.provider, ctx.deps.alert, { now: future() }))
    const kinds = mine(ctx, report.divergences).map((d) => d.kind).sort()
    expect(kinds).toEqual(['ledger_missing', 'split_mismatch', 'status_mismatch'])
  })

  it('lançamento com valor diferente do esperado e pago sem lançamento', async () => {
    const ctx = setup()
    const c = await newCharge(ctx)
    for (const e of ctx.provider.simulatePayment(c.charge.providerPaymentId)) await deliver(ctx, e)
    await drain(ctx)

    // Outro pagamento já marcado como pago em payments, com um lançamento de valor errado sob a chave esperada.
    const other = await newCharge(ctx)
    ctx.provider.simulatePayment(other.charge.providerPaymentId)
    await asService((db) =>
      db.execute(
        sql`update public.payments set status = 'received', split_status = 'done', confirmed_at = now(), net_cents = 9901 where provider_payment_id = ${other.charge.providerPaymentId}`,
      ),
    )
    await asService((db) =>
      postLedgerTx(
        db,
        paymentConfirmed({
          idempotencyKey: paymentConfirmedKey('fake', other.charge.providerPaymentId),
          orderId: other.orderId,
          grossCents: 10_000n,
          netCents: 9_000n,
        }),
      ),
    )
    const report = await asService((db) => reconcilePayments(db, ctx.provider, ctx.deps.alert, { now: future() }))
    const bad = mine(ctx, report.divergences)
    expect(bad.map((d) => [d.kind, d.providerPaymentId])).toEqual([['ledger_mismatch', other.charge.providerPaymentId]])
  })
})

describe('append-only e acesso', () => {
  it('webhook_events, webhook_event_runs, idempotency_keys e reconciliation_runs não aceitam UPDATE, DELETE nem TRUNCATE', async () => {
    const ctx = setup()
    const c = await newCharge(ctx)
    const [pay] = ctx.provider.simulatePayment(c.charge.providerPaymentId)
    await deliver(ctx, pay!)
    await drain(ctx)
    await asService((db) => reconcilePayments(db, ctx.provider, ctx.deps.alert, { now: future() }))
    const statements = [
      'update public.webhook_events set type = type',
      'delete from public.webhook_events',
      'truncate public.webhook_events cascade',
      "update public.webhook_event_runs set outcome = 'processed'",
      'delete from public.webhook_event_runs',
      'truncate public.webhook_event_runs',
      'update public.idempotency_keys set result_ref = result_ref',
      'delete from public.idempotency_keys',
      'truncate public.idempotency_keys',
      'update public.reconciliation_runs set charges_checked = 0',
      'delete from public.reconciliation_runs',
      'truncate public.reconciliation_runs',
      'delete from public.payments',
    ]
    for (const statement of statements) {
      await expect(asService((db) => db.execute(sql.raw(statement))), statement).rejects.toThrow()
    }
  })

  it('o dinheiro do pagamento é bigint no banco e o status derivado não é gravável', async () => {
    const r = await asService((db) =>
      db.execute<{ t: string }>(
        sql`select data_type t from information_schema.columns where table_name = 'payments' and column_name = 'gross_cents'`,
      ),
    )
    expect(r[0]!.t).toBe('bigint')
    await expect(
      asService((db) => db.execute(sql`insert into public.webhook_event_status (id) values (gen_random_uuid())`)),
    ).rejects.toThrow()
  })
})

describe('B1: um pedido, uma cobrança, mesmo com chaves diferentes em paralelo', () => {
  it('duas chamadas simultâneas com chaves diferentes criam uma única cobrança no gateway', async () => {
    // A latência simulada abre a janela em que a checagem "já tem cobrança aberta" passaria nas duas chamadas.
    const ctx = setup({ createDelayMs: 150 })
    const dev = await createUser({ signupRole: 'dev' })
    const orderId = randomUUID()
    const base = {
      orderId,
      devId: dev.id,
      customer,
      method: 'pix' as const,
      grossCents: 10_000n,
      devWalletId: `wallet-${dev.id}`,
      devAmountCents: 8_500n,
    }
    const results = await Promise.allSettled(
      ['a', 'b'].map((k) =>
        asService((db) =>
          createOrderCharge(db, ctx.provider, { ...base, idempotencyKey: `k-${k}-${orderId}` }, ctx.deps.alert),
        ),
      ),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toBeInstanceOf(PaymentProviderError)
    expect(ctx.provider.calls.createCharge).toBe(1)
    const rows = await asService((db) =>
      db.execute<{ n: number }>(sql`select count(*)::int n from public.payments where order_id = ${orderId}::uuid`),
    )
    expect(rows[0]!.n).toBe(1)
  })
})

describe('B2: pago no gateway depois de vencer ou ser apagada', () => {
  it('alerta crítico paid_after_cancel, sem confirmar o pedido, sem lançar e sem mudar o status gravado', async () => {
    const ctx = setup()
    const c = await newCharge(ctx)
    await deliver(ctx, ctx.provider.simulateOverdue(c.charge.providerPaymentId))
    await drain(ctx)
    expect(ctx.orders.cancelled).toEqual([c.orderId])

    const late = ctx.provider.simulateLatePayment(c.charge.providerPaymentId)
    await deliver(ctx, late)
    expect(await drain(ctx)).toEqual([])

    const alert = ctx.alerts.find((a) => a.code === 'paid_after_cancel')
    expect(alert).toMatchObject({ severity: 'critical' })
    expect(ctx.orders.confirmed).toEqual([])
    expect(await ledgerTxCount(paymentConfirmedKey('fake', c.charge.providerPaymentId))).toBe(0)
    const row = await paymentRow(c.charge.providerPaymentId)
    expect(row.status).toBe('overdue')
    expect(row.confirmed_at).toBeNull()

    // A conciliação mantém o caso aberto até alguém decidir.
    const report = await asService((db) => reconcilePayments(db, ctx.provider, ctx.deps.alert, { now: future() }))
    expect(mine(ctx, report.divergences).map((d) => d.kind)).toEqual(['paid_after_cancel'])
  })
})

describe('B3 e M3: divergência de valores falha fechado', () => {
  it.each([
    ['bruto', { grossCents: 10_100n }],
    ['parte do dev', { devAmountCents: 9_000n }],
    ['carteira', { devWalletId: 'wallet-trocada' }],
  ] as const)(
    'webhook com %s diferente do gravado: sem lançamento, sem confirmação, evento em retry com alerta',
    async (_name, patch) => {
      const ctx = setup()
      const c = await newCharge(ctx)
      const events = ctx.provider.simulatePayment(c.charge.providerPaymentId)
      ctx.provider.tamper(c.charge.providerPaymentId, patch)
      await deliver(ctx, events[0]!)
      const id = eventIdOf(ctx)
      const errors = await drain(ctx)
      expect(errors).toHaveLength(1)
      expect(ctx.alerts.some((a) => a.code === 'charge_mismatch' && a.severity === 'critical')).toBe(true)
      expect(ctx.orders.confirmed).toEqual([])
      expect(await ledgerTxCount(paymentConfirmedKey('fake', c.charge.providerPaymentId))).toBe(0)
      const row = await paymentRow(c.charge.providerPaymentId)
      expect(row.status).toBe('pending')
      expect(row.confirmed_at).toBeNull()
      expect((await eventStatus(id)).status).toBe('retrying')
    },
  )

  it('o gateway cria a cobrança com valores diferentes do pedido: nada é gravado e o alerta leva o id da cobrança', async () => {
    const ctx = setup()
    const create = ctx.provider.createCharge.bind(ctx.provider)
    ctx.provider.createCharge = async (input) => ({ ...(await create(input)), grossCents: 100n })
    const dev = await createUser({ signupRole: 'dev' })
    const orderId = randomUUID()
    const key = `charge-${orderId}`
    await expect(
      asService((db) =>
        createOrderCharge(
          db,
          ctx.provider,
          {
            orderId,
            devId: dev.id,
            customer,
            method: 'pix',
            grossCents: 10_000n,
            devWalletId: 'wallet-m3',
            devAmountCents: 8_500n,
            idempotencyKey: key,
          },
          ctx.deps.alert,
        ),
      ),
    ).rejects.toBeInstanceOf(PaymentProviderError)
    const alert = ctx.alerts.find((a) => a.code === 'charge_created_mismatch')
    expect(alert).toMatchObject({ severity: 'critical' })
    expect(alert?.context).toMatchObject({ orderId, providerPaymentId: expect.any(String) })
    const counts = await asService((db) =>
      db.execute<{ p: number; k: number }>(
        sql`select (select count(*)::int from public.payments where order_id = ${orderId}::uuid) p,
                   (select count(*)::int from public.idempotency_keys where key = ${key}) k`,
      ),
    )
    expect(counts[0]).toEqual({ p: 0, k: 0 })
  })
})

describe('M1: falha tardia de um worker não reabre evento concluído', () => {
  it('o worker lento que falha depois de outro concluir o evento devolve skipped e o status segue processed', async () => {
    const ctx = setup()
    const c = await newCharge(ctx)
    const [pay] = ctx.provider.simulatePayment(c.charge.providerPaymentId)
    await deliver(ctx, pay!)
    const id = eventIdOf(ctx)
    ctx.queue.length = 0

    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const slowProvider = Object.create(ctx.provider) as FakePaymentProvider
    slowProvider.getCharge = async () => {
      await gate
      throw new Error('gateway caiu')
    }
    const slow = processWebhookEvent(id, { ...ctx.deps, provider: slowProvider })

    // Outro worker conclui o evento enquanto o primeiro espera a resposta do gateway.
    expect(await processWebhookEvent(id, ctx.deps)).toBe('processed')
    release()
    expect(await slow).toBe('skipped')
    const status = await eventStatus(id)
    expect(status.status).toBe('processed')
    // Só a execução que concluiu foi gravada: nenhuma `failed` depois dela.
    const runs = await asService((db) =>
      db.execute<{ outcome: string }>(
        sql`select outcome from public.webhook_event_runs where webhook_event_id = ${id}::uuid order by seq`,
      ),
    )
    expect(runs.map((r) => r.outcome)).toEqual(['processed'])
    expect(await ledgerTxCount(paymentConfirmedKey('fake', c.charge.providerPaymentId))).toBe(1)
  })
})

describe('M2: evento em retrying sem job vivo é recolhido pela varredura', () => {
  it('reenfileira o retrying sem execução há mais de 1 h e deixa o recente em paz', async () => {
    const ctx = setup()
    const mk = async (ageSeconds: number) => {
      const id = randomUUID()
      await asService(async (db) => {
        await db.insert(schema.webhookEvents).values({
          id,
          provider: 'fake',
          eventId: `evt_m2_${id}`,
          type: 'ignored',
          rawType: 'ALGUM_EVENTO',
          payload: {},
          receivedAt: new Date(Date.now() - (ageSeconds + 60) * 1000),
        })
        await db.insert(schema.webhookEventRuns).values({
          webhookEventId: id,
          outcome: 'failed',
          error: 'x',
          createdAt: new Date(Date.now() - ageSeconds * 1000),
        })
      })
      return id
    }
    const old = await mk(2 * 3600)
    const recent = await mk(60)
    expect((await eventStatus(old)).status).toBe('retrying')
    await sweepStuckWebhooks(ctx.deps)
    expect(ctx.queue).toContain(old)
    expect(ctx.queue).not.toContain(recent)
  })
})

describe('M4: a conciliação alcança cobrança criada antes da janela', () => {
  it('Pix pago no 5º dia, criado fora da janela de listagem, ainda é conferido', async () => {
    const ctx = setup()
    const c = await newCharge(ctx)
    ctx.provider.simulatePayment(c.charge.providerPaymentId)
    const now = new Date(Date.now() + 5 * 24 * 3_600_000)
    const report = await asService((db) => reconcilePayments(db, ctx.provider, ctx.deps.alert, { now }))
    const kinds = mine(ctx, report.divergences)
      .map((d) => d.kind)
      .sort()
    expect(kinds).toEqual(['ledger_missing', 'split_mismatch', 'status_mismatch'])
  })
})

describe('L3: corpo do webhook é validado com Zod', () => {
  const count = () =>
    asService(
      async (db) => (await db.execute<{ n: number }>(sql`select count(*)::int n from public.webhook_events`))[0]!.n,
    )

  it.each([
    ['id numérico', { id: 123, event: 'PAYMENT_RECEIVED' }],
    ['evento com 121 caracteres', { id: 'evt_1', event: 'X'.repeat(121) }],
    ['id com 201 caracteres', { id: 'e'.repeat(201), event: 'PAYMENT_RECEIVED' }],
    ['payment.id objeto', { id: 'evt_2', event: 'PAYMENT_RECEIVED', payment: { id: { a: 1 } } }],
    ['splitId numérico', { id: 'evt_3', event: 'PAYMENT_SPLIT_DONE', additionalInfo: { splitId: 7 } }],
    ['array', []],
    ['null', null],
  ])('%s retorna 400 e nada é gravado', async (_name, body) => {
    const ctx = setup()
    const before = await count()
    const headers = ctx.provider.delivery({ id: 'x', event: 'x', dateCreated: '' }).headers
    expect((await receiveWebhook(JSON.stringify(body), headers, ctx.deps)).status).toBe(400)
    expect(await count()).toBe(before)
    expect(ctx.queue).toEqual([])
  })
})

describe('L5: colunas imutáveis de payments', () => {
  it('identidade e valores não mudam; andamento sim; confirmação e líquido congelam depois de confirmados', async () => {
    const ctx = setup()
    const c = await newCharge(ctx)
    const pid = c.charge.providerPaymentId
    const update = (set: string) =>
      asService((db) => db.execute(sql.raw(`update public.payments set ${set} where provider_payment_id = '${pid}'`)))

    for (const set of [
      'gross_cents = gross_cents + 1',
      'dev_amount_cents = dev_amount_cents - 1',
      "dev_wallet_id = 'outra'",
      "provider_payment_id = 'trocado'",
      'order_id = gen_random_uuid()',
      'dev_id = gen_random_uuid()',
      "method = 'card'",
      "created_at = now() - interval '1 day'",
    ]) {
      await expect(update(set), set).rejects.toThrow()
    }

    // Andamento normal continua permitido.
    await update("status = 'received', split_status = 'done', net_cents = 9901, confirmed_at = now()")
    expect((await paymentRow(pid)).status).toBe('received')
    // Depois de confirmado, momento e líquido ficam fixos.
    await expect(update('net_cents = 9000')).rejects.toThrow()
    await expect(update("confirmed_at = now() + interval '1 day'")).rejects.toThrow()
    await update("status = 'refunded'")
    expect((await paymentRow(pid)).status).toBe('refunded')
  })
})

/** Captura o que a aplicação manda ao logger durante `fn` (os filhos de `withContext` caem aqui). */
async function captureLogs<T>(fn: () => Promise<T>) {
  const lines: { level: string; fields: Record<string, unknown>; msg: string }[] = []
  const record = (level: string) => (fields: unknown, msg?: string) =>
    lines.push({ level, fields: (fields ?? {}) as Record<string, unknown>, msg: msg ?? '' })
  const child = { info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') }
  const spy = vi.spyOn(logger, 'child').mockReturnValue(child as never)
  try {
    return { result: await fn(), lines }
  } finally {
    spy.mockRestore()
  }
}

const webhookRequest = (body: BodyInit | null, headers: HeadersInit = {}) =>
  new Request('http://localhost/api/webhooks/asaas', {
    method: 'POST',
    body,
    headers,
    ...(body && typeof body !== 'string' ? { duplex: 'half' } : {}),
  } as RequestInit)

const storedEvents = () =>
  asService(
    async (db) => (await db.execute<{ n: number }>(sql`select count(*)::int n from public.webhook_events`))[0]!.n,
  )

describe('L1: corpo grande é recusado antes de autenticar', () => {
  it('Content-Length acima de 1 MB e corpo em stream sem cabeçalho dão 413, sem gravar nem enfileirar', async () => {
    const ctx = setup()
    const before = await storedEvents()
    const declared = await handleWebhookRequest(
      webhookRequest('{}', { 'content-length': String(2_000_000) }),
      ctx.deps,
    )
    expect(declared.status).toBe(413)

    // Sem Content-Length (chunked) e sem token: conta os bytes do stream e para.
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1
        c.enqueue(new Uint8Array(256 * 1024))
      },
    })
    const chunked = await handleWebhookRequest(webhookRequest(stream), ctx.deps)
    expect(chunked.status).toBe(413)
    expect(pulled).toBeLessThan(10)
    expect(await storedEvents()).toBe(before)
    expect(ctx.queue).toEqual([])
  })

  it('entrega válida pela rota continua dando 200 e enfileirando', async () => {
    const ctx = setup()
    const c = await newCharge(ctx)
    const [pay] = ctx.provider.simulatePayment(c.charge.providerPaymentId)
    const d = ctx.provider.delivery(pay!)
    const res = await handleWebhookRequest(webhookRequest(d.rawBody, d.headers), ctx.deps)
    expect(res.status).toBe(200)
    expect(ctx.queue).toHaveLength(1)
  })
})

describe('L2: erro inesperado na rota e inundação de 401', () => {
  it('exceção inesperada vira 500 com log webhook_receive_failed, sem escapar da rota', async () => {
    const ctx = setup()
    ctx.provider.parseWebhook = async () => {
      throw new Error('bug no adaptador')
    }
    const d = ctx.provider.delivery({ id: 'x', event: 'x', dateCreated: '' })
    const { result, lines } = await captureLogs(() =>
      handleWebhookRequest(webhookRequest(d.rawBody, d.headers), ctx.deps),
    )
    expect(result.status).toBe(500)
    expect(await result.json()).toEqual({ ok: false, error: 'internal' })
    const failed = lines.find((l) => l.fields.alertCode === 'webhook_receive_failed')
    expect(failed?.level).toBe('error')
    expect(ctx.queue).toEqual([])
  })

  it('50 requisições com token errado: 401 em todas, um único alerta por janela e nenhum log com alert:true', async () => {
    const ctx = setup()
    const c = await newCharge(ctx)
    const [event] = ctx.provider.simulatePayment(c.charge.providerPaymentId)
    const d = ctx.provider.delivery(event!, 'token-errado')
    const before = await storedEvents()
    const { lines } = await captureLogs(async () => {
      for (let i = 0; i < 50; i++) {
        expect((await handleWebhookRequest(webhookRequest(d.rawBody, d.headers), ctx.deps)).status).toBe(401)
      }
    })
    expect(ctx.alerts.filter((a) => a.code === 'webhook_auth_failed')).toHaveLength(1)
    expect(lines.some((l) => l.fields.alert === true)).toBe(false)
    expect(lines.filter((l) => l.fields.alertCode === 'webhook_auth_failed')).toHaveLength(50)
    expect(await storedEvents()).toBe(before)

    // Passada a janela, o próximo 401 alerta de novo e diz quantos foram silenciados.
    ctx.clock.now += 61_000
    await handleWebhookRequest(webhookRequest(d.rawBody, d.headers), ctx.deps)
    const alerts = ctx.alerts.filter((a) => a.code === 'webhook_auth_failed')
    expect(alerts).toHaveLength(2)
    expect(alerts[1]!.context).toMatchObject({ suppressedSinceLastAlert: 49 })
  })
})

describe('L4: conferências na confirmação', () => {
  it('cobrança de outro pedido (externalReference) falha fechado: nada lançado, evento em retry com alerta', async () => {
    const ctx = setup()
    const c = await newCharge(ctx)
    const [pay] = ctx.provider.simulatePayment(c.charge.providerPaymentId)
    ctx.provider.tamper(c.charge.providerPaymentId, { orderId: randomUUID() })
    await deliver(ctx, pay!)
    const id = eventIdOf(ctx)
    expect(await drain(ctx)).toHaveLength(1)
    expect(ctx.alerts.some((a) => a.code === 'charge_mismatch' && a.severity === 'critical')).toBe(true)
    expect(ctx.orders.confirmed).toEqual([])
    expect(await ledgerTxCount(paymentConfirmedKey('fake', c.charge.providerPaymentId))).toBe(0)
    expect((await eventStatus(id)).status).toBe('retrying')
  })

  it('parte do dev maior que o líquido real: nada é lançado nem confirmado; corrigido no gateway, o evento conclui', async () => {
    const ctx = setup()
    const c = await newCharge(ctx)
    const pid = c.charge.providerPaymentId
    const realNet = c.charge.netCents!
    const [pay] = ctx.provider.simulatePayment(pid)
    ctx.provider.tamper(pid, { netCents: 8_000n }) // líquido menor que os 8.500 do dev
    await deliver(ctx, pay!)
    const id = eventIdOf(ctx)
    expect(await drain(ctx)).toHaveLength(1)
    const alert = ctx.alerts.find((a) => a.code === 'split_exceeds_net' && a.severity === 'critical')
    expect(alert?.context).toMatchObject({ orderId: c.orderId })
    expect(ctx.orders.confirmed).toEqual([])
    expect(await ledgerTxCount(paymentConfirmedKey('fake', pid))).toBe(0)
    expect((await paymentRow(pid)).confirmed_at).toBeNull()
    expect((await eventStatus(id)).status).toBe('retrying')

    // Uma pessoa ajusta o split no gateway e o evento é reprocessado.
    ctx.provider.tamper(pid, { netCents: realNet })
    expect(await processWebhookEvent(id, ctx.deps)).toBe('processed')
    expect(await ledgerTxCount(paymentConfirmedKey('fake', pid))).toBe(1)
    expect(ctx.orders.confirmed).toEqual([c.orderId])
  })

  it('a conciliação aponta cobrança de outro pedido como order_mismatch', async () => {
    const ctx = setup()
    const c = await newCharge(ctx)
    ctx.provider.tamper(c.charge.providerPaymentId, { orderId: randomUUID() })
    const report = await asService((db) => reconcilePayments(db, ctx.provider, ctx.deps.alert, { now: future() }))
    expect(mine(ctx, report.divergences).map((d) => d.kind)).toContain('order_mismatch')
  })
})

describe('L6: timeout no gateway e cobrança parcialmente estornada', () => {
  it('chamada lenta rejeita com timeout e nada é gravado; repetir a mesma chave com o gateway normal funciona', async () => {
    const ctx = setup({ createDelayMs: 300 })
    const slow = withProviderTimeout(ctx.provider, 50)
    const dev = await createUser({ signupRole: 'dev' })
    const orderId = randomUUID()
    const input = {
      orderId,
      devId: dev.id,
      customer,
      method: 'pix' as const,
      grossCents: 10_000n,
      devWalletId: `wallet-${dev.id}`,
      devAmountCents: 8_500n,
      idempotencyKey: `charge-${orderId}`,
    }
    await expect(asService((db) => createOrderCharge(db, slow, input, ctx.deps.alert))).rejects.toMatchObject({
      name: 'PaymentProviderError',
      code: 'timeout',
    })
    const counts = await asService((db) =>
      db.execute<{ p: number; k: number }>(
        sql`select (select count(*)::int from public.payments where order_id = ${orderId}::uuid) p,
                   (select count(*)::int from public.idempotency_keys where key = ${input.idempotencyKey}) k`,
      ),
    )
    expect(counts[0]).toEqual({ p: 0, k: 0 })
    // Repetir com a mesma chave grava a cobrança (a chave segue a mesma para o gateway deduplicar na vida real).
    const again = await asService((db) => createOrderCharge(db, ctx.provider, input, ctx.deps.alert))
    expect(again.replayed).toBe(false)
  })

  it('cobrança parcialmente estornada ainda conta como aberta: nova cobrança do pedido é barrada (serviço e índice)', async () => {
    const ctx = setup()
    const c = await newCharge(ctx)
    const pid = c.charge.providerPaymentId
    await asService((db) =>
      db.execute(sql`update public.payments set status = 'partially_refunded' where provider_payment_id = ${pid}`),
    )
    await expect(
      asService((db) =>
        createOrderCharge(db, ctx.provider, { ...c.input, idempotencyKey: `outra-${randomUUID()}` }, ctx.deps.alert),
      ),
    ).rejects.toBeInstanceOf(PaymentProviderError)

    // Mesmo que a checagem da aplicação fosse contornada, o índice único parcial segura.
    await expect(
      asService((db) =>
        db.insert(schema.payments).values({
          id: randomUUID(),
          orderId: c.orderId,
          provider: 'fake',
          providerPaymentId: `dup-${randomUUID()}`,
          method: 'pix',
          status: 'pending',
          devId: c.dev.id,
          devWalletId: 'w',
          grossCents: 100n,
          devAmountCents: 50n,
        }),
      ),
    ).rejects.toThrow()
  })

  it('cobrança totalmente estornada deixa de ser aberta: o pedido pode ganhar uma nova', async () => {
    const ctx = setup()
    const c = await newCharge(ctx)
    await asService((db) =>
      db.execute(
        sql`update public.payments set status = 'refunded' where provider_payment_id = ${c.charge.providerPaymentId}`,
      ),
    )
    const second = await asService((db) =>
      createOrderCharge(db, ctx.provider, { ...c.input, idempotencyKey: `nova-${randomUUID()}` }, ctx.deps.alert),
    )
    expect(second.replayed).toBe(false)
  })
})

describe('L7: reprocesso exige ator admin dentro da função', () => {
  /** Leva um evento até `failed` (10 falhas), o único estado reprocessável. */
  async function failedEvent(ctx: Ctx) {
    const c = await newCharge(ctx)
    const [pay] = ctx.provider.simulatePayment(c.charge.providerPaymentId)
    await deliver(ctx, pay!)
    const id = eventIdOf(ctx)
    ctx.queue.length = 0
    ctx.orders.failWith = new Error('orders indisponível')
    for (let i = 0; i < MAX_ATTEMPTS; i++) await processWebhookEvent(id, ctx.deps).catch(() => undefined)
    ctx.orders.failWith = null
    expect((await eventStatus(id)).status).toBe('failed')
    return id
  }
  const audits = (id: string) =>
    asService(
      async (db) =>
        (
          await db.execute<{ n: number }>(
            sql`select count(*)::int n from public.audit_log where action = 'webhook.reprocess' and entity_id = ${id}`,
          )
        )[0]!.n,
    )

  it.each([
    ['dev', () => createUser({ signupRole: 'dev' })],
    ['cliente', () => createUser({})],
    ['usuário inexistente', async () => ({ id: randomUUID() })],
  ])('ator %s é recusado (forbidden): nada gravado, nada enfileirado', async (_name, mkActor) => {
    const ctx = setup()
    const id = await failedEvent(ctx)
    const actor = await mkActor()
    await expect(reprocessWebhook(id, actor.id, ctx.deps)).rejects.toMatchObject({ code: 'forbidden' })
    const status = await eventStatus(id)
    expect(status.status).toBe('failed')
    expect(status.attempts).toBe(MAX_ATTEMPTS)
    expect(await audits(id)).toBe(0)
    expect(ctx.queue).toEqual([])
  })

  it('admin reprocessa e fica no audit_log', async () => {
    const ctx = setup()
    const id = await failedEvent(ctx)
    const admin = await createUser({ appRole: 'admin' })
    expect(await reprocessWebhook(id, admin.id, ctx.deps)).toBe('requeued')
    expect(await audits(id)).toBe(1)
    expect(ctx.queue).toEqual([id])
  })
})

describe('L8: idempotency_keys.id é UUID v7 gerado na aplicação', () => {
  it('a chave gravada pela criação de cobrança tem id v7 e o banco não gera id sozinho', async () => {
    const ctx = setup()
    const c = await newCharge(ctx)
    const rows = await asService((db) =>
      db.execute<{ id: string }>(sql`select id from public.idempotency_keys where key = ${c.input.idempotencyKey}`),
    )
    expect(rows).toHaveLength(1)
    expect(isUuidV7(rows[0]!.id)).toBe(true)
    await expect(
      asService((db) =>
        db.execute(
          sql`insert into public.idempotency_keys (scope, key, request_hash, result_ref) values ('s', ${randomUUID()}, 'h', 'r')`,
        ),
      ),
    ).rejects.toThrow()
  })
})
