import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'

const MODULES = [
  'accounts', 'catalog', 'orders', 'payments', 'ledger', 'webhooks',
  'disputes', 'reviews', 'notifications', 'admin', 'referrals',
]

// ADR-018: só o módulo ledger escreve (e lê) as tabelas do ledger; os outros usam o index.ts dele.
// A trava vale para todo o src/ fora de src/modules/ledger e src/lib/db (onde o schema é definido).
const LEDGER_NAME_PATTERN = '^ledger(Accounts|Transactions|Entries)$'
const LEDGER_MESSAGE = 'Só o módulo ledger acessa as tabelas do ledger (ADR-018): use a API pública dele.'
const ledgerSchemaPattern = {
  group: ['@/lib/db/schema', '**/db/schema'],
  importNamePattern: LEDGER_NAME_PATTERN,
  message: LEDGER_MESSAGE,
}

// Acesso via objeto `schema` (re-exportado por @/lib/db): schema.ledgerEntries, schema['ledgerEntries'], desestruturação.
const LEDGER_MEMBER = '/^ledger(Accounts|Transactions|Entries)$/'
const ledgerSyntaxRules = [
  { selector: `MemberExpression[object.name='schema'][property.name=${LEDGER_MEMBER}]`, message: LEDGER_MESSAGE },
  { selector: `MemberExpression[object.name='schema'][computed=true][property.value=${LEDGER_MEMBER}]`, message: LEDGER_MESSAGE },
  { selector: `VariableDeclarator[init.name='schema'] > ObjectPattern > Property[key.name=${LEDGER_MEMBER}]`, message: LEDGER_MESSAGE },
  { selector: "MemberExpression[object.name='schema'][computed=true][property.type!='Literal']", message: 'Acesso dinâmico a schema[...] é proibido: pode alcançar as tabelas do ledger (ADR-018).' },
]

// ADR-001/ADR-007: um módulo só importa outro pelo index.ts.
const boundaryRules = MODULES.map((name) => ({
  files: [`src/modules/${name}/**/*.{ts,tsx}`],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        ...(name === 'ledger' ? [] : [ledgerSchemaPattern]),
        {
          group: MODULES.filter((m) => m !== name).flatMap((m) => [`@/modules/${m}/*`, `**/modules/${m}/*`]),
          message: 'Importe outro módulo só pela API pública (index.ts).',
        },
      ],
    }],
  },
}))

const config = [
  ...nextVitals,
  ...nextTs,
  { ignores: ['.next/**', 'node_modules/**', 'coverage/**', 'playwright-report/**', 'test-results/**', 'next-env.d.ts'] },
  ...boundaryRules,
  {
    // Jobs e libs não tocam o ledger direto; src/lib/db define o schema e fica de fora.
    files: ['src/jobs/**/*.{ts,tsx}', 'src/lib/**/*.{ts,tsx}'],
    ignores: ['src/lib/db/**'],
    rules: { 'no-restricted-imports': ['error', { patterns: [ledgerSchemaPattern] }] },
  },
  {
    // A UI não acessa o banco nem o interior de módulos (nem o ledger, por consequência).
    files: ['src/app/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@/lib/db', '@/lib/db/*', 'drizzle-orm', 'drizzle-orm/*', 'postgres'], message: 'Nada de SQL em componentes: use a camada application.' },
          { group: ['@/modules/*/*'], message: 'A UI usa só a API pública do módulo (index.ts).' },
          ledgerSchemaPattern,
        ],
      }],
    },
  },
  {
    // Acesso a schema.ledger* em qualquer lugar do src/ fora do ledger e de src/lib/db.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/modules/ledger/**', 'src/lib/db/**'],
    rules: { 'no-restricted-syntax': ['error', ...ledgerSyntaxRules] },
  },
]

export default config
