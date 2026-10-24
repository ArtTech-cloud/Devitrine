import { eq } from 'drizzle-orm'
import { withUser, schema, type UserClaims } from '@/lib/db'
import type { Role } from '../domain/roles'

/** Lê o papel do usuário com a RLS ligada (ele só enxerga a própria linha). */
export async function findRoleByUserId(
  claims: UserClaims,
): Promise<{ email: string; role: Role } | null> {
  return withUser(claims, async (db) => {
    const [row] = await db
      .select({ email: schema.users.email, role: schema.users.role })
      .from(schema.users)
      .where(eq(schema.users.id, claims.sub))
      .limit(1)
    return row ?? null
  })
}
