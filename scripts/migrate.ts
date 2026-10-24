import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import postgres from 'postgres'

const DIR = join(process.cwd(), 'db', 'migrations')

/** Aplica as migrações em ordem, só para frente; migração aplicada e editada falha. */
export async function migrate(databaseUrl: string): Promise<string[]> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} })
  const applied: string[] = []
  try {
    await sql`create table if not exists public._migrations (
      name text primary key, checksum text not null, applied_at timestamptz not null default now())`
    const files = readdirSync(DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()
    for (const file of files) {
      const body = readFileSync(join(DIR, file), 'utf8')
      const checksum = createHash('sha256').update(body).digest('hex')
      const [row] = await sql`select checksum from public._migrations where name = ${file}`
      if (row) {
        if (row.checksum !== checksum) {
          throw new Error(`Migração já aplicada foi editada: ${file}`)
        }
        continue
      }
      await sql.begin(async (tx) => {
        await tx.unsafe(body)
        await tx`insert into public._migrations (name, checksum) values (${file}, ${checksum})`
      })
      applied.push(file)
    }
  } finally {
    await sql.end()
  }
  return applied
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
  migrate(url)
    .then((a) => console.log(a.length ? `Aplicadas: ${a.join(', ')}` : 'Nada a aplicar'))
    .catch((e) => {
      console.error(e)
      process.exit(1)
    })
}
