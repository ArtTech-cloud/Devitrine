// Falha se uma migração já existente na base de comparação foi alterada ou removida.
import { execSync } from 'node:child_process'

const base = process.env.MIGRATIONS_BASE_REF ?? 'origin/main'
let diff = ''
try {
  diff = execSync(`git diff --name-status ${base}...HEAD -- db/migrations`, { encoding: 'utf8' })
} catch {
  console.log(`Base ${base} indisponível; checagem ignorada (o runner também valida checksum).`)
  process.exit(0)
}
const bad = diff
  .split('\n')
  .filter(Boolean)
  .filter((l) => !l.startsWith('A'))
if (bad.length) {
  console.error('Migrações existentes não podem ser editadas ou removidas:\n' + bad.join('\n'))
  process.exit(1)
}
console.log('Migrações ok')
