import { sql } from 'drizzle-orm'
import { boolean, char, check, date, numeric, text, uuid } from 'drizzle-orm/pg-core'
import { app, rowMetaColumns, timestamptz } from './_app'

// Tenant root: businesses.id is the business_id used by every tenant table.
// Created only through app.create_business() (RLS has no INSERT policy).
export const businesses = app.table(
  'businesses',
  {
    id: uuid('id').primaryKey(),
    legalName: text('legal_name').notNull(),
    legalNameAr: text('legal_name_ar'),
    businessType: text('business_type'),
    terminologyProfile: text('terminology_profile').notNull().default('general'),
    country: char('country', { length: 2 }).notNull().default('AE'),
    currency: char('currency', { length: 3 }).notNull().default('AED'),
    vatRegistered: boolean('vat_registered').notNull().default(false),
    trn: text('trn'),
    timezone: text('timezone').notNull().default('Asia/Dubai'),
    defaultLocale: text('default_locale').notNull().default('en'),
    plan: text('plan'),
    setupCompletedAt: timestamptz('setup_completed_at'),
    logoPath: text('logo_path'),
    // "Books closed up to" (D-114 rule 6): nothing dated on or before it is posted or reversed.
    booksClosedThrough: date('books_closed_through', { mode: 'string' }),
    // Expenses need approval before they are final (D-164). It applies only while the business has a
    // team (has_team); the setting is kept when the team is turned off.
    expenseApproval: boolean('expense_approval').notNull().default(false),
    // How product costs are worked out (M2 Step 6): the owner's hourly rate for the time line of a
    // business without a team (D-119, sensitive cost). NULL: not set yet. Running costs need no
    // setting: they reach products by their price (D-202, which dropped the estimate of monthly
    // purchases).
    ownerHourlyRate: numeric('owner_hourly_rate', { precision: 20, scale: 4 }),
    ...rowMetaColumns(),
  },
  () => [
    check('businesses_trn_check', sql`trn ~ '^[0-9]{15}$'`),
    check('businesses_default_locale_check', sql`default_locale in ('en', 'ar')`),
    check('businesses_owner_hourly_rate_check', sql`owner_hourly_rate > 0`),
  ],
)

export type Business = typeof businesses.$inferSelect
export type NewBusiness = typeof businesses.$inferInsert
