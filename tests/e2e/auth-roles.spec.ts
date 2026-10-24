import { createClient } from '@supabase/supabase-js'
import { expect, test, type Page } from '@playwright/test'
import { totp } from './totp'

const PASSWORD = 'senha-forte-e2e-123'
const stamp = Date.now()

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

async function signUp(page: Page, email: string, role: 'client' | 'dev') {
  await page.goto('/signup')
  await page.getByLabel('E-mail').fill(email)
  await page.getByLabel('Senha').fill(PASSWORD)
  await page.getByLabel(role === 'dev' ? 'Vender serviços' : 'Comprar serviços').check()
  await page.getByRole('button', { name: 'Criar conta' }).click()
}

async function signIn(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('E-mail').fill(email)
  await page.getByLabel('Senha').fill(PASSWORD)
  await page.getByRole('button', { name: 'Entrar' }).click()
}

test('visitante sem login é mandado para /login', async ({ page }) => {
  for (const path of ['/app/client', '/app/dev', '/admin']) {
    await page.goto(path)
    await expect(page).toHaveURL(/\/login$/)
  }
})

test('respostas trazem os headers de segurança e CSP com nonce', async ({ request }) => {
  const res = await request.get('/login')
  const h = res.headers()
  expect(h['x-frame-options']).toBe('DENY')
  expect(h['strict-transport-security']).toContain('max-age=')
  expect(h['referrer-policy']).toBeTruthy()
  expect(h['permissions-policy']).toBeTruthy()
  expect(h['content-security-policy']).toMatch(/script-src[^;]*'nonce-/)
  expect(h['content-security-policy']).not.toMatch(/script-src[^;]*'unsafe-inline'/)
})

test('cliente cadastra, entra na área do cliente e não acessa dev nem admin', async ({ page }) => {
  await signUp(page, `cliente-${stamp}@e2e.test`, 'client')
  await expect(page).toHaveURL(/\/app\/client$/)
  await expect(page.getByTestId('user-role')).toHaveText('client')
  await page.goto('/app/dev')
  await expect(page).toHaveURL(/\/app\/client$/)
  await page.goto('/admin')
  await expect(page).toHaveURL(/\/app\/client$/)
  await page.getByRole('button', { name: 'Sair' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await page.goto('/app/client')
  await expect(page).toHaveURL(/\/login$/)
})

test('dev cadastra e vai para a área do dev; login volta para a mesma área', async ({ page }) => {
  const email = `dev-${stamp}@e2e.test`
  await signUp(page, email, 'dev')
  await expect(page).toHaveURL(/\/app\/dev$/)
  await expect(page.getByTestId('user-role')).toHaveText('dev')
  await page.goto('/app/client')
  await expect(page).toHaveURL(/\/app\/dev$/)
  await page.getByRole('button', { name: 'Sair' }).click()
  await signIn(page, email)
  await expect(page).toHaveURL(/\/app\/dev$/)
})

test('admin só entra no painel depois do TOTP', async ({ page }) => {
  const email = `admin-${stamp}@e2e.test`
  const { error } = await admin().auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: { role: 'admin' },
  })
  expect(error).toBeNull()

  await signIn(page, email)
  await expect(page).toHaveURL(/\/admin\/mfa$/)
  // Sem segundo fator o painel continua fechado.
  await page.goto('/admin')
  await expect(page).toHaveURL(/\/admin\/mfa$/)

  const secret = (await page.getByTestId('totp-secret').textContent())!.trim()
  await page.getByLabel('Código de 6 dígitos').fill('000000')
  await page.getByRole('button', { name: 'Verificar' }).click()
  await expect(page.getByText('Código incorreto.')).toBeVisible()

  await page.getByLabel('Código de 6 dígitos').fill(totp(secret))
  await page.getByRole('button', { name: 'Verificar' }).click()
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByTestId('user-role')).toHaveText('admin')

  // Novo login: de novo só com TOTP.
  await page.getByRole('button', { name: 'Sair' }).click()
  await signIn(page, email)
  await expect(page).toHaveURL(/\/admin\/mfa$/)
  await page.getByLabel('Código de 6 dígitos').fill(totp(secret, Date.now() + 30_000))
  await page.getByRole('button', { name: 'Verificar' }).click()
  await expect(page).toHaveURL(/\/admin$/)
})

test('cookie de sessão sai httpOnly, SameSite=Lax e Secure só em produção', async ({ page, context }) => {
  const email = `cookie-${stamp}@e2e.test`
  const check = async () => {
    const auth = (await context.cookies()).filter((c) => /^sb-.*-auth-token/.test(c.name))
    expect(auth.length).toBeGreaterThan(0)
    for (const c of auth) {
      expect(c.httpOnly, `${c.name} httpOnly`).toBe(true)
      expect(c.sameSite, `${c.name} sameSite`).toBe('Lax')
      expect(c.secure, `${c.name} secure`).toBe(process.env.E2E_COOKIE_SECURE !== 'false')
    }
  }
  await signUp(page, email, 'client')
  await expect(page).toHaveURL(/\/app\/client$/)
  await check()
  await page.getByRole('button', { name: 'Sair' }).click()
  await expect(page).toHaveURL(/\/login$/)
  await signIn(page, email)
  await expect(page).toHaveURL(/\/app\/client$/)
  await check()
})
