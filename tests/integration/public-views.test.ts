import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { schema } from '@/lib/db'
import { asService, createUser, DATABASE_URL, rawAs } from './harness'

process.env.DATABASE_URL ??= DATABASE_URL

async function devWith(status: 'pending' | 'approved', kyc: 'not_started' | 'approved') {
  const u = await createUser({ signupRole: 'dev' })
  await asService((db) =>
    db.insert(schema.devProfiles).values({
      userId: u.id,
      slug: `pub-${u.id.slice(0, 8)}`,
      displayName: 'Dev Publico',
      status,
      kycStatus: kyc,
      walletId: 'w-secret',
      providerAccountId: `acc-${u.id}`,
    }),
  )
  return u
}

const visible = (id: string) =>
  rawAs(null, async (tx) => (await tx`select * from public_dev_profiles where id = ${id}`)[0], 'anon')

describe('public_dev_profiles', () => {
  it('mostra só dev aprovado com KYC aprovado, e só campos de vitrine', async () => {
    const ok = await devWith('approved', 'approved')
    const row = await visible(ok.id)
    expect(row).toBeDefined()
    expect(Object.keys(row!).sort()).toEqual(['bio', 'display_name', 'id', 'portfolio_links', 'slug'])
  })

  it('esconde dev pendente, sem KYC ou suspenso', async () => {
    expect(await visible((await devWith('pending', 'approved')).id)).toBeUndefined()
    expect(await visible((await devWith('approved', 'not_started')).id)).toBeUndefined()
    const s = await devWith('approved', 'approved')
    await asService((db) =>
      db.update(schema.devProfiles).set({ status: 'suspended' }).where(eq(schema.devProfiles.userId, s.id)),
    )
    expect(await visible(s.id)).toBeUndefined()
  })

  it('anon não lê a tabela dev_profiles', async () => {
    await expect(rawAs(null, (tx) => tx`select user_id from dev_profiles`, 'anon')).rejects.toThrow()
  })
})

describe('views públicas são somente leitura (ADR-014)', () => {
  const views = ['public_dev_profiles', 'public_packages', 'public_package_tiers']
  const roles = ['anon', 'authenticated'] as const

  it('anon e authenticated só têm SELECT', async () => {
    const privs = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
    for (const v of views) {
      for (const r of roles) {
        const sqlText = `select ${privs.map((p) => `has_table_privilege('${r}', 'public.${v}', '${p}')`).join(' or ')} as w, has_table_privilege('${r}', 'public.${v}', 'SELECT') as sel`
        const [row] = await rawAs(null, (tx) => tx.unsafe(sqlText), 'anon')
        expect(row!.w, `${r} em ${v}`).toBe(false)
        expect(row!.sel).toBe(true)
      }
    }
  })

  it('escrita via view falha com permission denied', async () => {
    for (const role of roles) {
      await expect(
        rawAs(null, (tx) => tx`update public_dev_profiles set bio = 'HACKED'`, role),
      ).rejects.toThrow(/permission denied/)
      await expect(
        rawAs(null, (tx) => tx`delete from public_dev_profiles`, role),
      ).rejects.toThrow(/permission denied/)
      await expect(
        rawAs(null, (tx) => tx`insert into public_dev_profiles (id, slug, display_name) values (gen_random_uuid(), 'x', 'x')`, role),
      ).rejects.toThrow(/permission denied/)
    }
  })

  it('public_packages não expõe dev_id', async () => {
    const cols = await rawAs(
      null,
      (tx) => tx`select column_name from information_schema.columns where table_name = 'public_packages' and table_schema = 'public'`,
      'anon',
    )
    expect(cols.map((c) => c.column_name as string)).not.toContain('dev_id')
  })

  it('CHECK recusa portfolio_links que não seja http(s)', async () => {
    const u = await devWith('approved', 'approved')
    for (const bad of ['javascript:alert(1)', 'ftp://x', ' https://x']) {
      await expect(
        asService((db) =>
          db.update(schema.devProfiles).set({ portfolioLinks: [bad] }).where(eq(schema.devProfiles.userId, u.id)),
        ),
      ).rejects.toThrow()
    }
    await asService((db) =>
      db.update(schema.devProfiles).set({ portfolioLinks: ['https://ok.dev'] }).where(eq(schema.devProfiles.userId, u.id)),
    )
  })
})

