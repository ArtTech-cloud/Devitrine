import { describe, expect, it } from 'vitest'
import { parseBRL } from '@/lib/money'
import { documentKind, isValidCnpj, isValidCpf } from '@/modules/accounts/domain/document'
import { isValidSlug, slugify, withSuffix } from '@/modules/accounts/domain/slug'
import {
  KYC_REFRESH_MIN_SECONDS,
  kycRetryAfterSeconds,
  normalizeKyc,
  shouldEnableEscrow,
} from '@/modules/accounts/domain/kyc'
import { canTransitionDev } from '@/modules/accounts/domain/dev-status'
import { FakeRecipientGateway } from '@/modules/accounts/infra/fake-recipient-gateway'
import { curationDecisionSchema, devProfileSchema, kycSchema } from '@/modules/accounts/application/schemas-dev'

describe('documentos', () => {
  it('valida CPF e CNPJ por dígito verificador', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true)
    expect(isValidCpf('529.982.247-24')).toBe(false)
    expect(isValidCpf('111.111.111-11')).toBe(false)
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true)
    expect(isValidCnpj('11.222.333/0001-82')).toBe(false)
    expect(documentKind('52998224725')).toBe('cpf')
    expect(documentKind('11222333000181')).toBe('cnpj')
    expect(documentKind('123')).toBeNull()
  })
})

describe('slug', () => {
  it('normaliza acentos e símbolos', () => {
    expect(slugify('João da Silva!')).toBe('joao-da-silva')
    expect(slugify('!!')).toBe('dev-novo')
    expect(slugify('ab')).toBe('dev-ab')
    expect(isValidSlug(slugify('Ação Ágil Ltda'))).toBe(true)
    expect(isValidSlug('Slug Inválido')).toBe(false)
    expect(isValidSlug(withSuffix(slugify('x'.repeat(80)), 'abc12'))).toBe(true)
  })
})

describe('parseBRL', () => {
  it('converte reais em centavos', () => {
    expect(parseBRL('1.500,50')).toBe(150050n)
    expect(parseBRL('R$ 10')).toBe(1000n)
    expect(parseBRL('0,5')).toBe(50n)
    expect(parseBRL('10.5')).toBeNull()
    expect(parseBRL('abc')).toBeNull()
  })
})

describe('kyc e escrow', () => {
  const base = { devStatus: 'approved', kycStatus: 'approved', hasAccount: true, escrowEnabledAt: null } as const
  it('liga escrow só com dev aprovado, KYC aprovado, conta e ainda desligado', () => {
    expect(shouldEnableEscrow(base)).toBe(true)
    expect(shouldEnableEscrow({ ...base, devStatus: 'pending' })).toBe(false)
    expect(shouldEnableEscrow({ ...base, devStatus: 'suspended' })).toBe(false)
    expect(shouldEnableEscrow({ ...base, kycStatus: 'pending' })).toBe(false)
    expect(shouldEnableEscrow({ ...base, hasAccount: false })).toBe(false)
    expect(shouldEnableEscrow({ ...base, escrowEnabledAt: new Date() })).toBe(false)
  })
  it('limita a consulta a uma por 30 s', () => {
    const now = new Date('2026-01-01T00:01:00Z')
    expect(kycRetryAfterSeconds(null, now)).toBe(0)
    expect(kycRetryAfterSeconds(new Date(now.getTime() - 10_000), now)).toBe(20)
    expect(kycRetryAfterSeconds(new Date(now.getTime() - KYC_REFRESH_MIN_SECONDS * 1000), now)).toBe(0)
  })
  it('subconta criada nunca volta a not_started', () => {
    expect(normalizeKyc('not_started')).toBe('pending')
    expect(normalizeKyc('rejected')).toBe('rejected')
  })
  it('transições de status do dev', () => {
    expect(canTransitionDev('pending', 'approved')).toBe(true)
    expect(canTransitionDev('approved', 'suspended')).toBe(true)
    expect(canTransitionDev('suspended', 'approved')).toBe(true)
    expect(canTransitionDev('approved', 'pending')).toBe(false)
    expect(canTransitionDev('approved', 'approved')).toBe(false)
  })
})

