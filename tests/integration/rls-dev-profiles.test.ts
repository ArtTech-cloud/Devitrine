import { eq, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { schema } from '@/lib/db'
import { asService, asUser, createUser, rawAs, type TestUser } from './harness'

let devA: TestUser
let devB: TestUser
let client: TestUser
let admin: TestUser
let adminNoMfa: TestUser

const slug = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8)}`
// O insert lista só as colunas com GRANT: o Drizzle inclui todas (com DEFAULT) e o Postgres recusaria.
const insertProfile = (u: TestUser, owner: string, s: string) =>
  asUser(u, (db) =>
    db.execute(
      sql`insert into dev_profiles (user_id, slug, display_name) values (${owner}, ${s}, 'Dev Teste')`,
    ),
  )
const mkProfile = (u: TestUser, s = slug('dev')) => insertProfile(u, u.id, s)
const statusOf = (u: TestUser) =>
  asService(
    async (db) =>
      (await db.select().from(schema.devProfiles).where(eq(schema.devProfiles.userId, u.id)))[0]
        ?.status,
  )
// O Drizzle embrulha o erro do Postgres; devolvemos a causa para casar a mensagem.
const setStatus = (u: TestUser, id: string, st: string) =>
  asUser(u, (db) =>
    db.execute(sql`select admin_set_dev_status(${id}, ${st}::dev_status, 'motivo')`),
  ).catch((e: Error & { cause?: Error }) => {
    throw e.cause ?? e
  })

beforeAll(async () => {
  devA = await createUser({ signupRole: 'dev' })
  devB = await createUser({ signupRole: 'dev' })
  client = await createUser({})
  admin = await createUser({ appRole: 'admin', aal: 'aal2' })
  adminNoMfa = await createUser({ appRole: 'admin', aal: 'aal1' })
  await mkProfile(devA)
  await mkProfile(devB)
})

describe('RLS em dev_profiles', () => {
  it('dev lê só o próprio perfil', async () => {
    const rows = await asUser(devA, (db) => db.select().from(schema.devProfiles))
    expect(rows.map((r) => r.userId)).toEqual([devA.id])
  })

  it('cliente não cria perfil de dev', async () => {
    await expect(mkProfile(client)).rejects.toThrow()
  })

  it('dev não cria perfil em nome de outro', async () => {
    const d = await createUser({ signupRole: 'dev' })
    await expect(
      insertProfile(devA, d.id, slug('x')),
    ).rejects.toThrow()
  })

  it('dev edita o próprio perfil mas não o de outro', async () => {
    await asUser(devA, (db) =>
      db.update(schema.devProfiles).set({ bio: 'olá' }).where(eq(schema.devProfiles.userId, devA.id)),
    )
    const other = await asUser(devA, (db) =>
      db
        .update(schema.devProfiles)
        .set({ bio: 'invadido' })
        .where(eq(schema.devProfiles.userId, devB.id))
        .returning(),
    )
    expect(other).toHaveLength(0)
  })

  it('dev não se auto-aprova nem mexe em KYC, provedor, escrow ou slug', async () => {
    const cols: Record<string, string> = {
      status: "'approved'",
      kyc_status: "'approved'",
      provider_account_id: "'acc'",
      wallet_id: "'w'",
      escrow_enabled_at: 'now()',
      slug: "'novo-slug'",
    }
    for (const [col, value] of Object.entries(cols)) {
      await expect(
        rawAs(devA, (tx) =>
          tx.unsafe(`update public.dev_profiles set ${col} = ${value} where user_id = '${devA.id}'`),
        ),
        col,
      ).rejects.toThrow(/permission denied/)
    }
    expect(await statusOf(devA)).toBe('pending')
  })

  it('dev não insere perfil já aprovado', async () => {
    const d = await createUser({ signupRole: 'dev' })
    await expect(
      rawAs(d, (tx) =>
        tx.unsafe(
          `insert into public.dev_profiles (user_id, slug, display_name, status) values ('${d.id}', '${slug('ok')}', 'Dev', 'approved')`,
        ),
      ),
    ).rejects.toThrow(/permission denied/)
  })

  it('dev suspenso não edita o próprio perfil', async () => {
    const d = await createUser({ signupRole: 'dev' })
    await mkProfile(d)
    await setStatus(admin, d.id, 'suspended')
    const rows = await asUser(d, (db) =>
      db.update(schema.devProfiles).set({ bio: 'x' }).where(eq(schema.devProfiles.userId, d.id)).returning(),
    )
    expect(rows).toHaveLength(0)
  })

  it('cliente não lê perfis; anon e dev não apagam', async () => {
    expect(await asUser(client, (db) => db.select().from(schema.devProfiles))).toHaveLength(0)
    await expect(rawAs(null, (tx) => tx`select * from public.dev_profiles`, 'anon')).rejects.toThrow(
      /permission denied/,
    )
    await expect(
      rawAs(devA, (tx) => tx.unsafe(`delete from public.dev_profiles where user_id = '${devA.id}'`)),
    ).rejects.toThrow(/permission denied/)
  })
})

describe('vitrine pública public_dev_profiles', () => {
  it('anon vê só dev aprovado e só colunas seguras', async () => {
    const d = await createUser({ signupRole: 'dev' })
    const s = slug('pub')
    await mkProfile(d, s)
    const before = await rawAs(null, (tx) => tx`select * from public.public_dev_profiles where slug = ${s}`, 'anon')
    expect(before).toHaveLength(0)
    await setStatus(admin, d.id, 'approved')
    const noKyc = await rawAs(null, (tx) => tx`select * from public.public_dev_profiles where slug = ${s}`, 'anon')
    expect(noKyc).toHaveLength(0) // ADR-014: aprovado sem KYC aprovado continua fora da vitrine
    await asService((db) =>
      db.update(schema.devProfiles).set({ kycStatus: 'approved' }).where(eq(schema.devProfiles.userId, d.id)),
    )
    const after = await rawAs(null, (tx) => tx`select * from public.public_dev_profiles where slug = ${s}`, 'anon')
    expect(after).toHaveLength(1)
    expect(Object.keys(after[0]!).sort()).toEqual(['bio', 'display_name', 'id', 'portfolio_links', 'slug'])
    await setStatus(admin, d.id, 'suspended')
    const gone = await rawAs(null, (tx) => tx`select * from public.public_dev_profiles where slug = ${s}`, 'anon')
    expect(gone).toHaveLength(0)
  })
})

describe('curadoria de dev (admin_set_dev_status)', () => {
  it('admin com aal2 aprova, suspende e reativa; tudo vai para audit_log', async () => {
    const d = await createUser({ signupRole: 'dev' })
    await mkProfile(d)
    await setStatus(admin, d.id, 'approved')
    expect(await statusOf(d)).toBe('approved')
    await setStatus(admin, d.id, 'suspended')
    await setStatus(admin, d.id, 'approved')
    const logs = await asService((db) =>
      db.execute(sql`select diff from public.audit_log where action = 'dev.status' and entity_id = ${d.id}`),
    )
    expect(logs).toHaveLength(3)
  })

  it('transições inválidas são recusadas', async () => {
    const d = await createUser({ signupRole: 'dev' })
    await mkProfile(d)
    await setStatus(admin, d.id, 'approved')
    await expect(setStatus(admin, d.id, 'pending')).rejects.toThrow(/transição inválida/)
    await expect(setStatus(admin, d.id, 'approved')).rejects.toThrow(/transição inválida/)
  })

  it('admin sem aal2, dev e cliente não decidem', async () => {
    const d = await createUser({ signupRole: 'dev' })
    await mkProfile(d)
    for (const u of [adminNoMfa, devA, client]) {
      await expect(setStatus(u, d.id, 'approved')).rejects.toThrow(/apenas admin/)
    }
    expect(await statusOf(d)).toBe('pending')
  })

  it('admin sem aal2 não lê perfis; admin aal2 lê todos', async () => {
    expect(await asUser(adminNoMfa, (db) => db.select().from(schema.devProfiles))).toHaveLength(0)
    expect((await asUser(admin, (db) => db.select().from(schema.devProfiles))).length).toBeGreaterThanOrEqual(2)
  })
})

describe('restrições de dados', () => {
  it('slug inválido ou duplicado é recusado', async () => {
    const d = await createUser({ signupRole: 'dev' })
    await expect(mkProfile(d, 'Slug Inválido')).rejects.toThrow()
    const taken = slug('dup')
    await mkProfile(d, taken)
    const e = await createUser({ signupRole: 'dev' })
    await expect(mkProfile(e, taken)).rejects.toThrow()
  })
})
