import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { getPublicEnv } from '@/lib/env'

/** Cliente Supabase com a sessão do usuário (cookies httpOnly). */
export async function createSupabaseServerClient() {
  const env = getPublicEnv()
  const store = await cookies()
  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll(items) {
        try {
          for (const { name, value, options } of items) store.set(name, value, options)
        } catch {
          // Chamado de um Server Component: o proxy atualiza a sessão.
        }
      },
    },
  })
}

/** Cliente com a service key. Só servidor e jobs; nunca importar em código de navegador. */
export function createSupabaseAdminClient() {
  const env = getPublicEnv()
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY não definida')
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
