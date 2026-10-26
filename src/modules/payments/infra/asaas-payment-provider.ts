import { PaymentProviderError } from '../domain/errors'
import type { PaymentProvider } from '../domain/provider'

const PENDING = 'Adaptador Asaas ainda não implementado: depende do sandbox, que não foi autorizado (ADR-017)'

function notImplemented(): never {
  throw new PaymentProviderError('not_implemented', PENDING)
}

/**
 * ESBOÇO do adaptador Asaas: implementa a porta, mas não faz nenhuma chamada de rede. Os métodos ignoram
 * os argumentos de propósito (TypeScript aceita menos parâmetros que a porta).
 * TODO (portão oficial da Fase 2, só com sandbox autorizado pelo Arthur): implementar cada método
 * conforme a SPEC §8 e §9 e a documentação oficial do Asaas, e conferir o formato real do corpo do
 * webhook, do `splitId` e da garantia antes de escrever qualquer mapeamento. Nenhum endpoint, campo ou
 * nome de evento deve ser inventado aqui.
 */
export class AsaasPaymentProvider implements PaymentProvider {
  readonly name = 'asaas' as const
  createRecipient = async () => notImplemented()
  getRecipientStatus = async () => notImplemented()
  enableEscrow = async () => notImplemented()
  createCharge = async () => notImplemented()
  getCharge = async () => notImplemented()
  listCharges = async () => notImplemented()
  getEscrow = async () => notImplemented()
  releaseEscrow = async () => notImplemented()
  refund = async () => notImplemented()
  parseWebhook = async () => notImplemented()
}
