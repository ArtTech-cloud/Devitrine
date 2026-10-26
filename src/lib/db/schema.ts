import { bigint, boolean, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const userRole = pgEnum('user_role', ['client', 'dev', 'admin'])

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull(),
  role: userRole('role').notNull().default('client'),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
})

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorId: uuid('actor_id'),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: text('entity_id'),
  diff: jsonb('diff'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const devStatus = pgEnum('dev_status', ['pending', 'approved', 'suspended'])
export const kycStatus = pgEnum('kyc_status', ['not_started', 'pending', 'approved', 'rejected'])

export const devProfiles = pgTable('dev_profiles', {
  userId: uuid('user_id').primaryKey(),
  slug: text('slug').notNull().unique(),
  displayName: text('display_name').notNull(),
  bio: text('bio').notNull().default(''),
  portfolioLinks: jsonb('portfolio_links').notNull().default([]),
  status: devStatus('status').notNull().default('pending'),
  kycStatus: kycStatus('kyc_status').notNull().default('not_started'),
  providerAccountId: text('provider_account_id').unique(),
  walletId: text('wallet_id'),
  kycLink: text('kyc_link'),
  escrowEnabledAt: timestamp('escrow_enabled_at', { withTimezone: true }),
  kycCheckedAt: timestamp('kyc_checked_at', { withTimezone: true }),
  kycAttempts: integer('kyc_attempts').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const packageStatus = pgEnum('package_status', ['draft', 'in_review', 'published', 'paused'])
export const packageTier = pgEnum('package_tier', ['basic', 'standard', 'premium'])

export const categories = pgTable('categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const packages = pgTable('packages', {
  id: uuid('id').primaryKey(),
  devId: uuid('dev_id').notNull(),
  categoryId: uuid('category_id').notNull(),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  descriptionMd: text('description_md').notNull().default(''),
  status: packageStatus('status').notNull().default('draft'),
  rejectReason: text('reject_reason'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const packageTiers = pgTable(
  'package_tiers',
  {
    packageId: uuid('package_id').notNull(),
    tier: packageTier('tier').notNull(),
    priceCents: bigint('price_cents', { mode: 'bigint' }).notNull(),
    deliveryDays: integer('delivery_days').notNull(),
    revisions: integer('revisions').notNull(),
    scopeMd: text('scope_md').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.packageId, t.tier] })],
)

export const packageCurationEvents = pgTable('package_curation_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  packageId: uuid('package_id').notNull(),
  actorId: uuid('actor_id').notNull(),
  fromStatus: packageStatus('from_status').notNull(),
  toStatus: packageStatus('to_status').notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// Ledger (migração 0016, ADR-018): só o módulo ledger escreve; as tabelas são append-only.
export const ledgerDirection = pgEnum('ledger_direction', ['debit', 'credit'])

export const ledgerAccounts = pgTable('ledger_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull(),
  ownerId: uuid('owner_id'),
  normalSide: ledgerDirection('normal_side').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const ledgerTransactions = pgTable('ledger_transactions', {
  txId: uuid('tx_id').primaryKey(),
  kind: text('kind').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  orderId: uuid('order_id'),
  linesHash: text('lines_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const ledgerEntries = pgTable('ledger_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  seq: bigint('seq', { mode: 'bigint' }).notNull(),
  txId: uuid('tx_id').notNull(),
  accountId: uuid('account_id').notNull(),
  direction: ledgerDirection('direction').notNull(),
  amountCents: bigint('amount_cents', { mode: 'bigint' }).notNull(),
  currency: text('currency').notNull().default('BRL'),
  orderId: uuid('order_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
