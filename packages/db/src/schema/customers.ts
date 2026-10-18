import {
  CUSTOMER_KINDS,
  DOCUMENT_NUMBER_PADDING_MAX,
  DOCUMENT_SERIES,
  EMIRATES,
  LICENSED_CUSTOMER_KINDS,
  type CustomerKind,
  type DocumentSeries,
  type Emirate,
} from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import { char, check, index, integer, text, unique } from 'drizzle-orm/pg-core'
import { timestamptz } from './_app'
import { tenantTable } from './_helpers'

const quoted = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))

// Customers (M3 Step 5; docs/DATA_MODEL.md §6; D-112, D-113, D-123, D-133; the owner's answer Q2 = A
// of D-218): one record per customer, reused by orders, sales, payments (and invoices later), in a
// list of its own apart from suppliers. Shaped like suppliers, but a name may repeat (many customers
// share names; the phone tells them apart): it is indexed by app.name_key for "Did you mean". A
// customer's kind (a person, a business, a government body), phone, email, TRN, and an address with its
// emirate (only in the UAE); a business or government customer may have its trade licence number (for
// e-invoicing later). Never an Emirates ID or a passport number. Archived, never deleted.
export const customers = tenantTable(
  'customers',
  {
    name: text('name').notNull(),
    kind: text('kind').$type<CustomerKind>().notNull().default('individual'),
    phone: text('phone'),
    email: text('email'),
    // 15 digits, as businesses.trn.
    trn: text('trn'),
    tradeLicenceNo: text('trade_licence_no'),
    addressLine: text('address_line'),
    city: text('city'),
    emirate: text('emirate').$type<Emirate>(),
    // ISO 3166-1 alpha-2.
    country: char('country', { length: 2 }).notNull().default('AE'),
    notes: text('notes'),
    archivedAt: timestamptz('archived_at'),
  },
  (t) => [
    // "Did you mean Ahmed · 050…?": the same name the way people read it (Q2).
    index('customers_name_key_idx').on(t.businessId, sql`app.name_key(name)`),
    // The list by name (names may repeat: then by id), and its cursor.
    index('customers_list_idx').on(t.businessId, sql`lower(name)`, t.id),
    check('customers_name_check', sql`btrim(name) <> '' and char_length(name) <= 100`),
    check('customers_kind_check', sql`kind in (${quoted(CUSTOMER_KINDS)})`),
    check('customers_phone_check', sql`btrim(phone) <> '' and char_length(phone) <= 30`),
    check('customers_email_check', sql`btrim(email) <> '' and char_length(email) <= 254`),
    check('customers_trn_check', sql`trn ~ '^[0-9]{15}$'`),
    check(
      'customers_trade_licence_check',
      sql`trade_licence_no is null or (kind in (${quoted(LICENSED_CUSTOMER_KINDS)})
        and btrim(trade_licence_no) <> '' and char_length(trade_licence_no) <= 50)`,
    ),
    check(
      'customers_address_check',
      sql`btrim(address_line) <> '' and char_length(address_line) <= 200`,
    ),
    check('customers_city_check', sql`btrim(city) <> '' and char_length(city) <= 100`),
    check(
      'customers_emirate_check',
      sql`emirate is null or (emirate in (${quoted(EMIRATES)}) and country = 'AE')`,
    ),
    check('customers_country_check', sql`country ~ '^[A-Z]{2}$'`),
    check('customers_notes_check', sql`char_length(notes) <= 1000`),
  ],
)

// A business's running numbers (M3 Step 5; the plan's numbering design, H9; Q25): one row per series
// (`order`, and `quotation` from Step 7; invoices and credit notes in Step 8). The next number to give, its
// prefix and zero padding. The row is locked FOR UPDATE last in the transaction that creates (or, for
// invoices, issues) a document, after any cost rows, and nothing else locks it, so it cannot deadlock;
// a rollback gives the number back. A replayed create is answered from its document before a number
// is taken. Each document keeps its number as printed and its integer (UNIQUE per business and
// series), so editing a prefix later renumbers nothing. Order numbers may skip; invoices' never.
export const documentCounters = tenantTable(
  'document_counters',
  {
    series: text('series').$type<DocumentSeries>().notNull(),
    nextNo: integer('next_no').notNull(),
    // The series' first number (M3 Step 7): settable in Settings → Documents until the first
    // document takes it (next_no = first_no), to continue from an old system.
    firstNo: integer('first_no').notNull(),
    prefix: text('prefix').notNull(),
    padding: integer('padding').notNull().default(0),
  },
  (t) => [
    unique('document_counters_series_key').on(t.businessId, t.series),
    check('document_counters_series_check', sql`series in (${quoted(DOCUMENT_SERIES)})`),
    check(
      'document_counters_next_no_check',
      sql`next_no >= 1 and first_no >= 1 and next_no >= first_no`,
    ),
    check(
      'document_counters_padding_check',
      sql`padding between 0 and ${sql.raw(String(DOCUMENT_NUMBER_PADDING_MAX))}`,
    ),
    check(
      'document_counters_prefix_check',
      sql`char_length(prefix) <= 20 and prefix !~ '[[:cntrl:]]'`,
    ),
  ],
)

export type Customer = typeof customers.$inferSelect
export type NewCustomer = typeof customers.$inferInsert
export type DocumentCounter = typeof documentCounters.$inferSelect
export type NewDocumentCounter = typeof documentCounters.$inferInsert
