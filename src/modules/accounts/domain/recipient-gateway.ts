// Porta para criar a subconta do dev e acompanhar o KYC (ADR-010). Quem implementa é o módulo
// payments (adaptador Asaas); em dev e nos testes, o fake em infra/. Dinheiro sempre em centavos.
export type KycState = 'not_started' | 'pending' | 'approved' | 'rejected'

export type CompanyType = 'MEI' | 'LIMITED' | 'INDIVIDUAL' | 'ASSOCIATION'

export interface CreateRecipientInput {
  devUserId: string
  name: string
  cpfCnpj: string
  email: string
  mobilePhone: string
  address: string
  addressNumber: string
  province: string
  postalCode: string
  incomeCents: number
  /** YYYY-MM-DD; obrigatório para CPF. */
  birthDate?: string
  /** Obrigatório para CNPJ. */
  companyType?: CompanyType
  idempotencyKey: string
}

export interface RecipientRef {
  accountId: string
  walletId: string
  onboardingUrl: string | null
}

export interface RecipientStatus {
  kyc: KycState
  onboardingUrl: string | null
}

export interface RecipientGateway {
  createRecipient(input: CreateRecipientInput): Promise<RecipientRef>
  getRecipientStatus(accountId: string): Promise<RecipientStatus>
  /** Idempotente: ligar duas vezes não gera erro nem custo. */
  enableEscrow(
    accountId: string,
    options: { daysToExpire: number; isFeePayer: boolean; idempotencyKey: string },
  ): Promise<void>
}
