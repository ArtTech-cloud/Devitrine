import { describe, expect, it } from 'vitest'
import { FakeRecipientGateway } from '@/modules/accounts/infra/fake-recipient-gateway'
import { tokenMatches } from '@/modules/payments/infra/token'
import { AsaasPaymentProvider } from '@/modules/payments/infra/asaas-payment-provider'
import { FakePaymentProvider } from '@/modules/payments/infra/fake-payment-provider'
import {
  PaymentProviderError,
  WebhookAuthError,
  WebhookPayloadError,
  type CreateChargeInput,
} from '@/modules/payments'

const customer = { name: 'Cliente Teste', cpfCnpj: '12345678909', email: 'cliente@example.com' }

function setup() {
  return new FakePaymentProvider(new FakeRecipientGateway())
}

function input(over: Partial<CreateChargeInput> = {}): CreateChargeInput {
  return {
    orderId: 'order-1',
    customer,
    method: 'pix',
    grossCents: 10_000n,
    devWalletId: 'wallet-1',
    devAmountCents: 8_500n,
    idempotencyKey: 'charge-order-1',
    ...over,
  }
}

describe('FakePaymentProvider: cobrança', () => {
  it('Pix devolve copia e cola e nenhum link de cartão; cartão devolve página hospedada', async () => {
    const p = setup()
    const pix = await p.createCharge(input())
    expect(pix.status).toBe('pending')
    expect(pix.pix?.copyPasteCode).toBeTruthy()
    expect(pix.checkoutUrl).toBeNull()
    const card = await p.createCharge(input({ method: 'card', idempotencyKey: 'k2', orderId: 'order-2' }))
    expect(card.checkoutUrl).toMatch(/^https:\/\//)
    expect(card.pix).toBeNull()
  })

  it('líquido é menor que o bruto e tudo é bigint', async () => {
    const p = setup()
    const c = await p.createCharge(input())
    expect(typeof c.grossCents).toBe('bigint')
    expect(c.netCents).toBe(10_000n - 99n)
    const card = await p.createCharge(input({ method: 'card', idempotencyKey: 'k2' }))
    expect(card.netCents).toBe(10_000n - 299n - 49n)
  })

  it('mesma chave e mesmos parâmetros devolve a mesma cobrança, sem criar outra', async () => {
    const p = setup()
    const a = await p.createCharge(input())
    const b = await p.createCharge(input())
    expect(b.providerPaymentId).toBe(a.providerPaymentId)
    expect(p.charges.size).toBe(1)
  })

  it('mesma chave com parâmetros diferentes é recusada', async () => {
    const p = setup()
    await p.createCharge(input())
    await expect(p.createCharge(input({ grossCents: 20_000n }))).rejects.toMatchObject({
      code: 'idempotency_mismatch',
    })
  })

  it('valida entrada: valor, parte do dev, chave e carteira', async () => {
    const p = setup()
    for (const bad of [
      input({ grossCents: 0n }),
      input({ grossCents: 10_000_001n }),
      input({ devAmountCents: 0n }),
      input({ devAmountCents: 10_001n }),
      input({ idempotencyKey: '  ' }),
      input({ devWalletId: '' }),
      input({ customer: { ...customer, email: '' } }),
      input({ method: 'boleto' as never }),
      input({ grossCents: 100 as unknown as bigint }),
    ]) {
      await expect(p.createCharge(bad)).rejects.toBeInstanceOf(PaymentProviderError)
    }
    expect(p.charges.size).toBe(0)
  })
})

describe('FakePaymentProvider: pagamento e garantia', () => {
  it('Pix pago vira received, com split liquidado e garantia ativa de D', async () => {
    const p = setup()
    const c = await p.createCharge(input())
    const events = p.simulatePayment(c.providerPaymentId)
    expect(events.map((e) => e.event)).toEqual(['PAYMENT_RECEIVED', 'PAYMENT_SPLIT_DONE'])
    const paid = await p.getCharge(c.providerPaymentId)
    expect(paid.status).toBe('received')
    expect(paid.splitStatus).toBe('done')
    expect(paid.paidAt).not.toBeNull()
    const escrow = await p.getEscrow(c.providerPaymentId)
    expect(escrow).toMatchObject({ status: 'active', amountCents: 8_500n })
  })

  it('cartão pago vira confirmed', async () => {
    const p = setup()
    const c = await p.createCharge(input({ method: 'card' }))
    expect(p.simulatePayment(c.providerPaymentId)[0]!.event).toBe('PAYMENT_CONFIRMED')
    expect((await p.getCharge(c.providerPaymentId)).status).toBe('confirmed')
  })

  it('parte do dev maior que o líquido bloqueia o split e não cria garantia', async () => {
    const p = setup()
    const c = await p.createCharge(input({ devAmountCents: 10_000n })) // D = G > líquido
    const events = p.simulatePayment(c.providerPaymentId)
    expect(events.map((e) => e.event)).toEqual(['PAYMENT_RECEIVED', 'PAYMENT_SPLIT_DIVERGENCE_BLOCK'])
    expect((await p.getCharge(c.providerPaymentId)).splitStatus).toBe('blocked')
    await expect(p.getEscrow(c.providerPaymentId)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('liberar a garantia exige o id da garantia (não o da cobrança) e é idempotente', async () => {
    const p = setup()
    const c = await p.createCharge(input())
    p.simulatePayment(c.providerPaymentId)
    const escrow = await p.getEscrow(c.providerPaymentId)
    await expect(p.releaseEscrow(c.providerPaymentId, 'rel-1')).rejects.toMatchObject({ code: 'not_found' })
    await p.releaseEscrow(escrow.escrowId, 'rel-1')
    await p.releaseEscrow(escrow.escrowId, 'rel-1') // repetida: sem erro
    expect((await p.getEscrow(c.providerPaymentId)).status).toBe('finished')
    await expect(p.releaseEscrow('outra-garantia', 'rel-1')).rejects.toMatchObject({
      code: 'idempotency_mismatch',
    })
    await expect(p.releaseEscrow(escrow.escrowId, '')).rejects.toMatchObject({ code: 'validation' })
  })

  it('não paga duas vezes nem vencida', async () => {
    const p = setup()
    const c = await p.createCharge(input())
    p.simulatePayment(c.providerPaymentId)
    expect(() => p.simulatePayment(c.providerPaymentId)).toThrow(PaymentProviderError)
    const d = await p.createCharge(input({ idempotencyKey: 'k2' }))
    expect(p.simulateOverdue(d.providerPaymentId).event).toBe('PAYMENT_OVERDUE')
    expect(() => p.simulatePayment(d.providerPaymentId)).toThrow(PaymentProviderError)
  })

  it('listCharges filtra por data de criação', async () => {
    let now = new Date('2026-10-01T12:00:00Z')
    const p = new FakePaymentProvider(new FakeRecipientGateway(), { now: () => now })
    await p.createCharge(input())
    now = new Date('2026-10-10T12:00:00Z')
    await p.createCharge(input({ idempotencyKey: 'k2' }))
    const list = await p.listCharges({ from: new Date('2026-10-05T00:00:00Z'), to: new Date('2026-10-20T00:00:00Z') })
    expect(list).toHaveLength(1)
  })
})

describe('FakePaymentProvider: estorno', () => {
  async function paid() {
    const p = setup()
    const c = await p.createCharge(input())
    p.simulatePayment(c.providerPaymentId)
    return { p, id: c.providerPaymentId }
  }

  it('estorno total cancela a garantia e marca refunded', async () => {
    const { p, id } = await paid()
    const r = await p.refund(id, 'full', 'ref-1')
    expect(r.amountCents).toBe(10_000n)
    expect((await p.getCharge(id)).status).toBe('refunded')
    expect((await p.getEscrow(id)).status).toBe('cancelled')
    expect(p.refundEvent(id).event).toBe('PAYMENT_REFUNDED')
  })

  it('estorno parcial mantém a cobrança como parcialmente estornada', async () => {
    const { p, id } = await paid()
    await p.refund(id, 4_000n, 'ref-1')
    expect((await p.getCharge(id)).status).toBe('partially_refunded')
    expect(p.refundEvent(id).event).toBe('PAYMENT_PARTIALLY_REFUNDED')
    await expect(p.refund(id, 6_001n, 'ref-2')).rejects.toMatchObject({ code: 'validation' })
  })

  it('mesma chave devolve o mesmo estorno sem estornar de novo; parâmetro diferente é recusado', async () => {
    const { p, id } = await paid()
    const a = await p.refund(id, 4_000n, 'ref-1')
    const b = await p.refund(id, 4_000n, 'ref-1')
    expect(b.providerRefundId).toBe(a.providerRefundId)
    expect(p.refunds.size).toBe(1)
    await expect(p.refund(id, 5_000n, 'ref-1')).rejects.toMatchObject({ code: 'idempotency_mismatch' })
  })

  it('cobrança pendente não pode ser estornada', async () => {
    const p = setup()
    const c = await p.createCharge(input())
    await expect(p.refund(c.providerPaymentId, 'full', 'ref-1')).rejects.toMatchObject({ code: 'conflict' })
  })

  it('chargeback só em cobrança paga', async () => {
    const { p, id } = await paid()
    expect(p.simulateChargeback(id).event).toBe('PAYMENT_CHARGEBACK_REQUESTED')
    expect((await p.getCharge(id)).status).toBe('chargeback')
  })
})

describe('FakePaymentProvider: webhook', () => {
  it('autentica e normaliza; o mesmo evento reentregue 3x tem o mesmo eventId', async () => {
    const p = setup()
    const c = await p.createCharge(input())
    const [received] = p.simulatePayment(c.providerPaymentId)
    const delivery = p.delivery(received!)
    const parsed = await Promise.all([1, 2, 3].map(() => p.parseWebhook(delivery.rawBody, delivery.headers)))
    expect(new Set(parsed.map((e) => e.eventId)).size).toBe(1)
    expect(parsed[0]).toMatchObject({
      provider: 'fake',
      type: 'payment_received',
      providerPaymentId: c.providerPaymentId,
    })
  })

  it('eventos diferentes têm ids diferentes e split_done traz o splitId', async () => {
    const p = setup()
    const c = await p.createCharge(input())
    const [pay, split] = p.simulatePayment(c.providerPaymentId)
    const a = await p.parseWebhook(p.delivery(pay!).rawBody, p.delivery(pay!).headers)
    const b = await p.parseWebhook(p.delivery(split!).rawBody, p.delivery(split!).headers)
    expect(a.eventId).not.toBe(b.eventId)
    expect(b.type).toBe('split_done')
    expect(b.splitId).toBeTruthy()
  })

  it('token ausente ou errado lança WebhookAuthError antes de ler o corpo', async () => {
    const p = setup()
    const c = await p.createCharge(input())
    const [ev] = p.simulatePayment(c.providerPaymentId)
    for (const token of [null, 'errado', '']) {
      const d = p.delivery(ev!, token)
      await expect(p.parseWebhook(d.rawBody, d.headers)).rejects.toBeInstanceOf(WebhookAuthError)
    }
    // Corpo ilegível com token inválido continua sendo erro de autenticação, não de corpo.
    await expect(p.parseWebhook('{{{', new Headers({ 'asaas-access-token': 'errado' }))).rejects.toBeInstanceOf(
      WebhookAuthError,
    )
  })

  it('corpo autenticado mas inválido lança WebhookPayloadError', async () => {
    const p = setup()
    const headers = new Headers({ 'asaas-access-token': p.webhookToken })
    for (const body of ['{{{', '[]', 'null', JSON.stringify({ event: 'PAYMENT_RECEIVED' }), JSON.stringify({ id: 'x' })]) {
      await expect(p.parseWebhook(body, headers)).rejects.toBeInstanceOf(WebhookPayloadError)
    }
  })

  it('evento fora da lista vira ignored', async () => {
    const p = setup()
    const headers = new Headers({ 'asaas-access-token': p.webhookToken })
    const e = await p.parseWebhook(JSON.stringify({ id: 'evt_1', event: 'PAYMENT_CREATED' }), headers)
    expect(e.type).toBe('ignored')
    expect(e.rawType).toBe('PAYMENT_CREATED')
  })
})

describe('tokenMatches', () => {
  it('compara igual e rejeita diferente, vazio e de outro tamanho', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true)
    expect(tokenMatches('abd', 'abc')).toBe(false)
    expect(tokenMatches('abcd', 'abc')).toBe(false)
    expect(tokenMatches('', 'abc')).toBe(false)
    expect(tokenMatches(null, 'abc')).toBe(false)
    expect(tokenMatches('abc', '')).toBe(false)
  })
})

describe('AsaasPaymentProvider (esboço)', () => {
  it('toda operação falha com not_implemented, sem rede', async () => {
    const a = new AsaasPaymentProvider()
    await expect(a.createCharge()).rejects.toMatchObject({ code: 'not_implemented' })
    await expect(a.parseWebhook()).rejects.toMatchObject({ code: 'not_implemented' })
    await expect(a.releaseEscrow()).rejects.toMatchObject({ code: 'not_implemented' })
  })
})
