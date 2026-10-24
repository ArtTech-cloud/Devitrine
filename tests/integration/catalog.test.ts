import { eq, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { schema } from '@/lib/db'
import { asService, asUser, createUser, DATABASE_URL, rawAs, type TestUser } from './harness'

process.env.DATABASE_URL ??= DATABASE_URL

import { decideDev, enableEscrowIfReady, refreshKyc, saveDevProfile, startKyc } from '@/modules/accounts/application/dev-service'
import { devProfileSchema, kycSchema } from '@/modules/accounts/application/schemas-dev'
import { FakeRecipientGateway } from '@/modules/accounts/infra/fake-recipient-gateway'
import {
  approvePackage,
  createPackage,
  editPackage,
  pausePackage,
  rejectPackageAs,
  resumePackage,
  submitPackage,
  withdrawPackage,
  type Actor,
} from '@/modules/catalog/application/package-service'
import { packageSchema } from '@/modules/catalog/application/schemas'

let admin: Actor
let adminNoMfa: Actor
let categoryId: string
const gateway = new FakeRecipientGateway()
const ensureEscrow = (devId: string) => enableEscrowIfReady(devId, gateway)

const profileInput = devProfileSchema.parse({ displayName: 'Ana Souza', bio: 'Dev', portfolioLinks: '' })
const kycInput = kycSchema.parse({
  name: 'Ana Souza',
  cpfCnpj: '52998224725',
  mobilePhone: '62999999999',
  postalCode: '74000000',
  address: 'Rua A',
  addressNumber: '10',
  province: 'Centro',
  income: '5.000,00',
  birthDate: '1990-01-01',
})

const form = (over: Record<string, string> = {}) => ({
  title: 'Landing page completa',
  summary: 'Página de vendas responsiva e rápida',
  descriptionMd: 'Detalhes',
  basic_price: '500,00',
  basic_days: '7',
  basic_revisions: '1',
  basic_scope: 'Uma página com até 5 seções',
  categoryId,
  ...over,
})
const input = (over: Record<string, string> = {}) => packageSchema.parse(form(over))

const actorOf = (u: TestUser): Actor => ({ id: u.id, email: u.email, aal: u.aal })

/** Dev com perfil; `kyc`/`approved` levam o dev até o estado pedido pelo fluxo real (com o fake). */
async function newDev(opts: { approved?: boolean; kyc?: boolean } = {}) {
  const u = await createUser({ signupRole: 'dev' })
  const actor = actorOf(u)
  await saveDevProfile(actor, profileInput)
  if (opts.kyc) {
    await startKyc(actor, kycInput, gateway)
    await asService((db) =>
      db.update(schema.devProfiles).set({ kycCheckedAt: null }).where(eq(schema.devProfiles.userId, u.id)),
    )
    await refreshKyc(actor, gateway) // 1ª consulta: pending
    await asService((db) =>
      db.update(schema.devProfiles).set({ kycCheckedAt: null }).where(eq(schema.devProfiles.userId, u.id)),
    )
    await refreshKyc(actor, gateway) // 2ª consulta: approved
  }
  if (opts.approved) await decideDev(admin, u.id, 'approved', 'ok', gateway)
  return { u, actor }
}

const pkgRow = (id: string) =>
  asService(async (db) => (await db.select().from(schema.packages).where(eq(schema.packages.id, id)))[0])
const events = (id: string) =>
  asService((db) => db.select().from(schema.packageCurationEvents).where(eq(schema.packageCurationEvents.packageId, id)))
const publicIds = () =>
  rawAs(null, async (tx) => (await tx`select id from public_packages`).map((r) => r.id as string), 'anon')

async function newPackage(actor: Actor, over: Record<string, string> = {}) {
  const r = await createPackage(actor, input(over))
  if (!r.ok) throw new Error(r.error)
  return r.value.id
}

async function publishedPackage() {
  const dev = await newDev({ approved: true, kyc: true })
  const id = await newPackage(dev.actor)
  expect((await submitPackage(dev.actor, id)).ok).toBe(true)
  expect((await approvePackage(admin, id, ensureEscrow)).ok).toBe(true)
  return { ...dev, id }
}

beforeAll(async () => {
  const a = await createUser({ appRole: 'admin', aal: 'aal2' })
  const b = await createUser({ appRole: 'admin', aal: 'aal1' })
  admin = actorOf(a)
  adminNoMfa = actorOf(b)
  categoryId = await asService(async (db) => (await db.select().from(schema.categories).limit(1))[0]!.id)
})

describe('criação e edição', () => {
  it('cria rascunho com slug do título e os níveis informados', async () => {
    const { actor } = await newDev()
    const id = await newPackage(actor, { standard_price: '900,00', standard_days: '10', standard_scope: 'Até 10 seções e blog' })
    const p = await pkgRow(id)
    expect(p?.status).toBe('draft')
    expect(p?.slug).toMatch(/^landing-page-completa/)
    const tiers = await asService((db) => db.select().from(schema.packageTiers).where(eq(schema.packageTiers.packageId, id)))
    expect(tiers.map((t) => t.tier).sort()).toEqual(['basic', 'standard'])
  })

  it('títulos iguais ganham slugs distintos', async () => {
    const a = await newDev()
    const b = await newDev()
    const [x, y] = [await newPackage(a.actor), await newPackage(b.actor)]
    expect((await pkgRow(x))?.slug).not.toBe((await pkgRow(y))?.slug)
  })

  it('cliente não cria pacote; dev suspenso não cria nem edita', async () => {
    const c = await createUser({})
    expect((await createPackage(actorOf(c), input())).ok).toBe(false)
    const { u, actor } = await newDev({ approved: true })
    const id = await newPackage(actor)
    await decideDev(admin, u.id, 'suspended', 'teste', gateway)
    expect((await createPackage(actor, input())).ok).toBe(false)
    expect((await editPackage(actor, id, input({ title: 'Outro título aqui' }))).ok).toBe(false)
    expect((await pkgRow(id))?.title).toBe('Landing page completa')
  })

  it('edição troca os níveis (remove o que saiu do formulário)', async () => {
    const { actor } = await newDev()
    const id = await newPackage(actor, { standard_price: '900,00', standard_days: '10', standard_scope: 'Até 10 seções e blog' })
    expect((await editPackage(actor, id, input({ basic_price: '600,00' }))).ok).toBe(true)
    const tiers = await asService((db) => db.select().from(schema.packageTiers).where(eq(schema.packageTiers.packageId, id)))
    expect(tiers).toHaveLength(1)
    expect(tiers[0]?.priceCents).toBe(60_000n)
  })
})

describe('RLS do catálogo', () => {
  it('dev não lê, edita, apaga nem move pacote alheio (IDOR)', async () => {
    const a = await newDev({ approved: true, kyc: true })
    const b = await newDev({ approved: true, kyc: true })
    const id = await newPackage(a.actor)
    expect(await asUser(b.u, (db) => db.select().from(schema.packages).where(eq(schema.packages.id, id)))).toHaveLength(0)
    expect((await editPackage(b.actor, id, input({ title: 'Roubado do outro dev' }))).ok).toBe(false)
    for (const act of [submitPackage, withdrawPackage, pausePackage, resumePackage]) {
      const r = await act(b.actor, id)
      expect(r.ok).toBe(false)
    }
    expect((await pkgRow(id))?.status).toBe('draft')
    const rows = await asUser(b.u, (db) =>
      db.execute(sql`delete from package_tiers where package_id = ${id} returning 1`),
    )
    expect(rows.length).toBe(0)
  })

  it('dev não altera status, slug nem publica por SQL direto', async () => {
    const { u, actor } = await newDev({ approved: true, kyc: true })
    const id = await newPackage(actor)
    await expect(
      asUser(u, (db) => db.execute(sql`update packages set status = 'published' where id = ${id}`)),
    ).rejects.toThrow()
    await expect(
      asUser(u, (db) => db.execute(sql`update packages set slug = 'x-hack' where id = ${id}`)),
    ).rejects.toThrow()
    expect((await pkgRow(id))?.status).toBe('draft')
  })

  it('níveis só mudam em rascunho: em análise, o SQL direto não altera nada', async () => {
    const { u, actor } = await newDev({ approved: true, kyc: true })
    const id = await newPackage(actor)
    expect((await submitPackage(actor, id)).ok).toBe(true)
    const upd = await asUser(u, (db) =>
      db.execute(sql`update package_tiers set price_cents = 1 where package_id = ${id} returning 1`),
    )
    expect(upd.length).toBe(0)
    const del = await asUser(u, (db) =>
      db.execute(sql`delete from package_tiers where package_id = ${id} returning 1`),
    )
    expect(del.length).toBe(0)
  })

  it('histórico de curadoria é append-only', async () => {
    const { actor } = await newDev({ approved: true, kyc: true })
    const id = await newPackage(actor)
    await submitPackage(actor, id)
    await expect(
      asService((db) => db.execute(sql`update package_curation_events set reason = 'x' where package_id = ${id}`)),
    ).rejects.toThrow()
    await expect(
      asService((db) => db.execute(sql`delete from package_curation_events where package_id = ${id}`)),
    ).rejects.toThrow()
  })
})

describe('trava de publicação', () => {
  it('dev sem aprovação ou sem KYC não envia para análise', async () => {
    const pending = await newDev({ kyc: true })
    const id1 = await newPackage(pending.actor)
    const r1 = await submitPackage(pending.actor, id1)
    expect(r1).toMatchObject({ ok: false, error: expect.stringContaining('aprovado') })

    const noKyc = await newDev({ approved: true })
    const id2 = await newPackage(noKyc.actor)
    const r2 = await submitPackage(noKyc.actor, id2)
    expect(r2).toMatchObject({ ok: false, error: expect.stringContaining('KYC') })
    expect((await pkgRow(id2))?.status).toBe('draft')
  })

  it('sem o nível Básico não envia (tiers_incomplete)', async () => {
    const { actor } = await newDev({ approved: true, kyc: true })
    const id = await newPackage(actor)
    await asService((db) => db.execute(sql`delete from package_tiers where package_id = ${id}`))
    expect(await submitPackage(actor, id)).toMatchObject({ ok: false, error: expect.stringContaining('Básico') })
  })

  it('aprovação do admin exige 2FA (aal2) e o pacote em análise', async () => {
    const { actor } = await newDev({ approved: true, kyc: true })
    const id = await newPackage(actor)
    expect((await approvePackage(admin, id, ensureEscrow)).ok).toBe(false) // ainda rascunho
    await submitPackage(actor, id)
    expect((await approvePackage(adminNoMfa, id, ensureEscrow)).ok).toBe(false)
    expect((await pkgRow(id))?.status).toBe('in_review')
    expect((await approvePackage(actor, id, ensureEscrow)).ok).toBe(false) // dev não é admin
    expect((await approvePackage(admin, id, ensureEscrow)).ok).toBe(true)
    const p = await pkgRow(id)
    expect(p?.status).toBe('published')
    expect(p?.publishedAt).not.toBeNull()
  })

  it('sem escrow ligado o admin não publica; ligado depois, publica', async () => {
    const { u, actor } = await newDev({ approved: true, kyc: true })
    const id = await newPackage(actor)
    await submitPackage(actor, id)
    await asService((db) =>
      db.update(schema.devProfiles).set({ escrowEnabledAt: null }).where(eq(schema.devProfiles.userId, u.id)),
    )
    const refused = await approvePackage(admin, id, async () => {
      throw new Error('gateway fora')
    })
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('conta de recebimento') })
    expect((await approvePackage(admin, id, ensureEscrow)).ok).toBe(true)
  })

  it('recusa do admin exige motivo, devolve a rascunho e registra o histórico', async () => {
    const { actor } = await newDev({ approved: true, kyc: true })
    const id = await newPackage(actor)
    await submitPackage(actor, id)
    expect((await rejectPackageAs(admin, id, ' ')).ok).toBe(false)
    expect((await rejectPackageAs(adminNoMfa, id, 'Falta escopo')).ok).toBe(false)
    expect((await rejectPackageAs(admin, id, 'Falta escopo')).ok).toBe(true)
    const p = await pkgRow(id)
    expect(p).toMatchObject({ status: 'draft', rejectReason: 'Falta escopo' })
    expect((await events(id)).map((e) => `${e.fromStatus}>${e.toStatus}`)).toEqual(['draft>in_review', 'in_review>draft'])
  })
})

