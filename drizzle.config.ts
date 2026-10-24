import { defineConfig } from 'drizzle-kit'

// Só gera o schema TypeScript; as migrações SQL são escritas à mão (ADR-007).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/lib/db/schema.ts',
  out: './db/drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' },
})
