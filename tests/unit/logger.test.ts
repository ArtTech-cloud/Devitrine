import { describe, expect, it } from 'vitest'
import { Writable } from 'node:stream'
import { MASK, createLogger, maskSensitive, maskString } from '@/lib/logger'

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

describe('máscara do logger: vazamentos reportados pelo Vigia', () => {
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlMTIz'

  it('Error como 1º argumento: msg e stack saem sem o CPF', () => {
    const { lines, logger } = capture()
    logger.error(new Error('falha para cpf 123.456.789-09'))
    const line = lines.join('')
    expect(line).not.toContain('123.456.789-09')
    expect(line).toContain(MASK)
  })

  it('Error dentro de objeto e com mensagem: stack mascarado', () => {
    const { lines, logger } = capture()
    logger.error({ err: new Error('doc 123.456.789-09') }, 'erro ao processar')
    const line = lines.join('')
    expect(line).not.toContain('123.456.789-09')
    expect(line).toContain('erro ao processar')
  })

  it('mascara chaves bancárias em inglês e segredos extras', () => {
    const out = maskSensitive({
      accountNumber: '123', agency: '0001', routing: '021', jwt: JWT, dsn: 'https://x@sentry.io/1',
      signature: 's', otp: '123456', totp: '654321', secret: 'x', visivel: 'ok',
    }) as Record<string, string>
    for (const k of ['accountNumber', 'agency', 'routing', 'jwt', 'dsn', 'signature', 'otp', 'totp', 'secret'])
      expect(out[k], k).toBe(MASK)
    expect(out.visivel).toBe('ok')
  })

  it('mascara JWT solto e padrões chave=valor em texto e URL', () => {
    const text = `sessão ${JWT} em https://x.test/cb?access_token=abc123&apikey=k-999&ok=1 e token=abc senha: hunter2`
    const out = maskString(text)
    expect(out).not.toContain('eyJ')
    expect(out).not.toContain('abc123')
    expect(out).not.toContain('k-999')
    expect(out).not.toContain('hunter2')
    expect(out).not.toMatch(/token=abc\b/)
    expect(out).toContain('ok=1')
  })
})

describe('desempenho da máscara (payloads grandes de terceiros)', () => {
  const MB = 1_000_000
  const cases: Record<string, string> = {
    alfanumérico: 'Ab1'.repeat(MB / 3),
    'base64-like': 'Ab1_-'.repeat(MB / 5),
    'token repetido': 'tokenx'.repeat(MB / 6),
    'eyJ repetido': 'eyJabcdef'.repeat(MB / 9),
    'dígitos': '1234567890'.repeat(MB / 10),
    'espaços e =': 'token = '.repeat(MB / 8),
  }
  for (const [name, input] of Object.entries(cases)) {
    it(`maskString de ~1 MB (${name}) termina em bem menos de 200 ms`, () => {
      const t0 = performance.now()
      maskString(input)
      expect(performance.now() - t0).toBeLessThan(200)
    })
  }

  it('segredo no fim de um texto grande continua mascarado', () => {
    const out = maskString('x'.repeat(MB) + ' apikey=segredo-final')
    expect(out).not.toContain('segredo-final')
  })
})
