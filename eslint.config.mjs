import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'

const MODULES = [
  'accounts', 'catalog', 'orders', 'payments', 'ledger', 'webhooks',
  'disputes', 'reviews', 'notifications', 'admin', 'referrals',
]

// ADR-018: só o módulo ledger escreve (e lê) as tabelas do ledger; os outros usam o index.ts dele.
const LEDGER_TABLES = ['ledgerAccounts', 'ledgerTransactions', 'ledgerEntries']

// ADR-001/ADR-007: um módulo só importa outro pelo index.ts.
const boundaryRules = MODULES.map((name) => ({
  files: [`src/modules/${name}/**/*.{ts,tsx}`],
  rules: {
    'no-restricted-imports': ['error', {
      paths: name === 'ledger' ? [] : [{
        name: '@/lib/db/schema',
        importNames: LEDGER_TABLES,
        message: 'Só o módulo ledger acessa as tabelas do ledger (ADR-018): use a API pública dele.',
      }],
      patterns: [{
        group: MODULES.filter((m) => m !== name).flatMap((m) => [`@/modules/${m}/*`, `**/modules/${m}/*`]),
        message: 'Importe outro módulo só pela API pública (index.ts).',
      }],
    }],
  },
}))

const config = [
  ...nextVitals,
  ...nextTs,
  { ignores: ['.next/**', 'node_modules/**', 'coverage/**', 'playwright-report/**', 'test-results/**', 'next-env.d.ts'] },
  ...boundaryRules,
  {
    // A UI não acessa o banco nem o interior de módulos.
    files: ['src/app/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@/lib/db', '@/lib/db/*', 'drizzle-orm', 'drizzle-orm/*', 'postgres'], message: 'Nada de SQL em componentes: use a camada application.' },
          { group: ['@/modules/*/*'], message: 'A UI usa só a API pública do módulo (index.ts).' },
        ],
      }],
    },
  },
]

export default config
