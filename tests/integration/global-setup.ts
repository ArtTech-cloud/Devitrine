import { migrate } from '../../scripts/migrate'

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

export default async function setup() {
  process.env.DATABASE_URL = TEST_DATABASE_URL
  await migrate(TEST_DATABASE_URL)
}
