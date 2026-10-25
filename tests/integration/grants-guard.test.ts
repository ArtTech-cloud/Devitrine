import postgres from 'postgres'
import { afterAll, describe, expect, it } from 'vitest'
import { DATABASE_URL } from './harness'

/**
 * Teste-guarda (ADR-015): varre o schema public inteiro. Tabela, view ou função nova sem
 * entrada nas allowlists abaixo quebra o CI; é isso que obriga a decidir os grants de propósito.
 * Notação: 'SELECT' = privilégio na tabela toda; 'UPDATE(a,b)' = só nessas colunas.
 */
const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} })
afterAll(() => sql.end())

type Grants = Partial<Record<'anon' | 'authenticated', string[]>>

const TABLES: Record<string, Grants> = {
  _migrations: {},
  audit_log: { authenticated: ['SELECT'] },
  categories: { anon: ['SELECT'], authenticated: ['SELECT'] },
  dev_profiles: {
    authenticated: [
      'SELECT',
      'INSERT(bio,display_name,portfolio_links,slug,user_id)',
      'UPDATE(bio,display_name,portfolio_links)',
    ],
  },
  package_curation_events: { authenticated: ['SELECT'] },
  package_tiers: {
    authenticated: [
      'SELECT',
      'DELETE',
      'INSERT(delivery_days,package_id,price_cents,revisions,scope_md,tier)',
      'UPDATE(delivery_days,price_cents,revisions,scope_md)',
    ],
  },
  packages: {
    authenticated: [
      'SELECT',
      'INSERT(category_id,description_md,dev_id,id,slug,summary,title)',
      'UPDATE(category_id,description_md,summary,title)',
    ],
  },
  rate_limits: {},
  settings: { authenticated: ['SELECT'] },
  users: { authenticated: ['SELECT'] },
}

/** Views não têm RLS própria: só leitura, e escrita é sempre falha. */
const VIEWS: Record<string, Grants> = {
  public_dev_profiles: { anon: ['SELECT'], authenticated: ['SELECT'] },
  public_package_tiers: { anon: ['SELECT'], authenticated: ['SELECT'] },
  public_packages: { anon: ['SELECT'], authenticated: ['SELECT'] },
}

/** EXECUTE em funções de public: gatilhos e helpers de policy; o resto é só service_role. */
const FUNCTIONS: Grants = {
  anon: [
    'forbid_mutation()',
    'handle_auth_user_updated()',
    'handle_new_auth_user()',
    'is_admin()',
    'portfolio_links_ok(l jsonb)',
    'touch_updated_at()',
  ],
  authenticated: [
    'admin_approve_package(p_package uuid)',
    'admin_reject_package(p_package uuid, p_reason text)',
    'admin_set_dev_status(p_dev uuid, p_status dev_status, p_reason text)',
    'admin_set_setting(p_key text, p_value jsonb)',
    'catalog_pause_package(p_package uuid)',
    'catalog_resume_package(p_package uuid)',
    'catalog_submit_package(p_package uuid)',
    'catalog_withdraw_package(p_package uuid)',
    'dev_is_active(p_dev uuid)',
    'forbid_mutation()',
    'handle_auth_user_updated()',
    'handle_new_auth_user()',
    'is_admin()',
    'package_is_own_draft(p_package uuid)',
    'portfolio_links_ok(l jsonb)',
    'touch_updated_at()',
  ],
}

const ROLES = ['anon', 'authenticated'] as const
const TABLE_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
const COLUMN_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']

async function relations(kinds: string[]) {
  return sql<{ oid: number; name: string; rls: boolean }[]>`
    select c.oid::int as oid, c.relname as name, c.relrowsecurity as rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = any(${kinds}) order by c.relname`
}

