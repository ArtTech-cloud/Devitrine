import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { withService, withUser, type Db, type UserClaims } from '@/lib/db'

/**
 * Harness reutilizável de RLS (ADR-002). Fases seguintes reaproveitam:
 *   const a = await createUser({ role: 'client' }); await asUser(a, (db) => ...)
 */
export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

export interface TestUser {
  id: string
  email: string
  aal: 'aal1' | 'aal2'
}

/** Cria o usuário em auth.users (o trigger gera public.users) como o Auth faria. */
export async function createUser(opts: {
  signupRole?: string
  appRole?: string
  aal?: 'aal1' | 'aal2'
} = {}): Promise<TestUser> {
  const id = randomUUID()
  const email = `${id}@test.local`
  const userMeta = opts.signupRole ? { signup_role: opts.signupRole } : {}
  const appMeta = opts.appRole ? { role: opts.appRole } : {}
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} })
  try {
    await sql`insert into auth.users (id, email, aud, role, raw_user_meta_data, raw_app_meta_data)
      values (${id}, ${email}, 'authenticated', 'authenticated',
        ${sql.json(userMeta)}, ${sql.json(appMeta)})`
  } finally {
    await sql.end()
  }
  return { id, email, aal: opts.aal ?? 'aal1' }
}

export function claimsOf(user: TestUser): UserClaims {
  return { sub: user.id, aal: user.aal }
}

/** Executa com a RLS ligada, como o usuário (papel authenticated + claims do JWT). */
export function asUser<T>(user: TestUser, fn: (db: Db) => Promise<T>): Promise<T> {
  return withUser(claimsOf(user), fn, DATABASE_URL)
}

/** Executa com a service role (ignora a RLS); para preparar e conferir dados. */
export function asService<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return withService(fn, DATABASE_URL)
}

/** SQL cru como um papel Postgres, dentro de uma transação revertida ao final. */
export async function rawAs<T>(
  user: TestUser | null,
  run: (sql: postgres.TransactionSql) => Promise<T>,
  role: 'authenticated' | 'anon' | 'service_role' = 'authenticated',
): Promise<T> {
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} })
  try {
    let result!: T
    try {
      await sql.begin(async (tx) => {
        if (user) {
          await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: user.id, role, aal: user.aal })}, true)`
        }
        await tx.unsafe(`set local role ${role}`)
        result = await run(tx)
        throw new Rollback()
      })
    } catch (e) {
      if (!(e instanceof Rollback)) throw e
    }
    return result
  } finally {
    await sql.end()
  }
}

class Rollback extends Error {}
