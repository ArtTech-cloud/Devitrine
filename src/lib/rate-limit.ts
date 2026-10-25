import 'server-only'
import { createHmac } from 'node:crypto'
import { headers } from 'next/headers'
import { sql } from 'drizzle-orm'
import { withService } from '@/lib/db'

/** Limites do ADR-011: por IP e e-mail, e por IP. */
export const LOGIN_LIMITS = { perIpEmail: 5, perIp: 30, windowSeconds: 15 * 60 } as const

/** Conta uma tentativa na chave; `false` quando passou do limite da janela. */
export async function consumeRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  url?: string,
): Promise<boolean> {
  const rows = await withService(
    (db) => db.execute<{ ok: boolean }>(sql`select public.consume_rate_limit(${key}, ${limit}, ${windowSeconds}) as ok`),
    url,
  )
  return rows[0]?.ok === true
}

/** Chave opaca: HMAC-SHA256 com segredo do servidor, para o banco não guardar IP nem e-mail. */
export function rateLimitKey(scope: string, ...parts: string[]): string {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) throw new Error('SUPABASE_SERVICE_ROLE_KEY não definida')
  return createHmac('sha256', secret).update([scope, ...parts].join('\n')).digest('hex')
}

/** IP do cliente. Só é confiável quando a hospedagem sobrescreve x-forwarded-for (Vercel); ver ADR-011. */
export async function clientIp(): Promise<string> {
  const h = await headers()
  return h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip')?.trim() || 'unknown'
}

/** `true` quando a tentativa de login ou cadastro pode seguir. Em falha do banco, nega (fail closed). */
export async function allowAuthAttempt(
  action: 'signin' | 'signup',
  ip: string,
  email: string,
  url?: string,
): Promise<boolean> {
  const { perIpEmail, perIp, windowSeconds } = LOGIN_LIMITS
  const okIpEmail = await consumeRateLimit(
    rateLimitKey(action, ip, email.trim().toLowerCase()),
    perIpEmail,
    windowSeconds,
    url,
  )
  const okIp = await consumeRateLimit(rateLimitKey(`${action}-ip`, ip), perIp, windowSeconds, url)
  return okIpEmail && okIp
}
