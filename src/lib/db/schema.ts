import { boolean, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
