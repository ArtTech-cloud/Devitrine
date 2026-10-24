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
