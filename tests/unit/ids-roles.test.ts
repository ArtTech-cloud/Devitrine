import { describe, expect, it } from 'vitest'
import { isUuidV7, newId } from '@/lib/ids'
import { decideAccess, homePathFor, SIGNUP_ROLES, type CurrentUser } from '@/modules/accounts/domain/roles'
import { signUpSchema } from '@/modules/accounts/application/schemas'

describe('ids', () => {
  it('gera UUID v7 únicos e ordenáveis', () => {
    const ids = Array.from({ length: 50 }, () => newId())
    expect(ids.every(isUuidV7)).toBe(true)
    expect(new Set(ids).size).toBe(50)
    expect(isUuidV7('00000000-0000-4000-8000-000000000000')).toBe(false)
  })
})

const user = (role: CurrentUser['role'], aal: CurrentUser['aal'] = 'aal1'): CurrentUser => ({
  id: 'u',
  email: 'u@x.com',
  role,
  aal,
})

describe('decideAccess', () => {
  it('exige login', () => expect(decideAccess(null, ['client'])).toBe('login'))
  it('nega papel errado', () => {
    expect(decideAccess(user('client'), ['admin'])).toBe('forbidden')
    expect(decideAccess(user('dev'), ['client'])).toBe('forbidden')
  })
  it('permite o papel certo', () => {
    expect(decideAccess(user('client'), ['client'])).toBe('allow')
    expect(decideAccess(user('dev'), ['dev'])).toBe('allow')
  })
  it('admin sem TOTP nunca passa', () => {
    expect(decideAccess(user('admin', 'aal1'), ['admin'])).toBe('mfa')
    expect(decideAccess(user('admin', 'aal2'), ['admin'])).toBe('allow')
  })
  it('cada papel tem a sua home', () => {
    expect(homePathFor('admin')).toBe('/admin')
    expect(homePathFor('dev')).toBe('/app/dev')
    expect(homePathFor('client')).toBe('/app/client')
  })
})

describe('cadastro', () => {
  it('só aceita client e dev; admin nunca pelo cadastro público', () => {
    expect(SIGNUP_ROLES).toEqual(['client', 'dev'])
    const base = { email: 'a@b.com', password: 'senha-forte-123' }
    expect(signUpSchema.safeParse({ ...base, role: 'admin' }).success).toBe(false)
    expect(signUpSchema.safeParse({ ...base, role: 'dev' }).success).toBe(true)
    expect(signUpSchema.safeParse({ ...base, password: 'curta', role: 'client' }).success).toBe(false)
  })
})
