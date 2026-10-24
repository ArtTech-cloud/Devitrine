import { z } from 'zod'
import { SIGNUP_ROLES } from '../domain/roles'

export const signUpSchema = z.object({
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  password: z.string().min(10, 'Use ao menos 10 caracteres').max(128),
  role: z.enum(SIGNUP_ROLES),
})

export const signInSchema = z.object({
  email: z.string().trim().toLowerCase().email('E-mail inválido'),
  password: z.string().min(1, 'Informe a senha').max(128),
})

export const totpCodeSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Código de 6 dígitos'),
})
