import { newId } from '@/lib/ids'
import { feeCents } from '@/lib/money'
import type {
  CreateRecipientInput,
  RecipientGateway,
  RecipientRef,
  RecipientStatus,
} from '@/modules/accounts'
import { assertChargeInput, fingerprint, splitFitsNet } from '../domain/charge-rules'
import { PaymentProviderError, WebhookAuthError, WebhookPayloadError } from '../domain/errors'
import type {
  Charge,
  CreateChargeInput,
  Escrow,
  ListChargesInput,
  NormalizedEvent,
  PaymentProvider,
  Refund,
} from '../domain/provider'
import { asaasEventNameFor, normalizeAsaasEventName } from '../domain/webhook-events'
import { tokenMatches } from './token'

export const FAKE_WEBHOOK_TOKEN = 'fake-webhook-token-0123456789abcdef0123456789'

/** Corpo de webhook no formato que o fake emite e lê. É do fake: o formato do Asaas real não foi conferido em sandbox. */
export interface FakeWebhookBody {
  id: string
  event: string
  dateCreated: string
  payment?: { id: string }
  additionalInfo?: { splitId: string }
}

export interface FakeDelivery {
  rawBody: string
  headers: Headers
}

interface FakeCharge extends Charge {
  feeCents: bigint
  splitId: string
  escrowId: string | null
  refundedCents: bigint
}

