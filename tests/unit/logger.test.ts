import { describe, expect, it } from 'vitest'
import { Writable } from 'node:stream'
import { MASK, createLogger, maskSensitive } from '@/lib/logger'

function capture() {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString())
      cb()
    },
  })
  return { lines, logger: createLogger(stream) }
}

describe('máscara do logger', () => {
  it('mascara chaves sensíveis', () => {
    const out = maskSensitive({
      token: 'abc',
      password: 'x',
      cpf: '123.456.789-09',
      bankAccount: '1234-5',
      authorization: 'Bearer zzz',
      ok: 'visivel',
    }) as Record<string, string>
    expect(out.token).toBe(MASK)
    expect(out.password).toBe(MASK)
    expect(out.cpf).toBe(MASK)
    expect(out.bankAccount).toBe(MASK)
    expect(out.authorization).toBe(MASK)
    expect(out.ok).toBe('visivel')
  })

  it('mascara CPF e CNPJ dentro de texto livre e em objetos aninhados', () => {
    const out = maskSensitive({ nested: { note: 'doc 123.456.789-09 e 12.345.678/0001-95' } }) as {
      nested: { note: string }
    }
    expect(out.nested.note).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/)
    expect(out.nested.note).not.toMatch(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/)
  })

  it('não vaza segredos na linha emitida e preserva requestId/orderId', () => {
    const { lines, logger } = capture()
    logger
      .child({ requestId: 'req-1', orderId: 'ord-1' })
      .info({ token: 'segredo-123', cpf: '12345678909', msg2: 'Bearer abc.def' }, 'cpf 123.456.789-09')
    const line = lines.join('')
    expect(line).not.toContain('segredo-123')
    expect(line).not.toContain('12345678909')
    expect(line).not.toContain('123.456.789-09')
    expect(line).not.toContain('abc.def')
    expect(line).toContain('req-1')
    expect(line).toContain('ord-1')
  })
})
