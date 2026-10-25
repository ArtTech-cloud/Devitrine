import { eq, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { schema } from '@/lib/db'
import { asService, createUser, DATABASE_URL, type TestUser } from './harness'

process.env.DATABASE_URL ??= DATABASE_URL

import {
  decideDev,
  enableEscrowIfReady,
  refreshKyc,
  saveDevProfile,
  startKyc,
} from '@/modules/accounts/application/dev-service'
import { devProfileSchema, kycSchema } from '@/modules/accounts/application/schemas-dev'
import { FakeRecipientGateway } from '@/modules/accounts/infra/fake-recipient-gateway'

let admin: TestUser
let adminNoMfa: TestUser

const profileInput = devProfileSchema.parse({ displayName: 'Ana Souza', bio: 'Dev', portfolioLinks: 'https://a.dev' })
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

const row = (u: TestUser) =>
  asService(async (db) =>
    (await db.select().from(schema.devProfiles).where(eq(schema.devProfiles.userId, u.id)))[0],
  )

async function newDev() {
  const u = await createUser({ signupRole: 'dev' })
  return { u, actor: { id: u.id, email: u.email, aal: u.aal } }
}

beforeAll(async () => {
  admin = await createUser({ appRole: 'admin', aal: 'aal2' })
  adminNoMfa = await createUser({ appRole: 'admin', aal: 'aal1' })
})

describe('perfil do dev', () => {
  it('cria com slug do nome e atualiza sem trocar o slug', async () => {
    const { actor, u } = await newDev()
    const r = await saveDevProfile(actor, profileInput)
    expect(r.ok).toBe(true)
    const first = await row(u)
    expect(first?.slug).toMatch(/^ana-souza/)
    await saveDevProfile(actor, { ...profileInput, bio: 'Nova bio' })
    const second = await row(u)
    expect(second?.slug).toBe(first?.slug)
    expect(second?.bio).toBe('Nova bio')
  })

  it('nomes iguais ganham slugs distintos', async () => {
    const a = await newDev()
    const b = await newDev()
    await saveDevProfile(a.actor, profileInput)
    await saveDevProfile(b.actor, profileInput)
    expect((await row(a.u))?.slug).not.toBe((await row(b.u))?.slug)
  })

  it('cliente não cria perfil de dev', async () => {
    const c = await createUser({})
    const r = await saveDevProfile({ id: c.id, email: c.email, aal: c.aal }, profileInput)
    expect(r.ok).toBe(false)
    expect(await row(c)).toBeUndefined()
  })

  it('dev aprovado que troca o nome volta a pending e é auditado; bio e links não mexem no status (ADR-016)', async () => {
    const { actor, u } = await newDev()
    const g = new FakeRecipientGateway()
    const adm = { id: admin.id, email: admin.email, aal: 'aal2' as const }
    await saveDevProfile(actor, profileInput)
    await decideDev(adm, u.id, 'approved', 'ok', g)
    const keep = await saveDevProfile(actor, { ...profileInput, bio: 'Outra bio', portfolioLinks: ['https://b.dev'] })
    expect(keep.ok && keep.value.sentToReview).toBe(false)
    expect((await row(u))?.status).toBe('approved')
    const same = await saveDevProfile(actor, { ...profileInput, bio: 'Outra bio', portfolioLinks: ['https://b.dev'] })
    expect(same.ok && same.value.sentToReview).toBe(false)
    expect((await row(u))?.status).toBe('approved')
    const renamed = await saveDevProfile(actor, { ...profileInput, displayName: 'Outra Marca' })
    expect(renamed.ok && renamed.value.sentToReview).toBe(true)
    expect((await row(u))?.status).toBe('pending')
    expect((await row(u))?.displayName).toBe('Outra Marca')
    const audits = await asService((db) =>
      db.execute(sql`select diff from audit_log where entity_id = ${u.id} and action = 'dev.rename_review'`),
    )
    expect(JSON.stringify([...audits])).toContain('Outra Marca')
    // Pendente de novo: renomear outra vez não gera nova transição e o admin reaprova.
    await saveDevProfile(actor, { ...profileInput, displayName: 'Terceiro Nome' })
    expect((await row(u))?.status).toBe('pending')
    expect((await decideDev(adm, u.id, 'approved', 'ok', g)).ok).toBe(true)
    expect((await row(u))?.status).toBe('approved')
  })

  it('dev pending que troca o nome continua pending', async () => {
    const { actor, u } = await newDev()
    await saveDevProfile(actor, profileInput)
    const r = await saveDevProfile(actor, { ...profileInput, displayName: 'Novo Nome' })
    expect(r.ok && r.value.sentToReview).toBe(false)
    expect((await row(u))?.status).toBe('pending')
  })

  it('dev suspenso não edita o perfil', async () => {
    const { actor, u } = await newDev()
    const g = new FakeRecipientGateway()
    await saveDevProfile(actor, profileInput)
    await decideDev({ id: admin.id, email: admin.email, aal: 'aal2' }, u.id, 'suspended', 'teste', g)
    const r = await saveDevProfile(actor, { ...profileInput, bio: 'x' })
    expect(r.ok).toBe(false)
  })
})

describe('KYC com o fake', () => {
  it('exige perfil, cria uma única subconta e recusa segundo início', async () => {
    const { actor, u } = await newDev()
    const g = new FakeRecipientGateway()
    expect((await startKyc(actor, kycInput, g)).ok).toBe(false)
    await saveDevProfile(actor, profileInput)
    const [r1, r2] = await Promise.all([startKyc(actor, kycInput, g), startKyc(actor, kycInput, g)])
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1)
    expect(g.accounts.size).toBe(1)
    const p = await row(u)
    expect(p?.kycStatus).toBe('pending')
    expect(p?.providerAccountId).toMatch(/^fake_acc_/)
    expect(p?.walletId).toMatch(/^fake_wallet_/)
  })

  it('falha do gateway libera a reserva e permite tentar de novo', async () => {
    const { actor, u } = await newDev()
    const g = new FakeRecipientGateway()
    await saveDevProfile(actor, profileInput)
    const broken = { ...g, createRecipient: async () => { throw new Error('rede') } } as unknown as FakeRecipientGateway
    const r = await startKyc(actor, kycInput, broken)
    expect(r.ok).toBe(false)
    expect((await row(u))?.kycStatus).toBe('not_started')
    expect((await startKyc(actor, kycInput, g)).ok).toBe(true)
  })

  it('consulta respeita 30 s; aprovado + curadoria liga o escrow uma única vez', async () => {
    const { actor, u } = await newDev()
    const g = new FakeRecipientGateway()
    await saveDevProfile(actor, profileInput)
    await startKyc(actor, kycInput, g)
    const first = await refreshKyc(actor, g)
    expect(first.ok && first.value.kycStatus).toBe('pending')
    const tooSoon = await refreshKyc(actor, g)
    expect(tooSoon.ok).toBe(false)
    expect(g.calls.status).toBe(1)
    // vence o intervalo e a 2ª consulta aprova o KYC
    await asService((db) =>
      db.update(schema.devProfiles).set({ kycCheckedAt: new Date(Date.now() - 60_000) }).where(eq(schema.devProfiles.userId, u.id)),
    )
    const second = await refreshKyc(actor, g)
    expect(second.ok && second.value.kycStatus).toBe('approved')
    // dev ainda pendente na curadoria: escrow não liga
    expect(g.calls.escrow).toBe(0)
    expect((await row(u))?.escrowEnabledAt).toBeNull()
    const adminActor = { id: admin.id, email: admin.email, aal: 'aal2' as const }
    expect((await decideDev(adminActor, u.id, 'approved', 'ok', g)).ok).toBe(true)
    expect(g.calls.escrow).toBe(1)
    const p = await row(u)
    expect(p?.escrowEnabledAt).not.toBeNull()
    expect([...g.accounts.values()][0]?.escrow).toEqual({ daysToExpire: 60, isFeePayer: false })
    // religar não repete a chamada
    expect(await enableEscrowIfReady(u.id, g)).toBe(false)
    expect(g.calls.escrow).toBe(1)
  })

  it('KYC recusado nunca liga escrow, mesmo com dev aprovado', async () => {
    const { actor, u } = await newDev()
    const g = new FakeRecipientGateway()
    await saveDevProfile(actor, profileInput)
    await startKyc(actor, kycInput, g)
    g.force([...g.accounts.keys()][0]!, 'rejected')
    const r = await refreshKyc(actor, g)
    expect(r.ok && r.value.kycStatus).toBe('rejected')
    await decideDev({ id: admin.id, email: admin.email, aal: 'aal2' }, u.id, 'approved', 'ok', g)
    expect(g.calls.escrow).toBe(0)
  })
})