/**
 * Gateway de mentira para dev e testes (ADR-017): sem rede e sem sandbox do Asaas. Simula Pix e cartão
 * com split de valor fixo, garantia (escrow), estorno e webhooks no mesmo formato de evento da SPEC §9.
 * As taxas são fictícias (Pix R$ 0,99; cartão 2,99% + R$ 0,49), só para o líquido ser menor que o bruto.
 * Nunca vai para produção: a composição recusa.
 *
 * Os métodos `simulate*` e `delivery` são o lado "gateway" para os testes: mudam o estado da cobrança e
 * devolvem os eventos que o Asaas enviaria. Redistribuir o mesmo evento é reenviar o mesmo `FakeWebhookBody`.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake' as const
  readonly charges = new Map<string, FakeCharge>()
  readonly escrows = new Map<string, Escrow>()
  readonly refunds = new Map<string, Refund>()
  calls = { createCharge: 0, getCharge: 0, listCharges: 0, getEscrow: 0, releaseEscrow: 0, refund: 0 }

  private readonly chargeByKey = new Map<string, { hash: string; id: string }>()
  private readonly refundByKey = new Map<string, { hash: string; refund: Refund }>()
  private readonly releaseKeys = new Map<string, string>()

  constructor(
    private readonly recipients: RecipientGateway,
    private readonly options: { webhookToken?: string; now?: () => Date } = {},
  ) {}

  get webhookToken(): string {
    return this.options.webhookToken ?? FAKE_WEBHOOK_TOKEN
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  // --- RecipientGateway: delega ao gateway de subcontas compartilhado ---
  createRecipient(input: CreateRecipientInput): Promise<RecipientRef> {
    return this.recipients.createRecipient(input)
  }
  getRecipientStatus(accountId: string): Promise<RecipientStatus> {
    return this.recipients.getRecipientStatus(accountId)
  }
  enableEscrow(
    accountId: string,
    options: { daysToExpire: number; isFeePayer: boolean; idempotencyKey: string },
  ): Promise<void> {
    return this.recipients.enableEscrow(accountId, options)
  }

  // --- PaymentProvider ---
  async createCharge(input: CreateChargeInput): Promise<Charge> {
    this.calls.createCharge++
    assertChargeInput(input)
    const hash = fingerprint([
      input.orderId,
      input.method,
      input.grossCents,
      input.devWalletId,
      input.devAmountCents,
      input.customer.cpfCnpj,
    ])
    const seen = this.chargeByKey.get(input.idempotencyKey)
    if (seen) {
      if (seen.hash !== hash) {
        throw new PaymentProviderError('idempotency_mismatch', 'Chave reutilizada com parâmetros diferentes')
      }
      return this.publicCharge(this.charges.get(seen.id)!)
    }
    const id = `fake_pay_${newId()}`
    const fee = this.feeFor(input.method, input.grossCents)
    const charge: FakeCharge = {
      providerPaymentId: id,
      orderId: input.orderId,
      method: input.method,
      status: 'pending',
      grossCents: input.grossCents,
      netCents: input.grossCents - fee,
      devWalletId: input.devWalletId,
      devAmountCents: input.devAmountCents,
      splitStatus: 'pending',
      checkoutUrl: input.method === 'card' ? `https://sandbox.invalid/checkout/${id}` : null,
      pix:
        input.method === 'pix'
          ? {
              copyPasteCode: `00020126FAKE${id}`,
              qrCodeBase64: null,
              expiresAt: new Date(this.now().getTime() + 24 * 3600_000),
            }
          : null,
      createdAt: this.now(),
      paidAt: null,
      feeCents: fee,
      splitId: `fake_split_${newId()}`,
      escrowId: null,
      refundedCents: 0n,
    }
    this.charges.set(id, charge)
    this.chargeByKey.set(input.idempotencyKey, { hash, id })
    return this.publicCharge(charge)
  }

  async getCharge(providerPaymentId: string): Promise<Charge> {
    this.calls.getCharge++
    return this.publicCharge(this.mustCharge(providerPaymentId))
  }

  async listCharges({ from, to }: ListChargesInput): Promise<Charge[]> {
    this.calls.listCharges++
    return [...this.charges.values()]
      .filter((c) => c.createdAt >= from && c.createdAt <= to)
      .map((c) => this.publicCharge(c))
  }

  async getEscrow(providerPaymentId: string): Promise<Escrow> {
    this.calls.getEscrow++
    const charge = this.mustCharge(providerPaymentId)
    const escrow = charge.escrowId ? this.escrows.get(charge.escrowId) : undefined
    if (!escrow) throw new PaymentProviderError('not_found', 'Garantia inexistente para a cobrança')
    return { ...escrow }
  }

  async releaseEscrow(escrowId: string, idempotencyKey: string): Promise<void> {
    this.calls.releaseEscrow++
    if (!idempotencyKey.trim()) {
      throw new PaymentProviderError('validation', 'Chave de idempotência é obrigatória')
    }
    const seen = this.releaseKeys.get(idempotencyKey)
    if (seen) {
      if (seen !== escrowId) {
        throw new PaymentProviderError('idempotency_mismatch', 'Chave reutilizada com outra garantia')
      }
      return
    }
    const escrow = this.escrows.get(escrowId)
    if (!escrow) throw new PaymentProviderError('not_found', 'Garantia inexistente (o id é o da garantia, não o da cobrança)')
    if (escrow.status === 'cancelled') throw new PaymentProviderError('conflict', 'Garantia cancelada')
    escrow.status = 'finished'
    this.releaseKeys.set(idempotencyKey, escrowId)
  }

  async refund(
    providerPaymentId: string,
    amountCents: bigint | 'full',
    idempotencyKey: string,
  ): Promise<Refund> {
    this.calls.refund++
    if (!idempotencyKey.trim()) {
      throw new PaymentProviderError('validation', 'Chave de idempotência é obrigatória')
    }
    const hash = fingerprint([providerPaymentId, amountCents === 'full' ? 'full' : amountCents])
    const seen = this.refundByKey.get(idempotencyKey)
    if (seen) {
      if (seen.hash !== hash) {
        throw new PaymentProviderError('idempotency_mismatch', 'Chave reutilizada com parâmetros diferentes')
      }
      return { ...seen.refund }
    }
    const charge = this.mustCharge(providerPaymentId)
    if (charge.status !== 'confirmed' && charge.status !== 'received' && charge.status !== 'partially_refunded') {
      throw new PaymentProviderError('conflict', 'Só cobrança paga pode ser estornada')
    }
    const remaining = charge.grossCents - charge.refundedCents
    const value = amountCents === 'full' ? remaining : amountCents
    if (typeof value !== 'bigint' || value <= 0n || value > remaining) {
      throw new PaymentProviderError('validation', 'Valor de estorno inválido')
    }
    charge.refundedCents += value
    const total = charge.refundedCents === charge.grossCents
    charge.status = total ? 'refunded' : 'partially_refunded'
    if (total && charge.escrowId) {
      const escrow = this.escrows.get(charge.escrowId)
      if (escrow && escrow.status === 'active') escrow.status = 'cancelled'
    }
    const refund: Refund = {
      providerRefundId: `fake_refund_${newId()}`,
      providerPaymentId,
      amountCents: value,
      status: 'done',
    }
    this.refunds.set(refund.providerRefundId, refund)
    this.refundByKey.set(idempotencyKey, { hash, refund })
    return { ...refund }
  }

  async parseWebhook(rawBody: string, headers: Headers): Promise<NormalizedEvent> {
    // Autentica ANTES de qualquer parse (SPEC §9, passo 2).
    if (!tokenMatches(headers.get('asaas-access-token'), this.webhookToken)) throw new WebhookAuthError()
    let body: unknown
    try {
      body = JSON.parse(rawBody)
    } catch {
      throw new WebhookPayloadError()
    }
    const b = body as Partial<FakeWebhookBody> | null
    if (!b || typeof b.id !== 'string' || typeof b.event !== 'string' || !b.id || !b.event) {
      throw new WebhookPayloadError()
    }
    const occurred = b.dateCreated ? new Date(b.dateCreated) : null
    return {
      provider: 'fake',
      eventId: b.id,
      type: normalizeAsaasEventName(b.event),
      rawType: b.event,
      providerPaymentId: typeof b.payment?.id === 'string' ? b.payment.id : null,
      splitId: typeof b.additionalInfo?.splitId === 'string' ? b.additionalInfo.splitId : null,
      occurredAt: occurred && !Number.isNaN(occurred.getTime()) ? occurred : null,
    }
  }

  // --- Lado "gateway", para testes e para o dev local ---

  /**
   * Cliente pagou. Pix → `received`; cartão → `confirmed` (o Asaas confirma antes de receber). Se a parte do
   * dev couber no líquido, cria a garantia e o split sai; senão o split fica bloqueado (SPEC §8, item 4).
   */
  simulatePayment(providerPaymentId: string): FakeWebhookBody[] {
    const charge = this.mustCharge(providerPaymentId)
    if (charge.status !== 'pending') throw new PaymentProviderError('conflict', 'Cobrança não está pendente')
    charge.status = charge.method === 'pix' ? 'received' : 'confirmed'
    charge.paidAt = this.now()
    const payEvent = charge.method === 'pix' ? 'payment_received' : 'payment_confirmed'
    const events = [this.body(payEvent, charge)]
    if (splitFitsNet(charge.devAmountCents, charge.netCents ?? 0n)) {
      charge.splitStatus = 'done'
      charge.escrowId = `fake_escrow_${newId()}`
      this.escrows.set(charge.escrowId, {
        escrowId: charge.escrowId,
        providerPaymentId,
        status: 'active',
        amountCents: charge.devAmountCents,
      })
      events.push(this.body('split_done', charge, charge.splitId))
    } else {
      charge.splitStatus = 'blocked'
      events.push(this.body('split_divergence_block', charge, charge.splitId))
    }
    return events
  }

  /** Cobrança venceu sem pagamento. */
  simulateOverdue(providerPaymentId: string): FakeWebhookBody {
    const charge = this.mustCharge(providerPaymentId)
    if (charge.status !== 'pending') throw new PaymentProviderError('conflict', 'Cobrança não está pendente')
    charge.status = 'overdue'
    return this.body('payment_overdue', charge)
  }

  /** Cliente contestou no cartão: o dinheiro sai da cobrança. */
  simulateChargeback(providerPaymentId: string): FakeWebhookBody {
    const charge = this.mustCharge(providerPaymentId)
    if (charge.status !== 'confirmed' && charge.status !== 'received') {
      throw new PaymentProviderError('conflict', 'Só cobrança paga sofre chargeback')
    }
    charge.status = 'chargeback'
    return this.body('chargeback_requested', charge)
  }

  /** Evento de estorno depois de `refund()`, como o Asaas enviaria. */
  refundEvent(providerPaymentId: string): FakeWebhookBody {
    const charge = this.mustCharge(providerPaymentId)
    if (charge.status !== 'refunded' && charge.status !== 'partially_refunded') {
      throw new PaymentProviderError('conflict', 'Cobrança não foi estornada')
    }
    return this.body(charge.status === 'refunded' ? 'payment_refunded' : 'payment_partially_refunded', charge)
  }

  /** Empacota um evento como a requisição HTTP que o gateway faria; `token` errado simula um intruso. */
  delivery(event: FakeWebhookBody, token: string | null = this.webhookToken): FakeDelivery {
    const headers = new Headers({ 'content-type': 'application/json' })
    if (token !== null) headers.set('asaas-access-token', token)
    return { rawBody: JSON.stringify(event), headers }
  }

  private body(
    type: Exclude<NormalizedEvent['type'], 'ignored'>,
    charge: FakeCharge,
    splitId?: string,
  ): FakeWebhookBody {
    return {
      // Único entre instâncias: `webhook_events` guarda (provider, event_id) como chave única, como o id do Asaas.
      id: `evt_fake_${newId()}`,
      event: asaasEventNameFor(type),
      dateCreated: this.now().toISOString(),
      payment: { id: charge.providerPaymentId },
      ...(splitId ? { additionalInfo: { splitId } } : {}),
    }
  }

  private feeFor(method: CreateChargeInput['method'], grossCents: bigint): bigint {
    return method === 'pix' ? 99n : feeCents(grossCents, 299) + 49n
  }

  private mustCharge(id: string): FakeCharge {
    const charge = this.charges.get(id)
    if (!charge) throw new PaymentProviderError('not_found', 'Cobrança inexistente')
    return charge
  }

  private publicCharge(c: FakeCharge): Charge {
    return {
      providerPaymentId: c.providerPaymentId,
      orderId: c.orderId,
      method: c.method,
      status: c.status,
      grossCents: c.grossCents,
      netCents: c.netCents,
      devWalletId: c.devWalletId,
      devAmountCents: c.devAmountCents,
      splitStatus: c.splitStatus,
      checkoutUrl: c.checkoutUrl,
      pix: c.pix ? { ...c.pix } : null,
      createdAt: c.createdAt,
      paidAt: c.paidAt,
    }
  }
}
