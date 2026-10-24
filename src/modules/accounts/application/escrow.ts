import 'server-only'
import { getRecipientGateway } from '@/lib/composition'
import { enableEscrowIfReady } from './dev-service'

/**
 * Para outros módulos (catálogo): religa o escrow do dev se curadoria e KYC já estão ok mas a
 * chamada ao gateway falhou antes. Não é Server Action; nunca exposto ao navegador.
 */
export async function ensureDevEscrow(devId: string): Promise<boolean> {
  return enableEscrowIfReady(devId, getRecipientGateway())
}
