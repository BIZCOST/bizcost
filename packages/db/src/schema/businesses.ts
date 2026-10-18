import {
  DOCUMENT_ACCENT_DEFAULT,
  DOCUMENT_ACCENT_KEYS,
  EMIRATES,
  QUOTATION_VALID_DAYS_DEFAULT,
  QUOTATION_VALID_DAYS_MAX,
  type DocumentAccent,
  type Emirate,
} from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import { boolean, char, check, date, integer, numeric, text, uuid } from 'drizzle-orm/pg-core'
import { app, rowMetaColumns, timestamptz } from './_app'

const quoted = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))

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
    // The letterhead and the documents (M3 Step 7; the owner's requests of 2026-10-16, built from each
    // business's own details): how to reach the business (the PDF's footer), its address (the seller's
    // address on a tax invoice, Step 8) and trade licence (B15), shown in Settings only while
    // Quotations or Invoices are served.
    phone: text('phone'),
    phone2: text('phone_2'),
    email: text('email'),
    addressLine: text('address_line'),
    city: text('city'),
    emirate: text('emirate').$type<Emirate>(),
    tradeLicenceNo: text('trade_licence_no'),
    tradeLicenceAuthority: text('trade_licence_authority'),
    // Settings → Documents: printed on every document under the totals (bank details), the default
    // terms of a new quotation, how many days a new quotation is valid, the letterhead's accent colour
    // (DOCUMENT_ACCENTS), the logo's watermark behind the content, whole amounts without ".00" (off: tax
    // documents keep 2 decimals), and who signs: the signatory's name, a signature and a stamp
    // (images in the private bucket, uploaded and checked like the logo).
    documentFooter: text('document_footer'),
    quotationTerms: text('quotation_terms'),
    quotationValidDays: integer('quotation_valid_days')
      .notNull()
      .default(QUOTATION_VALID_DAYS_DEFAULT),
    documentAccent: text('document_accent')
      .$type<DocumentAccent>()
      .notNull()
      .default(DOCUMENT_ACCENT_DEFAULT),
    documentWatermark: boolean('document_watermark').notNull().default(true),
    documentWholeAmounts: boolean('document_whole_amounts').notNull().default(false),
    documentSignatory: text('document_signatory'),
    documentSignaturePath: text('document_signature_path'),
    documentStampPath: text('document_stamp_path'),
    ...rowMetaColumns(),
  },
  () => [
    check('businesses_trn_check', sql`trn ~ '^[0-9]{15}$'`),
    check('businesses_default_locale_check', sql`default_locale in ('en', 'ar')`),
    check('businesses_owner_hourly_rate_check', sql`owner_hourly_rate > 0`),
    check('businesses_phone_check', sql`btrim(phone) <> '' and char_length(phone) <= 30`),
    check('businesses_phone_2_check', sql`btrim(phone_2) <> '' and char_length(phone_2) <= 30`),
    check('businesses_email_check', sql`btrim(email) <> '' and char_length(email) <= 254`),
    check(
      'businesses_address_check',
      sql`btrim(address_line) <> '' and char_length(address_line) <= 200`,
    ),
    check('businesses_city_check', sql`btrim(city) <> '' and char_length(city) <= 100`),
    check(
      'businesses_emirate_check',
      sql`emirate is null or (emirate in (${quoted(EMIRATES)}) and country = 'AE')`,
    ),
    check(
      'businesses_trade_licence_check',
      sql`btrim(trade_licence_no) <> '' and char_length(trade_licence_no) <= 50`,
    ),
    check(
      'businesses_licence_authority_check',
      sql`btrim(trade_licence_authority) <> '' and char_length(trade_licence_authority) <= 100`,
    ),
    check(
      'businesses_document_footer_check',
      sql`btrim(document_footer) <> '' and char_length(document_footer) <= 1000`,
    ),
    check(
      'businesses_quotation_terms_check',
      sql`btrim(quotation_terms) <> '' and char_length(quotation_terms) <= 4000`,
    ),
    check(
      'businesses_quotation_valid_days_check',
      sql`quotation_valid_days between 1 and ${sql.raw(String(QUOTATION_VALID_DAYS_MAX))}`,
    ),
    check(
      'businesses_document_accent_check',
      sql`document_accent in (${quoted(DOCUMENT_ACCENT_KEYS)})`,
    ),
    check(
      'businesses_document_signatory_check',
      sql`btrim(document_signatory) <> '' and char_length(document_signatory) <= 100`,
    ),
  ],
)

export type Business = typeof businesses.$inferSelect
export type NewBusiness = typeof businesses.$inferInsert
