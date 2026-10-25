import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { asService, DATABASE_URL, rawAs } from './harness'
import { sql } from 'drizzle-orm'

process.env.DATABASE_URL ??= DATABASE_URL
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'test-service-key'

const { allowAuthAttempt, consumeRateLimit, LOGIN_LIMITS } = await import('@/lib/rate-limit')

const key = () => `t-${randomUUID()}`

describe('consume_rate_limit', () => {
  it('libera até o limite e bloqueia a partir da tentativa seguinte', async () => {
    const k = key()
    const results: boolean[] = []
    for (let i = 0; i < 7; i++) results.push(await consumeRateLimit(k, 5, 900, DATABASE_URL))
    expect(results).toEqual([true, true, true, true, true, false, false])
  })

  it('chaves diferentes não se afetam', async () => {
    const a = key()
    for (let i = 0; i < 3; i++) await consumeRateLimit(a, 2, 900, DATABASE_URL)
    expect(await consumeRateLimit(a, 2, 900, DATABASE_URL)).toBe(false)
    expect(await consumeRateLimit(key(), 2, 900, DATABASE_URL)).toBe(true)
  })

  it('janela expirada recomeça a contagem', async () => {
    const k = key()
    for (let i = 0; i < 3; i++) await consumeRateLimit(k, 2, 900, DATABASE_URL)
    expect(await consumeRateLimit(k, 2, 900, DATABASE_URL)).toBe(false)
    await asService((db) => db.execute(sql`update public.rate_limits set window_start = now() - interval '16 minutes' where key = ${k}`))
    expect(await consumeRateLimit(k, 2, 900, DATABASE_URL)).toBe(true)
  })

  it('é atômico sob concorrência: exatamente `limit` tentativas passam', async () => {
    const k = key()
    const res = await Promise.all(Array.from({ length: 20 }, () => consumeRateLimit(k, 5, 900, DATABASE_URL)))
    expect(res.filter(Boolean)).toHaveLength(5)
  })

  it('rejeita parâmetros inválidos', async () => {
    await expect(consumeRateLimit(key(), 0, 900, DATABASE_URL)).rejects.toThrow()
  })

  it('cliente, anon e authenticated não leem nem executam', async () => {
    for (const role of ['anon', 'authenticated'] as const) {
      await expect(rawAs(null, (tx) => tx`select * from public.rate_limits`, role)).rejects.toThrow(/permission denied/)
      await expect(rawAs(null, (tx) => tx`select public.consume_rate_limit('x', 1, 60)`, role)).rejects.toThrow(/permission denied/)
    }
  })
})

describe('allowAuthAttempt', () => {
  const ip = () => `203.0.113.${Math.floor(Math.random() * 250)}-${randomUUID().slice(0, 6)}`

  it('bloqueia a 6ª tentativa do mesmo IP e e-mail (sem diferenciar maiúsculas) e libera outro e-mail', async () => {
    const i = ip()
    const r: boolean[] = []
    for (let n = 0; n < 6; n++) r.push(await allowAuthAttempt('signin', i, n % 2 ? 'A@x.com' : 'a@x.com', DATABASE_URL))
    expect(r).toEqual([true, true, true, true, true, false])
    expect(await allowAuthAttempt('signin', i, 'outro@x.com', DATABASE_URL)).toBe(true)
  })

  it('bloqueia o IP depois de 30 tentativas, mesmo com e-mails diferentes', async () => {
    const i = ip()
    let last = true
    for (let n = 0; n < LOGIN_LIMITS.perIp + 1; n++) last = await allowAuthAttempt('signin', i, `u${n}@x.com`, DATABASE_URL)
    expect(last).toBe(false)
  })

  it('login e cadastro têm contadores separados', async () => {
    const i = ip()
    for (let n = 0; n < 6; n++) await allowAuthAttempt('signin', i, 'a@x.com', DATABASE_URL)
    expect(await allowAuthAttempt('signup', i, 'a@x.com', DATABASE_URL)).toBe(true)
  })

  it('o banco guarda só hash, nunca IP ou e-mail', async () => {
    const i = ip()
    await allowAuthAttempt('signin', i, 'segredo@x.com', DATABASE_URL)
    const rows = await asService((db) => db.execute<{ key: string }>(sql`select key from public.rate_limits`))
    for (const r of rows) {
      expect(r.key).not.toContain('segredo')
      expect(r.key).not.toContain(i)
    }
  })
})
