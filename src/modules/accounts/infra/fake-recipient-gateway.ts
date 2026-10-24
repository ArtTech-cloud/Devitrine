import { onlyDigits } from '../domain/document'
import type {
  CreateRecipientInput,
  RecipientGateway,
  RecipientRef,
  RecipientStatus,
} from '../domain/recipient-gateway'

interface FakeAccount {
  ref: RecipientRef
  polls: number
  forced?: RecipientStatus['kyc']
  escrow?: { daysToExpire: number; isFeePayer: boolean }
}

/**
 * Adaptador de mentira para dev e testes (ADR-009): sem rede e sem sandbox do Asaas.
 * O KYC fica "pending" na primeira consulta e "approved" a partir da segunda; `force` fixa um
 * resultado (rejected, por exemplo). Nunca vai para produção: a composição recusa.
 */
export class FakeRecipientGateway implements RecipientGateway {
  readonly accounts = new Map<string, FakeAccount>()
  private readonly byKey = new Map<string, string>()
  calls = { create: 0, status: 0, escrow: 0 }

  async createRecipient(input: CreateRecipientInput): Promise<RecipientRef> {
    this.calls.create++
    const existing = this.byKey.get(input.idempotencyKey)
    if (existing) return this.accounts.get(existing)!.ref
    const missing = (
      ['name', 'cpfCnpj', 'email', 'mobilePhone', 'address', 'addressNumber', 'province', 'postalCode'] as const
    ).filter((k) => !String(input[k] ?? '').trim())
    if (missing.length) throw new Error(`Campos obrigatórios ausentes: ${missing.join(', ')}`)
    if (onlyDigits(input.cpfCnpj).length === 14 && !input.companyType) {
      throw new Error('companyType é obrigatório para CNPJ')
    }
    if (onlyDigits(input.cpfCnpj).length === 11 && !input.birthDate) {
      throw new Error('birthDate é obrigatório para CPF')
    }
    const id = crypto.randomUUID()
    const ref: RecipientRef = {
      accountId: `fake_acc_${id}`,
      walletId: `fake_wallet_${id}`,
      onboardingUrl: `https://sandbox.invalid/kyc/${id}`,
    }
    this.accounts.set(ref.accountId, { ref, polls: 0 })
    this.byKey.set(input.idempotencyKey, ref.accountId)
    return ref
  }

  async getRecipientStatus(accountId: string): Promise<RecipientStatus> {
    this.calls.status++
    const acc = this.accounts.get(accountId)
    // Conta desconhecida (servidor reiniciado): o fake assume aprovada, para não travar o dev local.
    if (!acc) return { kyc: 'approved', onboardingUrl: null }
    acc.polls++
    const kyc = acc.forced ?? (acc.polls >= 2 ? 'approved' : 'pending')
    return { kyc, onboardingUrl: kyc === 'approved' ? null : acc.ref.onboardingUrl }
  }

  async enableEscrow(
    accountId: string,
    options: { daysToExpire: number; isFeePayer: boolean; idempotencyKey: string },
  ): Promise<void> {
    this.calls.escrow++
    const acc = this.accounts.get(accountId)
    if (acc) acc.escrow = { daysToExpire: options.daysToExpire, isFeePayer: options.isFeePayer }
  }

  /** Só para testes: fixa o resultado do KYC de uma conta. */
  force(accountId: string, kyc: RecipientStatus['kyc']): void {
    const acc = this.accounts.get(accountId)
    if (!acc) throw new Error('conta fake inexistente')
    acc.forced = kyc
  }
}
