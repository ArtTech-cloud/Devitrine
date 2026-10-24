import 'server-only'
import { eq } from 'drizzle-orm'
import { withService, schema } from '@/lib/db'

/** Lê uma configuração da plataforma (tabela `settings`); só no servidor e nos jobs. */
export async function getSetting<T = unknown>(key: string): Promise<T | undefined> {
  return withService(async (db) => {
    const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, key))
    return row?.value as T | undefined
  })
}

export async function getNumberSetting(key: string): Promise<number> {
  const raw = await getSetting<number | string>(key)
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`Configuração numérica inválida: ${key}`)
  return n
}
