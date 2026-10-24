import { defineConfig } from '@playwright/test'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: '.env.local', quiet: true })

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL, trace: 'retain-on-failure' },
  // No deploy de preview, E2E_BASE_URL aponta para a URL do preview e não sobe servidor.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'pnpm start --hostname 127.0.0.1 --port 3000' /* exige pnpm build antes */,
        url: `${baseURL}/api/health`,
        reuseExistingServer: true,
        timeout: 120_000,
      },
})
