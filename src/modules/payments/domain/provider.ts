// Porta do gateway de pagamento (SPEC §8, ADR-017). Só o módulo `payments` fala com o gateway, sempre
// por aqui; hoje há o fake (dev e testes) e, no futuro, o adaptador Asaas (ainda não implementado).
// Dinheiro sempre em centavos (bigint). A conversão para o formato do gateway fica dentro do adaptador.
import type { RecipientGateway } from '@/modules/accounts'

export type PaymentMethod = 'pix' | 'card'

export type ChargeStatus =
  | 'pending'
  | 'confirmed'
  | 'received'
  | 'overdue'
  | 'refunded'
  | 'partially_refunded'
  | 'chargeback'
  | 'deleted'

/** Situação do split do dev na cobrança. `blocked` = parte do dev maior que o líquido (SPEC §8, item 4). */
export type SplitStatus = 'pending' | 'done' | 'blocked' | 'cancelled'

export interface Customer {
  name: string
  cpfCnpj: string
  email: string
  mobilePhone?: string
}

export interface CreateChargeInput {
  orderId: string
  customer: Customer
  method: PaymentMethod
  /** Valor cheio cobrado do cliente (G). */
  grossCents: bigint
  /** `walletId` do dev na subconta; o split usa valor fixo, nunca percentual. */
  devWalletId: string
  /** Parte do dev (D), valor fixo do split; precisa caber no líquido da cobrança. */
  devAmountCents: bigint
  /** Toda chamada que cria ou move dinheiro leva chave de idempotência. */
  idempotencyKey: string
}

export interface PixData {
  /** Código "copia e cola". */
  copyPasteCode: string
  qrCodeBase64: string | null
  expiresAt: Date | null
}

export interface Charge {
  providerPaymentId: string
  orderId: string
  method: PaymentMethod
  status: ChargeStatus
  grossCents: bigint
  /** Líquido depois das taxas do gateway (G − F); estimado enquanto pendente, se o gateway informar. */
  netCents: bigint | null
  devWalletId: string
  devAmountCents: bigint
  splitStatus: SplitStatus
  /** Cartão: página hospedada pelo gateway. O servidor nunca recebe número de cartão. */
  checkoutUrl: string | null
  /** Pix: dados para exibir o QR Code na página do pedido. */
  pix: PixData | null
  createdAt: Date
  paidAt: Date | null
}

export type EscrowStatus = 'active' | 'finished' | 'cancelled'

export interface Escrow {
  /** Id da garantia; é ele (e não o da cobrança) que `releaseEscrow` recebe. */
  escrowId: string
  providerPaymentId: string
  status: EscrowStatus
  amountCents: bigint
}

export interface Refund {
  providerRefundId: string
  providerPaymentId: string
  amountCents: bigint
  status: 'done' | 'pending'
}

export type WebhookProvider = 'asaas' | 'stripe' | 'fake'

export type NormalizedEventType =
  | 'payment_confirmed'
  | 'payment_received'
  | 'payment_overdue'
  | 'payment_deleted'
  | 'split_done'
  | 'split_divergence_block'
  | 'split_cancelled'
  | 'payment_refunded'
  | 'payment_partially_refunded'
  | 'chargeback_requested'
  | 'chargeback_dispute'
  | 'chargeback_reversal_awaiting'
  | 'ignored'

/**
 * Evento já autenticado e normalizado. O payload NÃO é fonte da verdade: o job busca o recurso no
 * provedor (`getCharge`) antes de agir (SPEC §9, passo 6).
 */
export interface NormalizedEvent {
  provider: WebhookProvider
  /** Id do evento no provedor; com `provider`, é a chave única de `webhook_events`. */
  eventId: string
  type: NormalizedEventType
  /** Nome original do evento no provedor, para auditoria. */
  rawType: string
  providerPaymentId: string | null
  /** Id do split (um evento `split_done` por split). */
  splitId: string | null
  occurredAt: Date | null
}

export interface ListChargesInput {
  from: Date
  to: Date
}

/**
 * Herda a criação de subconta, o KYC e o escrow da porta do `accounts` (ADR-010): mesmas assinaturas.
 * Além do esboço da SPEC §8, tem `getCharge` e `listCharges`, que o job de webhook (§9, passo 6) e a
 * conciliação diária exigem.
 */
export interface PaymentProvider extends RecipientGateway {
  /** Nome do provedor, gravado em `payments.provider` e em `webhook_events.provider`. */
  readonly name: WebhookProvider
  createCharge(input: CreateChargeInput): Promise<Charge>
  getCharge(providerPaymentId: string): Promise<Charge>
  /** Cobranças criadas no intervalo (conciliação das últimas 72 h). */
  listCharges(input: ListChargesInput): Promise<Charge[]>
  getEscrow(providerPaymentId: string): Promise<Escrow>
  releaseEscrow(escrowId: string, idempotencyKey: string): Promise<void>
  refund(
    providerPaymentId: string,
    amountCents: bigint | 'full',
    idempotencyKey: string,
  ): Promise<Refund>
  /**
   * Autentica ANTES de qualquer parse (falha com `WebhookAuthError`) e só então normaliza o corpo bruto.
   */
  parseWebhook(rawBody: string, headers: Headers): Promise<NormalizedEvent>
}
