import 'server-only'
import { eq } from 'drizzle-orm'
import { schema, type Db } from '@/lib/db'

/**
 * `true` só se o usuário existe e tem o papel `admin` em `public.users`. Ações sensíveis fora de uma sessão web
 * (reprocesso de webhook, por exemplo) conferem o ator com isto dentro da própria função, sem confiar em quem chama.
 */
export async function isAdminUser(db: Db, userId: string): Promise<boolean> {
  const [row] = await db.select({ role: schema.users.role }).from(schema.users).where(eq(schema.users.id, userId))
  return row?.role === 'admin'
}
