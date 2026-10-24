import 'server-only'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as schema from './schema'

export type Db = PostgresJsDatabase<typeof schema>
export { schema }

export interface UserClaims {
  sub: string
  /** Nível de autenticação do Supabase: aal1 (senha/link) ou aal2 (com TOTP). */
  aal?: 'aal1' | 'aal2'
  [key: string]: unknown
}

const globalForDb = globalThis as unknown as { __pg?: postgres.Sql }

function client(url?: string): postgres.Sql {
  if (url) return postgres(url, { max: 5, onnotice: () => {} })
  const connection = process.env.DATABASE_URL
  if (!connection) throw new Error('DATABASE_URL não definida')
  globalForDb.__pg ??= postgres(connection, { max: 10, onnotice: () => {} })
  return globalForDb.__pg
}

/**
 * Conexão de serviço (jobs e servidor): ignora a RLS. Nunca use em nome de um usuário.
 */
export async function withService<T>(fn: (db: Db) => Promise<T>, url?: string): Promise<T> {
  const pg = client(url)
  try {
    return await drizzle(pg, { schema }).transaction((tx) => fn(tx as unknown as Db))
  } finally {
    if (url) await pg.end()
  }
}

/**
 * Transação em nome de um usuário (ADR-002): `set local role authenticated` e as claims do JWT
 * antes de qualquer consulta, para a RLS valer. Uma conexão sem isso ignora a RLS.
 */
export async function withUser<T>(
  claims: UserClaims,
  fn: (db: Db) => Promise<T>,
  url?: string,
): Promise<T> {
  const pg = client(url)
  try {
    return await drizzle(pg, { schema }).transaction(async (tx) => {
      const json = JSON.stringify({ role: 'authenticated', ...claims })
      await tx.execute(sql`select set_config('request.jwt.claims', ${json}, true)`)
      await tx.execute(sql`select set_config('request.jwt.claim.sub', ${claims.sub}, true)`)
      await tx.execute(sql`set local role authenticated`)
      return fn(tx as unknown as Db)
    })
  } finally {
    if (url) await pg.end()
  }
}
