import 'server-only'
import type { RecipientGateway } from '@/modules/accounts/domain/recipient-gateway'
import { FakeRecipientGateway } from '@/modules/accounts/infra/fake-recipient-gateway'
import type { PaymentProvider } from '@/modules/payments'
import { FakePaymentProvider } from '@/modules/payments/infra/fake-payment-provider'

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
  globalForGateway.__paymentProvider ??= new FakePaymentProvider(getRecipientGateway())
  return globalForGateway.__paymentProvider
}
