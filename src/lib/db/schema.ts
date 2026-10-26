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
  seq: bigint('seq', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
  txId: uuid('tx_id').notNull(),
  accountId: uuid('account_id').notNull(),
  direction: ledgerDirection('direction').notNull(),
  amountCents: bigint('amount_cents', { mode: 'bigint' }).notNull(),
  currency: text('currency').notNull().default('BRL'),
  orderId: uuid('order_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// Caixa de entrada de webhooks, cobranças e idempotência (migração 0017, ADR-020).
// webhook_events e webhook_event_runs são append-only; o status é derivado (view webhook_event_status).
export const webhookEvents = pgTable('webhook_events', {
  id: uuid('id').primaryKey(),
  provider: text('provider').notNull(),
  eventId: text('event_id').notNull(),
  type: text('type').notNull(),
  rawType: text('raw_type').notNull(),
  providerPaymentId: text('provider_payment_id'),
  splitId: text('split_id'),
  payload: jsonb('payload').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
})

export const webhookEventRuns = pgTable('webhook_event_runs', {
  seq: bigint('seq', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
  webhookEventId: uuid('webhook_event_id').notNull(),
  outcome: text('outcome').notNull(),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey(),
  orderId: uuid('order_id').notNull(),
  provider: text('provider').notNull(),
  providerPaymentId: text('provider_payment_id').notNull(),
  method: text('method').notNull(),
  status: text('status').notNull(),
  devId: uuid('dev_id').notNull(),
  devWalletId: text('dev_wallet_id').notNull(),
  grossCents: bigint('gross_cents', { mode: 'bigint' }).notNull(),
  devAmountCents: bigint('dev_amount_cents', { mode: 'bigint' }).notNull(),
  netCents: bigint('net_cents', { mode: 'bigint' }),
  currency: text('currency').notNull().default('BRL'),
  splitStatus: text('split_status').notNull().default('pending'),
  escrowId: text('escrow_id'),
  checkoutUrl: text('checkout_url'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const idempotencyKeys = pgTable('idempotency_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  scope: text('scope').notNull(),
  key: text('key').notNull(),
  requestHash: text('request_hash').notNull(),
  resultRef: text('result_ref').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const reconciliationRuns = pgTable('reconciliation_runs', {
  id: uuid('id').primaryKey(),
  windowFrom: timestamp('window_from', { withTimezone: true }).notNull(),
  windowTo: timestamp('window_to', { withTimezone: true }).notNull(),
  chargesChecked: integer('charges_checked').notNull(),
  divergences: jsonb('divergences').notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
