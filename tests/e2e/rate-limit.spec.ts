import { expect, test } from '@playwright/test'

const stamp = Date.now()

test('login bloqueia depois de 5 tentativas por IP e e-mail, com resposta genérica', async ({ page }) => {
  const email = `rate-${stamp}@e2e.test`
  await page.goto('/login')
  for (let i = 0; i < 5; i++) {
    await page.getByLabel('E-mail').fill(email)
    await page.getByLabel('Senha').fill(`errada-${i}-123456`)
    await page.getByRole('button', { name: 'Entrar' }).click()
    // O formulário só limpa o e-mail quando a resposta chega; sem isso o alerta antigo engana.
    await expect(page.getByLabel('E-mail')).toHaveValue('')
    await expect(page.getByText('E-mail ou senha incorretos.')).toBeVisible()
  }
  await page.getByLabel('E-mail').fill(email)
  await page.getByLabel('Senha').fill('errada-final-123456')
  await page.getByRole('button', { name: 'Entrar' }).click()
  await expect(page.getByText('Muitas tentativas. Aguarde alguns minutos e tente de novo.')).toBeVisible()
  // A mensagem de bloqueio não revela se o e-mail existe.
  await expect(page.getByText('E-mail ou senha incorretos.')).toHaveCount(0)
})
