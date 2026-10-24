import { createClient } from '@supabase/supabase-js'
import { expect, test, type Browser, type Page } from '@playwright/test'
import postgres from 'postgres'
import { totp } from './totp'

// Portão da Fase 1. O gateway fake não roda em produção (`next start`), então o estado que o KYC
// e a curadoria de dev produziriam é semeado direto no banco; o que se testa aqui é o catálogo.
const PASSWORD = 'senha-forte-e2e-123'
const stamp = Date.now()
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const adminApi = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

async function signUpDev(page: Page, email: string) {
  await page.goto('/signup')
  await page.getByLabel('E-mail').fill(email)
  await page.getByLabel('Senha').fill(PASSWORD)
  await page.getByLabel('Vender serviços').check()
  await page.getByRole('button', { name: 'Criar conta' }).click()
  await expect(page).toHaveURL(/\/app\/dev$/)
}

async function seedDevProfile(email: string, name: string, kyc: 'approved' | 'not_started') {
  const sql = postgres(DATABASE_URL, { max: 1 })
  try {
    const [u] = await sql`select id from auth.users where email = ${email}`
    const ok = kyc === 'approved'
    await sql`insert into public.dev_profiles
      (user_id, slug, display_name, bio, status, kyc_status, wallet_id, provider_account_id, escrow_enabled_at)
      values (${u!.id}, ${`e2e-${stamp}-${ok ? 'ok' : 'nokyc'}`}, ${name}, 'Dev de teste do portão', 'approved',
        ${kyc}, ${ok ? 'wallet-e2e' : null}, ${ok ? `acc-e2e-${stamp}` : null},
        ${ok ? sql`now()` : null})`
  } finally {
    await sql.end()
  }
}

async function createDraft(page: Page, title: string) {
  await page.goto('/app/dev/pacotes/novo')
  await page.locator('select[name=categoryId]').selectOption({ index: 1 })
  await page.locator('input[name=title]').fill(title)
  await page.locator('input[name=summary]').fill('Página de vendas responsiva, rápida e pronta para anunciar')
  await page.locator('textarea[name=descriptionMd]').fill('Entrego a página completa em React.')
  await page.locator('input[name=basic_price]').fill('500,00')
  await page.locator('input[name=basic_days]').fill('7')
  await page.locator('input[name=basic_revisions]').fill('1')
  await page.locator('textarea[name=basic_scope]').fill('Uma página com até 5 seções')
  await page.getByRole('button', { name: 'Criar rascunho' }).click()
  await expect(page).toHaveURL(/\/app\/dev\/pacotes\/[0-9a-f-]{36}$/)
  await expect(page.getByTestId('package-status')).toHaveText('Rascunho')
}

async function adminPage(browser: Browser) {
  const email = `admin-gate-${stamp}@e2e.test`
  const { error } = await adminApi().auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: { role: 'admin' },
  })
  expect(error).toBeNull()
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto('/login')
  await page.getByLabel('E-mail').fill(email)
  await page.getByLabel('Senha').fill(PASSWORD)
  await page.getByRole('button', { name: 'Entrar' }).click()
  await expect(page).toHaveURL(/\/admin\/mfa$/)
  const secret = (await page.getByTestId('totp-secret').textContent())!.trim()
  await page.getByLabel('Código de 6 dígitos').fill(totp(secret))
  await page.getByRole('button', { name: 'Verificar' }).click()
  await expect(page).toHaveURL(/\/admin$/)
  return { page, ctx }
}

test('dev aprovado publica um pacote e o visitante vê a página', async ({ page, browser }) => {
  const title = `Landing page ${stamp}`
  const email = `dev-ok-${stamp}@e2e.test`
  await signUpDev(page, email)
  await seedDevProfile(email, 'Ana E2E', 'approved')
  await createDraft(page, title)
  const packageUrl = page.url()
  await page.getByRole('button', { name: 'Enviar para análise' }).click()
  await expect(page.getByTestId('package-status')).toHaveText('Em análise')

  // Em análise ainda não é público.
  const visitor = await browser.newContext()
  const v = await visitor.newPage()
  const slug = `landing-page-${stamp}`
  expect((await v.goto(`/pacotes/${slug}`))!.status()).toBe(404)

  const { page: adm, ctx } = await adminPage(browser)
  await adm.goto('/admin/curadoria')
  const row = adm.getByTestId('package-curation-row').filter({ hasText: title })
  await row.getByRole('button', { name: 'Publicar' }).click()
  await expect(adm.getByTestId('package-curation-row').filter({ hasText: title })).toHaveCount(0)
  await ctx.close()

  await page.goto(packageUrl)
  await expect(page.getByTestId('package-status')).toHaveText('Publicado')

  // Visitante anônimo: página, vitrine, SEO e perfil do dev.
  const res = await v.goto(`/pacotes/${slug}`)
  expect(res!.status()).toBe(200)
  await expect(v.getByRole('heading', { name: title })).toBeVisible()
  await expect(v.getByTestId('public-tier-basic')).toContainText('R$')
  await expect(v.locator('link[rel=canonical]')).toHaveAttribute('href', new RegExp(`/pacotes/${slug}$`))
  const ld = JSON.parse((await v.locator('script[type="application/ld+json"]').first().textContent())!)
  expect(ld['@type']).toBe('Service')
  expect(ld.offers.priceCurrency).toBe('BRL')
  expect(ld.offers.lowPrice).toBe('500.00')
  expect(ld.provider.name).toBe('Ana E2E')

  await v.goto('/pacotes')
  await expect(v.getByTestId('public-package').filter({ hasText: title })).toBeVisible()
  await v.goto(`/devs/e2e-${stamp}-ok`)
  await expect(v.getByRole('link', { name: title })).toBeVisible()

  const sitemap = await v.request.get('/sitemap.xml')
  expect(await sitemap.text()).toContain(`/pacotes/${slug}`)
  expect(await (await v.request.get('/robots.txt')).text()).toContain('Disallow: /admin')
  await visitor.close()
})

test('dev sem KYC não consegue publicar', async ({ page, browser }) => {
  const title = `Sem kyc ${stamp}`
  const email = `dev-nokyc-${stamp}@e2e.test`
  await signUpDev(page, email)
  await seedDevProfile(email, 'Beto E2E', 'not_started')
  await createDraft(page, title)
  await page.getByRole('button', { name: 'Enviar para análise' }).click()
  await expect(page.getByText('Conclua a verificação de identidade')).toBeVisible()
  await expect(page.getByTestId('package-status')).toHaveText('Rascunho')

  const visitor = await browser.newContext()
  const v = await visitor.newPage()
  expect((await v.goto(`/pacotes/sem-kyc-${stamp}`))!.status()).toBe(404)
  await v.goto('/pacotes')
  await expect(v.getByText(title)).toHaveCount(0)
  await visitor.close()
})

test('slug inexistente ou malformado responde 404', async ({ page }) => {
  for (const path of ['/pacotes/nao-existe-xyz', '/pacotes/%3Cscript%3E', '/devs/nao-existe-xyz']) {
    expect((await page.goto(path))!.status()).toBe(404)
  }
})
