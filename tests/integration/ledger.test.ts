import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { asService, asUser, createUser, DATABASE_URL, rawAs } from './harness'

process.env.DATABASE_URL ??= DATABASE_URL
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-key'

const {
  chargebackAfterRelease,
  devAccount,
  escrowFinished,
  getAllBalances,
  getBalanceCents,
  getDevSpendableCents,
  LedgerError,
  newTx,
  orderRelease,
  paymentConfirmed,
  platformAccount,
  postLedgerTx,
  withdrawalApproved,
} = await import('@/modules/ledger')

const key = () => `t-${randomUUID()}`
// O drizzle embrulha o erro do Postgres em "Failed query"; a mensagem real fica em cause.
const causeMatches = (re: RegExp) => (e: unknown) => {
  const err = e as { message?: string; cause?: { message?: string } }
  return re.test(`${err.message} ${err.cause?.message}`)
}
const raw = (tx: string, lines: unknown[], idem = key()) =>
  sql`select public.ledger_post(${randomUUID()}::uuid, ${tx}, ${idem}, null::uuid, ${JSON.stringify(lines)}::jsonb) as result`

const L = (code: string, direction: string, amount: string, owner_id: string | null = null) => ({
  code,
  owner_id,
  direction,
  amount_cents: amount,
})

describe('ledger_post e saldos derivados', () => {
  it('lança um pagamento, a liberação e a garantia; saldos saem da soma dos lançamentos', async () => {
    const dev = await createUser({ signupRole: 'dev' })
    const order = randomUUID()
    const before = await asService((db) => getAllBalances(db))
    const get = (m: Map<string, bigint>, k: string) => m.get(k) ?? 0n

    await asService(async (db) => {
      expect(await postLedgerTx(db, paymentConfirmed({ idempotencyKey: key(), orderId: order, grossCents: 10_000n, netCents: 9_700n }))).toBe('posted')
      await postLedgerTx(db, orderRelease({ idempotencyKey: key(), orderId: order, devId: dev.id, grossCents: 10_000n, devAmountCents: 8_500n }))
      await postLedgerTx(db, escrowFinished({ idempotencyKey: key(), orderId: order, devId: dev.id, devAmountCents: 8_500n }))
    })

    const after = await asService((db) => getAllBalances(db))
    expect(get(after, 'gateway_cash') - get(before, 'gateway_cash')).toBe(9_700n)
    expect(get(after, 'gateway_fees') - get(before, 'gateway_fees')).toBe(300n)
    expect(get(after, 'escrow_liability') - get(before, 'escrow_liability')).toBe(0n)
    expect(get(after, 'platform_revenue') - get(before, 'platform_revenue')).toBe(1_500n)
    expect(get(after, `dev_available:${dev.id}`)).toBe(8_500n)
    expect(await asService((db) => getBalanceCents(db, devAccount('dev_available', dev.id)))).toBe(8_500n)
    expect(await asService((db) => getDevSpendableCents(db, dev.id))).toBe(8_500n)
  })

  it('o ledger inteiro continua fechado: soma dos débitos = soma dos créditos', async () => {
    const rows = await asService((db) =>
      db.execute<{ d: string; c: string }>(
        sql`select coalesce(sum(amount_cents) filter (where direction='debit'),0)::text d,
                   coalesce(sum(amount_cents) filter (where direction='credit'),0)::text c
            from public.ledger_entries`,
      ),
    )
    expect(rows[0]!.d).toBe(rows[0]!.c)
  })

  it('chargeback após a liberação deixa o saque disponível menor (dev_receivable abate)', async () => {
    const dev = await createUser({ signupRole: 'dev' })
    const order = randomUUID()
    await asService(async (db) => {
      await postLedgerTx(db, paymentConfirmed({ idempotencyKey: key(), orderId: order, grossCents: 10_000n, netCents: 9_800n }))
      await postLedgerTx(db, orderRelease({ idempotencyKey: key(), orderId: order, devId: dev.id, grossCents: 10_000n, devAmountCents: 8_500n }))
      await postLedgerTx(db, escrowFinished({ idempotencyKey: key(), orderId: order, devId: dev.id, devAmountCents: 8_500n }))
      await postLedgerTx(db, chargebackAfterRelease({ idempotencyKey: key(), orderId: order, devId: dev.id, grossCents: 10_000n, devAmountCents: 8_500n }))
    })
    expect(await asService((db) => getBalanceCents(db, devAccount('dev_receivable', dev.id)))).toBe(8_500n)
    expect(await asService((db) => getDevSpendableCents(db, dev.id))).toBe(0n)
  })

  it('saque aprovado sai do disponível na hora', async () => {
    const dev = await createUser({ signupRole: 'dev' })
    await asService(async (db) => {
      await postLedgerTx(db, escrowFinished({ idempotencyKey: key(), orderId: null, devId: dev.id, devAmountCents: 5_000n }))
      await postLedgerTx(db, withdrawalApproved({ idempotencyKey: key(), orderId: null, devId: dev.id, amountCents: 2_000n }))
    })
    expect(await asService((db) => getBalanceCents(db, devAccount('dev_available', dev.id)))).toBe(3_000n)
    expect(await asService((db) => getBalanceCents(db, devAccount('dev_withdrawal_pending', dev.id)))).toBe(2_000n)
  })
})