describe('troca de nome do dev aprovado volta para curadoria (ADR-016)', () => {
  const statusOf = async (id: string) =>
    (await asService((db) => db.select().from(schema.devProfiles).where(eq(schema.devProfiles.userId, id))))[0]!.status
  const asDev = (u: Awaited<ReturnType<typeof devWith>>, setClause: string, ...vals: string[]) =>
    rawAs(u, (tx) => tx.unsafe(`update dev_profiles set ${setClause} where user_id = '${u.id}'`, vals))

  it('trocar o display_name tira o perfil da vitrine e o deixa pendente', async () => {
    const u = await devWith('approved', 'approved')
    expect(await visible(u.id)).toBeDefined()
    await asService((db) => db.update(schema.devProfiles).set({ displayName: 'Outro Nome' }).where(eq(schema.devProfiles.userId, u.id)))
    expect(await statusOf(u.id)).toBe('pending')
    expect(await visible(u.id)).toBeUndefined()
  })

  it('o dev, com UPDATE direto sob RLS, também cai em pendente (e a auditoria registra)', async () => {
    const u = await devWith('approved', 'approved')
    const { asUser } = await import('./harness')
    const { sql } = await import('drizzle-orm')
    await asUser(u, (db) => db.execute(sql`update dev_profiles set display_name = 'Suporte Oficial' where user_id = ${u.id}`))
    expect(await statusOf(u.id)).toBe('pending')
    expect(await visible(u.id)).toBeUndefined()
    const audit = await asService((db) =>
      db.execute(sql`select diff from audit_log where action = 'dev.rename_review' and entity_id = ${u.id}`),
    )
    expect(audit.length).toBe(1)
  })

  it('bio e links continuam livres e não mudam o status', async () => {
    const u = await devWith('approved', 'approved')
    const { asUser } = await import('./harness')
    const { sql } = await import('drizzle-orm')
    await asUser(u, (db) =>
      db.execute(sql`update dev_profiles set bio = 'Nova bio', portfolio_links = '["https://ok.dev"]'::jsonb where user_id = ${u.id}`),
    )
    expect(await statusOf(u.id)).toBe('approved')
    expect((await visible(u.id))?.bio).toBe('Nova bio')
  })

  it('regravar o mesmo nome não muda o status', async () => {
    const u = await devWith('approved', 'approved')
    const { asUser } = await import('./harness')
    const { sql } = await import('drizzle-orm')
    await asUser(u, (db) => db.execute(sql`update dev_profiles set display_name = 'Dev Publico' where user_id = ${u.id}`))
    expect(await statusOf(u.id)).toBe('approved')
  })

  it('o dev não consegue mandar status junto com o nome (sem GRANT na coluna)', async () => {
    const u = await devWith('approved', 'approved')
    await expect(asDev(u, `display_name = 'X Y', status = 'approved'`)).rejects.toThrow(/permission denied/)
  })

  it('pacote publicado some com o perfil e volta quando o admin reaprova', async () => {
    const { sql } = await import('drizzle-orm')
    const u = await devWith('approved', 'approved')
    const pkgId = randomUUID()
    const cat = (await asService((db) => db.execute(sql`select id from categories where active limit 1`)))[0]!.id
    await asService(async (db) => {
      await db.execute(sql`insert into packages (id, dev_id, category_id, slug, title, summary, status, published_at)
        values (${pkgId}, ${u.id}, ${cat}, ${'pk-' + pkgId.slice(0, 8)}, 'Pacote de teste', 'Resumo do pacote de teste', 'published', now())`)
      await db.execute(sql`insert into package_tiers (package_id, tier, price_cents, delivery_days, revisions, scope_md)
        values (${pkgId}, 'basic', 10000, 3, 1, 'Escopo do nivel basico')`)
    })
    const pkgVisible = async () =>
      (await rawAs(null, (tx) => tx`select id from public_packages where id = ${pkgId}`, 'anon')).length === 1
    expect(await pkgVisible()).toBe(true)
    await asService((db) => db.update(schema.devProfiles).set({ displayName: 'Nome Novo' }).where(eq(schema.devProfiles.userId, u.id)))
    expect(await pkgVisible()).toBe(false)
    await asService((db) => db.update(schema.devProfiles).set({ status: 'approved' }).where(eq(schema.devProfiles.userId, u.id)))
    expect(await pkgVisible()).toBe(true)
  })
})
