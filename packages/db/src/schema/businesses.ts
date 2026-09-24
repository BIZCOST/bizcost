import { sql } from 'drizzle-orm'
import { boolean, char, check, text, uuid } from 'drizzle-orm/pg-core'
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
    ...rowMetaColumns(),
  },
  () => [
    check('businesses_trn_check', sql`trn ~ '^[0-9]{15}$'`),
    check('businesses_default_locale_check', sql`default_locale in ('en', 'ar')`),
  ],
)

export type Business = typeof businesses.$inferSelect
export type NewBusiness = typeof businesses.$inferInsert
