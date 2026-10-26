import 'server-only'
import { inngest } from '@/jobs/client'
import { withService } from '@/lib/db'
import type { RecipientGateway } from '@/modules/accounts/domain/recipient-gateway'
import { FakeRecipientGateway } from '@/modules/accounts/infra/fake-recipient-gateway'
import { logPaymentAlert } from '@/modules/payments'
import type { OrderPaymentEffects, PaymentProvider } from '@/modules/payments'
import { FakePaymentProvider } from '@/modules/payments/infra/fake-payment-provider'
import { PROCESS_EVENT_NAME } from '@/modules/webhooks'
import type { WebhookDeps } from '@/modules/webhooks'

// Único ponto em que as portas são ligadas a adaptadores (ADR-010, ADR-017). Nenhum módulo importa o
// outro: os Server Actions e jobs pedem as dependências aqui.
const globalForGateway = globalThis as unknown as {
  __recipientGateway?: RecipientGateway
  __paymentProvider?: PaymentProvider
}

export function getRecipientGateway(): RecipientGateway {
  if (process.env.NODE_ENV === 'production') {
    // O adaptador Asaas (módulo payments, Cofre) ainda não existe; o fake nunca roda em produção (ADR-009).
    throw new Error('RecipientGateway de produção indisponível: adaptador Asaas pendente (ADR-009)')
  }
  globalForGateway.__recipientGateway ??= new FakeRecipientGateway()
  return globalForGateway.__recipientGateway
}

/** O fake usa o mesmo gateway de subcontas do `accounts`, para as carteiras dos devs coincidirem. */
export function getPaymentProvider(): PaymentProvider {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('PaymentProvider de produção indisponível: adaptador Asaas pendente (ADR-017)')
  }
  globalForGateway.__paymentProvider ??= new FakePaymentProvider(getRecipientGateway(), {
    webhookToken: process.env.ASAAS_WEBHOOK_TOKEN || undefined,
  })
  return globalForGateway.__paymentProvider
}

const NOT_WIRED = 'Efeito no pedido indisponível: o módulo orders e transition() ainda não existem (ADR-020)'

/**
 * Efeitos do pagamento no pedido. Enquanto `orders` e `transition()` não existem, FALHA FECHADO: o job de webhook
 * dá erro, desfaz a transação inteira (nada é lançado no ledger) e tenta de novo. Nunca finge que o pedido foi pago.
 * Quando `orders` chegar, é aqui que a implementação (que chama `transition()`) é ligada.
 */
export function getOrderPaymentEffects(): OrderPaymentEffects {
  return {
    onPaymentConfirmed: async () => {
      throw new Error(NOT_WIRED)
    },
    onPaymentCancelled: async () => {
      throw new Error(NOT_WIRED)
    },
  }
}

/** Dependências do módulo webhooks (rota, jobs e reprocesso do admin). */
export function getWebhookDeps(): WebhookDeps {
  return {
    provider: getPaymentProvider(),
    orders: getOrderPaymentEffects(),
    alert: logPaymentAlert,
    enqueue: async (ids) => {
      await inngest.send(ids.map((webhookEventId) => ({ name: PROCESS_EVENT_NAME, data: { webhookEventId } })))
    },
    run: (fn) => withService(fn),
  }
}