describe('ciclo de vida e vitrine pública', () => {
  it('só pacote publicado aparece para visitante; pausar e editar tiram da vitrine', async () => {
    const { actor, id } = await publishedPackage()
    expect(await publicIds()).toContain(id)
    expect((await pausePackage(actor, id)).ok).toBe(true)
    expect(await publicIds()).not.toContain(id)
    expect((await resumePackage(actor, id)).ok).toBe(true)
    expect(await publicIds()).toContain(id)
    expect((await editPackage(actor, id, input({ title: 'Título novo do pacote' }))).ok).toBe(true)
    expect((await pkgRow(id))?.status).toBe('draft')
    expect(await publicIds()).not.toContain(id)
  })

  it('rascunho e pacote em análise não são públicos; visitante não lê tabelas', async () => {
    const { actor } = await newDev({ approved: true, kyc: true })
    const draft = await newPackage(actor)
    const review = await newPackage(actor)
    await submitPackage(actor, review)
    const ids = await publicIds()
    expect(ids).not.toContain(draft)
    expect(ids).not.toContain(review)
    await expect(rawAs(null, (tx) => tx`select id from packages`, 'anon')).rejects.toThrow()
    await expect(rawAs(null, (tx) => tx`select id from package_tiers`, 'anon')).rejects.toThrow()
  })

  it('dev suspenso some da vitrine e volta quando reativado; tiers públicos seguem a view', async () => {
    const { u, id } = await publishedPackage()
    const tiersOf = () =>
      rawAs(null, async (tx) => (await tx`select tier from public_package_tiers where package_id = ${id}`).length, 'anon')
    expect(await tiersOf()).toBe(1)
    await decideDev(admin, u.id, 'suspended', 'teste', gateway)
    expect(await publicIds()).not.toContain(id)
    expect(await tiersOf()).toBe(0)
    await decideDev(admin, u.id, 'approved', 'volta', gateway)
    expect(await publicIds()).toContain(id)
  })

  it('a vitrine não expõe dados internos', async () => {
    const { id } = await publishedPackage()
    const row = await rawAs(null, async (tx) => (await tx`select * from public_packages where id = ${id}`)[0], 'anon')
    expect(Object.keys(row ?? {}).sort()).toEqual(
      ['category_name', 'category_slug', 'description_md', 'dev_id', 'dev_name', 'dev_slug', 'id', 'published_at', 'slug', 'summary', 'title'],
    )
  })

  it('admin retira pacote publicado com motivo; dev reenvia depois', async () => {
    const { actor, id } = await publishedPackage()
    expect((await rejectPackageAs(admin, id, 'Conteúdo fora da política')).ok).toBe(true)
    expect(await publicIds()).not.toContain(id)
    expect((await submitPackage(actor, id)).ok).toBe(true)
    expect((await approvePackage(admin, id, ensureEscrow)).ok).toBe(true)
    expect(await publicIds()).toContain(id)
  })
})