async function actualGrants(oid: number, role: string): Promise<string[]> {
  const out: string[] = []
  for (const p of TABLE_PRIVS) {
    const [r] = await sql`select has_table_privilege(${role}, ${oid}::oid, ${p}) as ok`
    if (r?.ok) out.push(p)
  }
  const cols = await sql<{ name: string }[]>`
    select attname as name from pg_attribute
    where attrelid = ${oid}::oid and attnum > 0 and not attisdropped order by attname`
  for (const p of COLUMN_PRIVS) {
    if (out.includes(p)) continue
    const granted: string[] = []
    for (const c of cols) {
      const [r] = await sql`select has_column_privilege(${role}, ${oid}::oid, ${c.name}, ${p}) as ok`
      if (r?.ok) granted.push(c.name)
    }
    if (granted.length) out.push(`${p}(${granted.join(',')})`)
  }
  return out.sort()
}

describe('grants do schema public (ADR-015)', () => {
  it('toda tabela tem RLS ligada e grants só os da allowlist', async () => {
    const tables = await relations(['r', 'p'])
    const problems: string[] = []
    for (const t of tables) {
      if (!t.rls) problems.push(`${t.name}: RLS desligada`)
      const allowed = TABLES[t.name]
      if (!allowed) {
        problems.push(`${t.name}: sem entrada na allowlist do teste-guarda`)
        continue
      }
      for (const role of ROLES) {
        const actual = await actualGrants(t.oid, role)
        const expected = [...(allowed[role] ?? [])].sort()
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          problems.push(`${t.name}/${role}: tem [${actual}] e a allowlist permite [${expected}]`)
        }
      }
    }
    expect(problems).toEqual([])
    expect(tables.map((t) => t.name).sort()).toEqual(Object.keys(TABLES).sort())
  })

  it('views só dão leitura (escrita é falha) e estão na allowlist', async () => {
    const views = await relations(['v', 'm', 'f'])
    const problems: string[] = []
    for (const v of views) {
      const allowed = VIEWS[v.name]
      if (!allowed) {
        problems.push(`${v.name}: view sem entrada na allowlist do teste-guarda`)
        continue
      }
      for (const role of ROLES) {
        const actual = await actualGrants(v.oid, role)
        const writes = actual.filter((g) => !g.startsWith('SELECT'))
        if (writes.length) problems.push(`${v.name}/${role}: escrita em view [${writes}]`)
        const expected = [...(allowed[role] ?? [])].sort()
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          problems.push(`${v.name}/${role}: tem [${actual}] e a allowlist permite [${expected}]`)
        }
      }
    }
    expect(problems).toEqual([])
    expect(views.map((v) => v.name).sort()).toEqual(Object.keys(VIEWS).sort())
  })

  it('sequences de public não são acessíveis por anon nem authenticated', async () => {
    const rows = await sql`
      select c.relname, r.rolname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace, (values ('anon'), ('authenticated')) r(rolname)
      where n.nspname = 'public' and c.relkind = 'S'
        and (has_sequence_privilege(r.rolname, c.oid, 'USAGE') or has_sequence_privilege(r.rolname, c.oid, 'UPDATE'))`
    expect(rows).toEqual([])
  })

  it('EXECUTE em funções de public só para as da allowlist', async () => {
    const problems: string[] = []
    for (const role of ROLES) {
      const rows = await sql<{ sig: string }[]>`
        select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and has_function_privilege(${role}, p.oid, 'EXECUTE')
        order by 1`
      const actual = rows.map((r) => r.sig)
      const expected = [...(FUNCTIONS[role] ?? [])].sort()
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        problems.push(`${role}: tem [${actual}] e a allowlist permite [${expected}]`)
      }
    }
    expect(problems).toEqual([])
  })

  it('default privileges do dono (postgres) em public não concedem nada a anon/authenticated', async () => {
    const rows = await sql`
      select defaclobjtype as kind, defaclacl::text as acl from pg_default_acl
      where defaclnamespace = 'public'::regnamespace and defaclrole = 'postgres'::regrole`
    for (const r of rows) {
      expect(r.acl, `objeto ${r.kind}`).not.toMatch(/[{,](anon|authenticated)=/)
    }
  })

  it('anon e authenticated não alteram o registro de migrações', async () => {
    for (const role of ROLES) {
      await expect(
        sql.begin(async (tx) => {
          await tx.unsafe(`set local role ${role}`)
          await tx`delete from public._migrations`
        }),
      ).rejects.toThrow(/permission denied/)
    }
  })
})
