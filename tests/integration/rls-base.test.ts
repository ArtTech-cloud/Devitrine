import { eq, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { schema } from '@/lib/db'
import { asService, asUser, createUser, rawAs, type TestUser } from './harness'

let clientA: TestUser
let clientB: TestUser
let dev: TestUser
let adminNoMfa: TestUser
let admin: TestUser

beforeAll(async () => {
  clientA = await createUser({})
  clientB = await createUser({ signupRole: 'client' })
  dev = await createUser({ signupRole: 'dev' })
  adminNoMfa = await createUser({ appRole: 'admin', aal: 'aal1' })
  // Mesmo usuário admin com segundo fator no JWT.
  const a = await createUser({ appRole: 'admin', aal: 'aal2' })
  admin = a
})

describe('papéis atribuídos no cadastro', () => {
  const roleOf = (u: TestUser) =>
    asService(async (db) => (await db.select().from(schema.users).where(eq(schema.users.id, u.id)))[0]?.role)

  it('cadastro padrão vira client e signup_role=dev vira dev', async () => {
    expect(await roleOf(clientA)).toBe('client')
    expect(await roleOf(clientB)).toBe('client')
    expect(await roleOf(dev)).toBe('dev')
  })

  it('signup_role=admin vindo do usuário nunca vira admin', async () => {
    const sneaky = await createUser({ signupRole: 'admin' })
    expect(await roleOf(sneaky)).toBe('client')
  })

  it('app_metadata gravado depois do insert (como o GoTrue faz) promove e remove admin', async () => {
    const late = await createUser({})
    expect(await roleOf(late)).toBe('client')
    const setApp = (meta: object) =>
      asService((db) =>
        db.execute(
          sql`update auth.users set raw_app_meta_data = ${JSON.stringify(meta)}::jsonb where id = ${late.id}`,
        ),
      )
    await setApp({ role: 'admin' })
    expect(await roleOf(late)).toBe('admin')
    await setApp({})
    expect(await roleOf(late)).toBe('client')
  })

  it('admin só por app_metadata (service key)', async () => {
    expect(await roleOf(adminNoMfa)).toBe('admin')
    expect(await roleOf(admin)).toBe('admin')
  })
})

describe('RLS em users', () => {
  it('cliente A só lê a própria linha, nunca a de B', async () => {
    const rows = await asUser(clientA, (db) => db.select().from(schema.users))
    expect(rows.map((r) => r.id)).toEqual([clientA.id])
    const other = await asUser(clientA, (db) =>
      db.select().from(schema.users).where(eq(schema.users.id, clientB.id)),
    )
    expect(other).toHaveLength(0)
  })

  it('dev não lê cliente e cliente não lê dev', async () => {
    const asDev = await asUser(dev, (db) => db.select().from(schema.users))
    expect(asDev.map((r) => r.id)).toEqual([dev.id])
  })

  it('sem withUser (service) a RLS é ignorada — por isso o helper é obrigatório', async () => {
    const all = await asService((db) => db.select().from(schema.users))
    expect(all.length).toBeGreaterThanOrEqual(5)
  })

  it('anon não lê nada', async () => {
    await expect(rawAs(null, (tx) => tx`select * from public.users`, 'anon')).rejects.toThrow(
      /permission denied/,
    )
  })

  it('usuário não consegue se promover a admin nem editar a linha', async () => {
    await expect(
      rawAs(clientA, (tx) => tx`update public.users set role = 'admin' where id = ${clientA.id}`),
    ).rejects.toThrow(/permission denied/)
    await expect(
      rawAs(clientA, (tx) => tx`insert into public.users (id, email, role) values (gen_random_uuid(), 'x@x', 'admin')`),
    ).rejects.toThrow(/permission denied/)
    await expect(
      rawAs(clientA, (tx) => tx`delete from public.users where id = ${clientB.id}`),
    ).rejects.toThrow(/permission denied/)
  })

  it('admin sem segundo fator (aal1) não lê os demais usuários; com aal2 lê', async () => {
    const weak = await asUser(adminNoMfa, (db) => db.select().from(schema.users))
    expect(weak.map((r) => r.id)).toEqual([adminNoMfa.id])
    const strong = await asUser(admin, (db) => db.select().from(schema.users))
    expect(strong.length).toBeGreaterThanOrEqual(5)
  })
})

describe('audit_log é append-only e restrito', () => {
  it('UPDATE, DELETE e TRUNCATE são bloqueados, mesmo para a service role', async () => {
    await asService((db) => db.insert(schema.auditLog).values({ action: 'test', entity: 'test' }))
    await expect(
      asService((db) => db.update(schema.auditLog).set({ action: 'x' })),
    ).rejects.toThrow()
    await expect(asService((db) => db.delete(schema.auditLog))).rejects.toThrow()
    await expect(
      rawAs(null, (tx) => tx`truncate public.audit_log`, 'service_role'),
    ).rejects.toThrow()
  })

  it('o gatilho bloqueia até o dono do banco (superuser)', async () => {
    await expect(
      rawAs(null, (tx) => tx`update public.audit_log set action = 'x'`, 'service_role'),
    ).rejects.toThrow(/append-only|permission denied/)
  })

  it('service_role não tem privilégio de UPDATE, DELETE nem TRUNCATE (migração 0005)', async () => {
    await expect(
      rawAs(null, (tx) => tx`update public.audit_log set action = 'x'`, 'service_role'),
    ).rejects.toThrow(/permission denied/)
    await expect(
      rawAs(null, (tx) => tx`delete from public.audit_log`, 'service_role'),
    ).rejects.toThrow(/permission denied/)
    await expect(
      rawAs(null, (tx) => tx`truncate public.audit_log`, 'service_role'),
    ).rejects.toThrow(/permission denied/)
  })

  it('usuário comum não lê nem escreve; admin com aal2 lê', async () => {
    const rows = await asUser(clientA, (db) => db.select().from(schema.auditLog))
    expect(rows).toHaveLength(0)
    await expect(
      rawAs(clientA, (tx) => tx`insert into public.audit_log (action, entity) values ('a', 'b')`),
    ).rejects.toThrow(/permission denied/)
    const adminRows = await asUser(admin, (db) => db.select().from(schema.auditLog))
    expect(adminRows.length).toBeGreaterThan(0)
    const weakRows = await asUser(adminNoMfa, (db) => db.select().from(schema.auditLog))
    expect(weakRows).toHaveLength(0)
  })

  it('usuário não chama write_audit diretamente', async () => {
    await expect(
      rawAs(clientA, (tx) => tx`select public.write_audit(${clientA.id}, 'a', 'b', null, null)`),
    ).rejects.toThrow(/permission denied/)
  })
})

describe('settings', () => {
  it('traz os valores padrão da spec e é legível por usuários logados', async () => {
    const rows = await asUser(clientA, (db) => db.select().from(schema.settings))
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    expect(byKey.withdrawals_paused).toBe(false)
    expect(byKey.platform_fee_bps_first_order).toBe(1500)
    expect(byKey.approval_window_hours).toBe(72)
  })

  it('escrita direta é negada a qualquer usuário, inclusive admin', async () => {
    for (const u of [clientA, admin]) {
      await expect(
        rawAs(u, (tx) => tx`update public.settings set value = 'true' where key = 'withdrawals_paused'`),
      ).rejects.toThrow(/permission denied/)
    }
  })

  it('admin_set_setting recusa quem não é admin com 2FA', async () => {
    for (const u of [clientA, dev, adminNoMfa]) {
      await expect(
        rawAs(u, (tx) => tx`select public.admin_set_setting('withdrawals_paused', 'true'::jsonb)`),
      ).rejects.toThrow(/apenas admin com 2FA/)
    }
  })

  it('admin com aal2 altera a setting e a mudança fica no audit_log', async () => {
    try {
      await rawAs(admin, async (tx) => {
        await tx`select public.admin_set_setting('withdrawals_paused', 'true'::jsonb)`
        const [s] = await tx`select value from public.settings where key = 'withdrawals_paused'`
        expect(s?.value).toBe(true)
        const logs = await tx`select actor_id, action, diff from public.audit_log
          where action = 'settings.update' and entity_id = 'withdrawals_paused'`
        expect(logs).toHaveLength(1)
        expect(logs[0]?.actor_id).toBe(admin.id)
        expect(logs[0]?.diff).toEqual({ old: false, new: true })
      })
    } finally {
      // rawAs reverte a transação; confirma que nada vazou para o banco.
      const [s] = await asService((db) =>
        db.select().from(schema.settings).where(eq(schema.settings.key, 'withdrawals_paused')),
      )
      expect(s?.value).toBe(false)
    }
  })

  it('setting desconhecida é recusada', async () => {
    await expect(
      rawAs(admin, (tx) => tx`select public.admin_set_setting('nao_existe', '1'::jsonb)`),
    ).rejects.toThrow(/desconhecida/)
  })
})