describe('reenvio do KYC recusado', () => {
  it('dev recusado reenvia sem admin: nova subconta, escrow solto e tentativa contada', async () => {
    const { actor, u } = await newDev()
    const g = new FakeRecipientGateway()
    await saveDevProfile(actor, profileInput)
    await startKyc(actor, kycInput, g)
    const firstAccount = (await row(u))?.providerAccountId
    g.force(firstAccount!, 'rejected')
    await refreshKyc(actor, g)
    expect((await row(u))?.kycStatus).toBe('rejected')
    const again = await startKyc(actor, kycInput, g)
    expect(again.ok).toBe(true)
    const p = await row(u)
    expect(p?.kycStatus).toBe('pending')
    expect(p?.kycAttempts).toBe(1)
    expect(p?.providerAccountId).not.toBe(firstAccount)
    expect(g.accounts.size).toBe(2)
  })

  it('só o KYC recusado pode reiniciar; pendente continua recusando o segundo início', async () => {
    const { actor } = await newDev()
    const g = new FakeRecipientGateway()
    await saveDevProfile(actor, profileInput)
    await startKyc(actor, kycInput, g)
    expect((await startKyc(actor, kycInput, g)).ok).toBe(false)
    expect(g.accounts.size).toBe(1)
  })
})

describe('curadoria', () => {
  it('admin sem 2FA e transição inválida são recusados', async () => {
    const { actor, u } = await newDev()
    const g = new FakeRecipientGateway()
    await saveDevProfile(actor, profileInput)
    const noMfa = await decideDev({ id: adminNoMfa.id, email: adminNoMfa.email, aal: 'aal1' }, u.id, 'approved', '', g)
    expect(noMfa.ok).toBe(false)
    expect((await row(u))?.status).toBe('pending')
    const adminActor = { id: admin.id, email: admin.email, aal: 'aal2' as const }
    expect((await decideDev(adminActor, u.id, 'approved', '', g)).ok).toBe(true)
    expect((await decideDev(adminActor, u.id, 'approved', '', g)).ok).toBe(false)
    expect((await decideDev(adminActor, '0198f8f0-0000-7000-8000-000000000000', 'approved', '', g)).ok).toBe(false)
  })
})