describe('idempotência', () => {
  it('a mesma chave com o mesmo conteúdo é "duplicate" e não grava nada', async () => {
    const idem = key()
    const tx = () => paymentConfirmed({ idempotencyKey: idem, orderId: randomUUID(), grossCents: 1_000n, netCents: 990n })
    const t = tx()
    const same = { ...t, txId: randomUUID() } // outro tx_id, mesmo conteúdo e chave
    const first = await asService((db) => postLedgerTx(db, t))
    const second = await asService((db) => postLedgerTx(db, same))
    expect([first, second]).toEqual(['posted', 'duplicate'])
    const n = await asService((db) =>
      db.execute<{ n: string }>(sql`select count(*)::text n from public.ledger_entries e join public.ledger_transactions t using (tx_id) where t.idempotency_key = ${idem}`),
    )
    expect(n[0]!.n).toBe('3')
  })

  it('a mesma chave com conteúdo diferente é recusada', async () => {
    const idem = key()
    const order = randomUUID()
    await asService((db) => postLedgerTx(db, paymentConfirmed({ idempotencyKey: idem, orderId: order, grossCents: 1_000n, netCents: 990n })))
    await expect(
      asService((db) => postLedgerTx(db, paymentConfirmed({ idempotencyKey: idem, orderId: order, grossCents: 2_000n, netCents: 1_980n }))),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  it('10 postagens concorrentes com a mesma chave geram um único lote', async () => {
    const idem = key()
    const order = randomUUID()
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        asService((db) =>
          postLedgerTx(db, paymentConfirmed({ idempotencyKey: idem, orderId: order, grossCents: 4_000n, netCents: 3_900n })),
        ),
      ),
    )
    expect(results.filter((r) => r === 'posted')).toHaveLength(1)
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(9)
    const n = await asService((db) =>
      db.execute<{ n: string }>(sql`select count(*)::text n from public.ledger_transactions where idempotency_key = ${idem}`),
    )
    expect(n[0]!.n).toBe('1')
  })

  it('o fluxo cobrança → pagamento → ledger, com o webhook entregue 3 vezes, gera um único lançamento', async () => {
    const { FakePaymentProvider } = await import('@/modules/payments/infra/fake-payment-provider')
    const { FakeRecipientGateway } = await import('@/modules/accounts/infra/fake-recipient-gateway')
    const provider = new FakePaymentProvider(new FakeRecipientGateway())
    const order = randomUUID()
    const charge = await provider.createCharge({
      orderId: order,
      customer: { name: 'Cliente', cpfCnpj: '12345678909', email: 'c@example.com' },
      method: 'pix',
      grossCents: 10_000n,
      devWalletId: 'w1',
      devAmountCents: 8_500n,
      idempotencyKey: key(),
    })
    const [payEvent] = provider.simulatePayment(charge.providerPaymentId)
    const delivery = provider.delivery(payEvent!)

    const before = await asService((db) => getBalanceCents(db, platformAccount('escrow_liability')))
    const results: string[] = []
    for (let i = 0; i < 3; i++) {
      const event = await provider.parseWebhook(delivery.rawBody, delivery.headers)
      // O job busca o recurso no provedor; o payload não é fonte da verdade.
      const fetched = await provider.getCharge(event.providerPaymentId!)
      results.push(
        await asService((db) =>
          postLedgerTx(
            db,
            paymentConfirmed({
              idempotencyKey: `payment_confirmed:${fetched.providerPaymentId}`,
              orderId: order,
              grossCents: fetched.grossCents,
              netCents: fetched.netCents!,
            }),
          ),
        ),
      )
    }
    expect(results).toEqual(['posted', 'duplicate', 'duplicate'])
    const after = await asService((db) => getBalanceCents(db, platformAccount('escrow_liability')))
    expect(after - before).toBe(10_000n)
  })
})

describe('lote que não fecha é rejeitado inteiro', () => {
  it('ledger_post recusa débitos ≠ créditos e não grava cabeçalho nem linhas', async () => {
    const idem = key()
    await expect(
      asService((db) => db.execute(raw('x', [L('gateway_cash', 'debit', '100'), L('escrow_liability', 'credit', '99')], idem))),
    ).rejects.toSatisfy(causeMatches(/não fecha/))
    const n = await asService((db) =>
      db.execute<{ n: string }>(sql`select count(*)::text n from public.ledger_transactions where idempotency_key = ${idem}`),
    )
    expect(n[0]!.n).toBe('0')
  })

  it('recusa menos de 2 linhas, valor zero, negativo, decimal e número JSON', async () => {
    const bad: unknown[][] = [
      [L('gateway_cash', 'debit', '100')],
      [L('gateway_cash', 'debit', '0'), L('escrow_liability', 'credit', '0')],
      [L('gateway_cash', 'debit', '-5'), L('escrow_liability', 'credit', '-5')],
      [L('gateway_cash', 'debit', '1.5'), L('escrow_liability', 'credit', '1.5')],
      [{ ...L('gateway_cash', 'debit', '1'), amount_cents: 100 }, L('escrow_liability', 'credit', '100')],
      [L('gateway_cash', 'sideways', '100'), L('escrow_liability', 'credit', '100')],
    ]
    for (const lines of bad) {
      await expect(asService((db) => db.execute(raw('x', lines)))).rejects.toThrow()
    }
  })

  it('o domínio recusa antes de chegar ao banco', () => {
    expect(() =>
      newTx({
        kind: 'payment_confirmed',
        idempotencyKey: 'k',
        orderId: null,
        lines: [
          { account: platformAccount('gateway_cash'), direction: 'debit', amountCents: 10n },
          { account: platformAccount('escrow_liability'), direction: 'credit', amountCents: 9n },
        ],
      }),
    ).toThrow(LedgerError)
  })

  it('INSERT direto desbalanceado falha no commit (rede de segurança)', async () => {
    await expect(
      asService(async (db) => {
        const txId = randomUUID()
        await db.execute(sql`insert into public.ledger_transactions (tx_id, kind, idempotency_key, lines_hash) values (${txId}::uuid, 'x', ${key()}, 'h')`)
        await db.execute(sql`insert into public.ledger_entries (tx_id, account_id, direction, amount_cents)
          select ${txId}::uuid, id, 'debit', 100 from public.ledger_accounts where code = 'gateway_cash'`)
      }),
    ).rejects.toThrow(/não fecha/)
  })

  it('lote fechado não aceita linhas novas depois', async () => {
    const idem = key()
    await asService((db) => db.execute(raw('x', [L('gateway_cash', 'debit', '50'), L('escrow_liability', 'credit', '50')], idem)))
    const rows = await asService((db) =>
      db.execute<{ tx_id: string }>(sql`select tx_id from public.ledger_transactions where idempotency_key = ${idem}`),
    )
    await expect(
      asService((db) =>
        db.execute(sql`insert into public.ledger_entries (tx_id, account_id, direction, amount_cents)
          select ${rows[0]!.tx_id}::uuid, id, 'debit', 10 from public.ledger_accounts where code = 'gateway_cash'`),
      ),
    ).rejects.toSatisfy(causeMatches(/já está fechado/))
  })
})

describe('append-only e contas', () => {
  it('UPDATE, DELETE e TRUNCATE são bloqueados nas três tabelas, mesmo para o dono do banco', async () => {
    await asService((db) => db.execute(raw('x', [L('gateway_cash', 'debit', '50'), L('escrow_liability', 'credit', '50')])))
    for (const table of ['ledger_entries', 'ledger_transactions', 'ledger_accounts']) {
      await expect(asService((db) => db.execute(sql.raw(`delete from public.${table}`)))).rejects.toThrow()
      await expect(asService((db) => db.execute(sql.raw(`truncate public.${table} cascade`)))).rejects.toThrow()
    }
    await expect(
      asService((db) => db.execute(sql`update public.ledger_entries set amount_cents = amount_cents + 1`)),
    ).rejects.toThrow()
    await expect(
      asService((db) => db.execute(sql`update public.ledger_accounts set code = code`)),
    ).rejects.toThrow()
    await expect(
      asService((db) => db.execute(sql`update public.ledger_transactions set kind = 'y'`)),
    ).rejects.toThrow()
  })

  it('conta de dev exige dono existente; conta da plataforma não pode ter dono', async () => {
    const ghost = randomUUID()
    await expect(
      asService((db) => db.execute(raw('x', [L('dev_available', 'debit', '10', ghost), L('dev_payable', 'credit', '10', ghost)]))),
    ).rejects.toThrow()
    const dev = await createUser({ signupRole: 'dev' })
    await expect(
      asService((db) => db.execute(raw('x', [L('dev_available', 'debit', '10'), L('dev_payable', 'credit', '10')]))),
    ).rejects.toThrow() // dev_* sem dono
    await expect(
      asService((db) => db.execute(raw('x', [L('gateway_cash', 'debit', '10', dev.id), L('escrow_liability', 'credit', '10')]))),
    ).rejects.toThrow() // plataforma com dono
    await expect(
      asService((db) => db.execute(raw('x', [L('inventada', 'debit', '10'), L('escrow_liability', 'credit', '10')]))),
    ).rejects.toThrow()
  })
})

describe('acesso pela API', () => {
  it('anon e authenticated não leem, não escrevem e não executam as funções do ledger', async () => {
    const user = await createUser()
    for (const role of ['anon', 'authenticated'] as const) {
      const who = role === 'authenticated' ? user : null
      for (const table of ['ledger_entries', 'ledger_transactions', 'ledger_accounts']) {
        await expect(rawAs(who, (tx) => tx.unsafe(`select * from public.${table}`), role)).rejects.toThrow(/permission denied/)
      }
      await expect(
        rawAs(who, (tx) => tx`select public.ledger_post(${randomUUID()}::uuid, 'x', ${key()}, null, '[]'::jsonb)`, role),
      ).rejects.toThrow(/permission denied/)
      await expect(rawAs(who, (tx) => tx`select public.ledger_balance('gateway_cash', null)`, role)).rejects.toThrow(/permission denied/)
    }
  })

  it('o usuário autenticado pela RLS também não enxerga o ledger', async () => {
    const user = await createUser()
    await expect(asUser(user, (db) => db.execute(sql`select * from public.ledger_entries`))).rejects.toSatisfy(causeMatches(/permission denied/))
  })

  it('service_role consegue lançar e ler saldo, mas não alterar nem apagar', async () => {
    const idem = key()
    const posted = await rawAs(
      null,
      (tx) =>
        tx`select public.ledger_post(${randomUUID()}::uuid, 'x', ${idem}, null,
          ${JSON.stringify([L('gateway_cash', 'debit', '5'), L('escrow_liability', 'credit', '5')])}::text::jsonb) as r`,
      'service_role',
    )
    expect(posted[0]!.r).toBe('posted')
    await expect(rawAs(null, (tx) => tx`select public.ledger_balance('gateway_cash', null)`, 'service_role')).resolves.toBeDefined()
    await expect(rawAs(null, (tx) => tx`update public.ledger_entries set amount_cents = 1`, 'service_role')).rejects.toThrow(/permission denied/)
    await expect(rawAs(null, (tx) => tx`delete from public.ledger_entries`, 'service_role')).rejects.toThrow(/permission denied/)
    await expect(rawAs(null, (tx) => tx`truncate public.ledger_entries`, 'service_role')).rejects.toThrow(/permission denied/)
  })
})
