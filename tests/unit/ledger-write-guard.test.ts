import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Teste-guarda do ADR-018: o ESLint não enxerga SQL cru nem alias de `schema`; este teste varre o
 * texto de todo o src/ fora do módulo ledger e do arquivo que define o schema, e falha se achar
 * qualquer referência às tabelas do ledger ou à função de escrita.
 */
const SRC = join(process.cwd(), 'src')
const FORBIDDEN =
  /ledger_entries|ledger_transactions|ledger_accounts|ledger_post|ledger_balance|ledgerEntries|ledgerTransactions|ledgerAccounts/

const ALLOWED_PREFIXES = [['modules', 'ledger'].join(sep) + sep]
const ALLOWED_FILES = [['lib', 'db', 'schema.ts'].join(sep)]

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|tsx|js|jsx|mjs|sql)$/.test(e.name) ? [join(dir, e.name)] : [],
  )
}

describe('ledger: só o módulo ledger toca as tabelas (ADR-018)', () => {
  const files = walk(SRC)
    .map((f) => relative(SRC, f))
    .filter((f) => !ALLOWED_FILES.includes(f) && !ALLOWED_PREFIXES.some((p) => f.startsWith(p)))

  it('varre arquivos de verdade', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('nenhum arquivo fora do ledger referencia tabelas, ledger_post ou ledger_balance', () => {
    const offenders = files.filter((f) => FORBIDDEN.test(readFileSync(join(SRC, f), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('o detector pega as sondas conhecidas', () => {
    for (const probe of [
      'schema.ledgerEntries',
      'sql`insert into ledger_entries (a) values (1)`',
      "sql`select ledger_post('x')`",
      "import { ledgerAccounts } from '@/lib/db/schema'",
    ]) {
      expect(FORBIDDEN.test(probe)).toBe(true)
    }
  })
})
