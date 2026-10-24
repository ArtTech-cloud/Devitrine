import { z } from 'zod'
import { parseBRL } from '@/lib/money'
import { documentKind, onlyDigits } from '../domain/document'

const httpUrl = z
  .string()
  .trim()
  .url('Link inválido')
  .refine((u) => /^https?:\/\//i.test(u), 'Use um link http ou https')

export const devProfileSchema = z.object({
  displayName: z.string().trim().min(2, 'Informe seu nome').max(80, 'Nome muito longo'),
  bio: z.string().trim().max(2000, 'A bio aceita até 2000 caracteres').default(''),
  portfolioLinks: z
    .string()
    .default('')
    .transform((t) => t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
    .pipe(z.array(httpUrl).max(10, 'No máximo 10 links')),
})
export type DevProfileInput = z.infer<typeof devProfileSchema>

export const kycSchema = z
  .object({
    name: z.string().trim().min(3, 'Informe o nome completo').max(120),
    cpfCnpj: z.string().trim(),
    mobilePhone: z.string().transform(onlyDigits).pipe(z.string().regex(/^\d{10,11}$/, 'Telefone com DDD')),
    postalCode: z.string().transform(onlyDigits).pipe(z.string().regex(/^\d{8}$/, 'CEP com 8 dígitos')),
    address: z.string().trim().min(2, 'Informe o endereço').max(120),
    addressNumber: z.string().trim().min(1, 'Informe o número').max(20),
    province: z.string().trim().min(2, 'Informe o bairro').max(80),
    income: z.string().trim(),
    birthDate: z.string().trim().optional(),
    companyType: z.enum(['MEI', 'LIMITED', 'INDIVIDUAL', 'ASSOCIATION']).optional(),
  })
  .transform((v, ctx) => {
    const kind = documentKind(v.cpfCnpj)
    if (!kind) {
      ctx.addIssue({ code: 'custom', message: 'CPF ou CNPJ inválido', path: ['cpfCnpj'] })
      return z.NEVER
    }
    const income = parseBRL(v.income)
    if (income === null || income <= 0n) {
      ctx.addIssue({ code: 'custom', message: 'Informe a renda ou faturamento mensal em reais', path: ['income'] })
      return z.NEVER
    }
    if (kind === 'cpf' && !/^\d{4}-\d{2}-\d{2}$/.test(v.birthDate ?? '')) {
      ctx.addIssue({ code: 'custom', message: 'Informe a data de nascimento', path: ['birthDate'] })
      return z.NEVER
    }
    if (kind === 'cnpj' && !v.companyType) {
      ctx.addIssue({ code: 'custom', message: 'Informe o tipo de empresa', path: ['companyType'] })
      return z.NEVER
    }
    return {
      name: v.name,
      cpfCnpj: onlyDigits(v.cpfCnpj),
      mobilePhone: v.mobilePhone,
      postalCode: v.postalCode,
      address: v.address,
      addressNumber: v.addressNumber,
      province: v.province,
      incomeCents: Number(income),
      birthDate: kind === 'cpf' ? v.birthDate : undefined,
      companyType: kind === 'cnpj' ? v.companyType : undefined,
    }
  })
export type KycInput = z.output<typeof kycSchema>

export const curationDecisionSchema = z.object({
  devId: z.string().uuid(),
  status: z.enum(['approved', 'suspended']),
  reason: z.string().trim().max(500).default(''),
})
