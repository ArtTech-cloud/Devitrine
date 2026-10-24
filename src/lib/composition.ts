import 'server-only'
import type { RecipientGateway } from '@/modules/accounts/domain/recipient-gateway'
import { FakeRecipientGateway } from '@/modules/accounts/infra/fake-recipient-gateway'

// Único ponto em que a porta de `accounts` é ligada a um adaptador (ADR-010). Nenhum módulo
// importa o outro: os Server Actions pedem as dependências aqui.
const globalForGateway = globalThis as unknown as { __recipientGateway?: RecipientGateway }

export function getRecipientGateway(): RecipientGateway {
  if (process.env.NODE_ENV === 'production') {
    // O adaptador Asaas (módulo payments, Cofre) ainda não existe; o fake nunca roda em produção (ADR-009).
    throw new Error('RecipientGateway de produção indisponível: adaptador Asaas pendente (ADR-009)')
  }
  globalForGateway.__recipientGateway ??= new FakeRecipientGateway()
  return globalForGateway.__recipientGateway
}