describe('FakeRecipientGateway', () => {
  const input = {
    devUserId: 'u1',
    name: 'Dev Teste',
    cpfCnpj: '52998224725',
    email: 'd@test.local',
    mobilePhone: '62999999999',
    address: 'Rua A',
    addressNumber: '10',
    province: 'Centro',
    postalCode: '74000000',
    incomeCents: 500000,
    birthDate: '1990-01-01',
    idempotencyKey: 'kyc:u1',
  }
  it('é idempotente por chave e aprova a partir da 2ª consulta', async () => {
    const g = new FakeRecipientGateway()
    const a = await g.createRecipient(input)
    const b = await g.createRecipient(input)
    expect(b.accountId).toBe(a.accountId)
    expect(g.accounts.size).toBe(1)
    expect((await g.getRecipientStatus(a.accountId)).kyc).toBe('pending')
    expect((await g.getRecipientStatus(a.accountId)).kyc).toBe('approved')
  })
  it('exige campos e documentos coerentes; force fixa o resultado', async () => {
    const g = new FakeRecipientGateway()
    await expect(g.createRecipient({ ...input, name: ' ', idempotencyKey: 'k2' })).rejects.toThrow(/obrigatórios/)
    await expect(g.createRecipient({ ...input, birthDate: undefined, idempotencyKey: 'k3' })).rejects.toThrow(/birthDate/)
    await expect(
      g.createRecipient({ ...input, cpfCnpj: '11222333000181', idempotencyKey: 'k4' }),
    ).rejects.toThrow(/companyType/)
    const a = await g.createRecipient(input)
    g.force(a.accountId, 'rejected')
    expect((await g.getRecipientStatus(a.accountId)).kyc).toBe('rejected')
  })
})

describe('schemas do dev', () => {
  it('perfil: links por linha, só http(s), máximo 10', () => {
    const ok = devProfileSchema.parse({ displayName: 'Ana', bio: '', portfolioLinks: 'https://a.dev\n\n http://b.dev ' })
    expect(ok.portfolioLinks).toEqual(['https://a.dev', 'http://b.dev'])
    expect(devProfileSchema.safeParse({ displayName: 'Ana', portfolioLinks: 'javascript:alert(1)' }).success).toBe(false)
    expect(devProfileSchema.safeParse({ displayName: 'A' }).success).toBe(false)
    const eleven = Array.from({ length: 11 }, (_, i) => `https://x.dev/${i}`).join('\n')
    expect(devProfileSchema.safeParse({ displayName: 'Ana', portfolioLinks: eleven }).success).toBe(false)
  })
  const kyc = {
    name: 'Ana Souza',
    cpfCnpj: '529.982.247-25',
    mobilePhone: '(62) 99999-9999',
    postalCode: '74000-000',
    address: 'Rua A',
    addressNumber: '10',
    province: 'Centro',
    income: '5.000,00',
    birthDate: '1990-01-01',
  }
  it('KYC: normaliza e exige campos por tipo de documento', () => {
    const v = kycSchema.parse(kyc)
    expect(v).toMatchObject({ cpfCnpj: '52998224725', mobilePhone: '62999999999', postalCode: '74000000', incomeCents: 500000 })
    expect(kycSchema.safeParse({ ...kyc, cpfCnpj: '123' }).success).toBe(false)
    expect(kycSchema.safeParse({ ...kyc, birthDate: '' }).success).toBe(false)
    expect(kycSchema.safeParse({ ...kyc, income: '0' }).success).toBe(false)
    expect(kycSchema.safeParse({ ...kyc, cpfCnpj: '11222333000181' }).success).toBe(false)
    expect(kycSchema.safeParse({ ...kyc, cpfCnpj: '11222333000181', companyType: 'MEI' }).success).toBe(true)
  })
  it('decisão de curadoria só aceita approved/suspended e uuid', () => {
    const devId = '0198f8f0-0000-7000-8000-000000000000'
    expect(curationDecisionSchema.safeParse({ devId, status: 'approved' }).success).toBe(true)
    expect(curationDecisionSchema.safeParse({ devId, status: 'pending' }).success).toBe(false)
    expect(curationDecisionSchema.safeParse({ devId: 'x', status: 'approved' }).success).toBe(false)
  })
})
