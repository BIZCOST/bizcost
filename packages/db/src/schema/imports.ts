import {
  ALIAS_KINDS,
  ALIAS_TARGETS,
  SALE_IMPORT_STATUSES,
  type AliasKind,
  type AliasTarget,
  type SaleImportStatus,
} from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import {
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { timestamptz } from './_app'
import { tenantRef, tenantTable } from './_helpers'
import { productsServices } from './catalog'
import { saleImports, salesChannels } from './sales'

// Importing sales from a file, and app fees by channel (M3 Step 4; docs/DATA_MODEL.md §6; the owner's
// answers Q8 and Q15 of D-218). The file is read in the browser and never stored (sale_imports keeps
// its hash, fingerprint and counts); its rows, summed into day × item totals, are staged here until it
// is finalized. The answers given for names not found are kept as aliases, and a file's columns as a
// profile of its layout, so the next file is quicker. A channel's statements (from a delivery app or a
// marketplace) give its fees over their days; they are `cost`.

const quoted = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))
const money = (name: string) => numeric(name, { precision: 20, scale: 4 })

/**
 * The staged rows of an import: each a day × item total read in the browser (only the mapped columns:
 * the day, the item's name as read, its code, the quantity, the amount in the import's kind and the
 * refunds in it), cleared when the import is finalized or discarded. `position` numbers them from 0, so
 * a chunk sent again adds nothing (H7). `file_rows`: how many of the file's rows it adds up.
 */
export const saleImportRows = tenantTable(
  'sale_import_rows',
  {
    importId: uuid('import_id').notNull(),
    position: integer('position').notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    name: text('name').notNull(),
    code: text('code'),
    qty: numeric('qty', { precision: 24, scale: 6 }).notNull(),
    amount: money('amount').notNull(),
    refunds: money('refunds').notNull().default('0'),
    fileRows: integer('file_rows').notNull(),
  },
  (t) => [
    tenantRef('sale_import_rows_import_fk', [t.businessId, t.importId], saleImports),
    uniqueIndex('sale_import_rows_position_key').on(t.businessId, t.importId, t.position),
    check('sale_import_rows_position_check', sql`position >= 0`),
    check('sale_import_rows_name_check', sql`btrim(name) <> '' and char_length(name) <= 300`),
    check('sale_import_rows_code_check', sql`btrim(code) <> '' and char_length(code) <= 100`),
    check('sale_import_rows_refunds_check', sql`refunds >= 0`),
    check('sale_import_rows_file_rows_check', sql`file_rows >= 1`),
  ],
)

/**
 * A file layout's columns, remembered by the fingerprint of its headers (a SHA-256 of their folded
 * names, never the headers themselves) for a source (`file`: the general importer). One click maps the
 * next file of the same export. Removed: soft-deleted.
 */
export const importProfiles = tenantTable(
  'import_profiles',
  {
    source: text('source').notNull(),
    fingerprint: char('fingerprint', { length: 64 }).notNull(),
    mapping: jsonb('mapping').$type<Record<string, unknown>>().notNull(),
    lastUsedAt: timestamptz('last_used_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('import_profiles_fingerprint_key')
      .on(t.businessId, t.source, t.fingerprint)
      .where(sql`deleted_at is null`),
    check('import_profiles_source_check', sql`source ~ '^[a-z][a-z0-9_]{0,39}$'`),
    check('import_profiles_fingerprint_check', sql`fingerprint ~ '^[0-9a-f]{64}$'`),
    check('import_profiles_mapping_check', sql`jsonb_typeof(mapping) = 'object'`),
  ],
)

/**
 * An answer given for a name or an item code a file sold (Q15): for a source, the name's key (nameKey,
 * D-158) or the code leads to a product, or says it is not something the business sells and how it
 * counts (`skip`: tips; `charge`: a service charge, a sale with no cost; `delivery`: delivery
 * charged). Retail item codes live here: products have no SKU field. `raw` is the name or code as last
 * read. One live answer per source, kind and key.
 */
export const productAliases = tenantTable(
  'product_aliases',
  {
    source: text('source').notNull(),
    kind: text('kind').$type<AliasKind>().notNull(),
    key: text('key').notNull(),
    raw: text('raw').notNull(),
    target: text('target').$type<AliasTarget>().notNull(),
    productId: uuid('product_id'),
  },
  (t) => [
    tenantRef('product_aliases_product_fk', [t.businessId, t.productId], productsServices),
    uniqueIndex('product_aliases_key')
      .on(t.businessId, t.source, t.kind, t.key)
      .where(sql`deleted_at is null`),
    index('product_aliases_product_idx').on(t.businessId, t.productId),
    check('product_aliases_source_check', sql`source ~ '^[a-z][a-z0-9_]{0,39}$'`),
    check('product_aliases_kind_check', sql`kind in (${quoted(ALIAS_KINDS)})`),
    check('product_aliases_target_check', sql`target in (${quoted(ALIAS_TARGETS)})`),
    check('product_aliases_product_check', sql`(target = 'product') = (product_id is not null)`),
    check('product_aliases_key_check', sql`key <> '' and char_length(key) <= 300`),
    check('product_aliases_raw_check', sql`btrim(raw) <> '' and char_length(raw) <= 300`),
  ],
)

/**
 * A statement of a sales channel (a delivery app's or a marketplace's, Q8): its days, the sales it
 * lists, what the app kept (commission, payment fees, other fees, ads, refunds charged: together its
 * fees for those days, `cost`) and the payout (for information only). Typed in a form, imported from
 * the statement template, or made from an import's fee column (`import_id`). Draft → posted →
 * reversed; a posted statement is never edited. Posted statements of a channel never cover the same
 * day twice (an exclusion constraint, custom migration), and their days obey the books-closed date.
 */
export const channelStatements = tenantTable(
  'channel_statements',
  {
    channelId: uuid('channel_id').notNull(),
    periodFrom: date('period_from', { mode: 'string' }).notNull(),
    periodTo: date('period_to', { mode: 'string' }).notNull(),
    sales: money('sales'),
    commission: money('commission').notNull().default('0'),
    paymentFees: money('payment_fees').notNull().default('0'),
    otherFees: money('other_fees').notNull().default('0'),
    ads: money('ads').notNull().default('0'),
    refundsCharged: money('refunds_charged').notNull().default('0'),
    payout: money('payout'),
    notes: text('notes'),
    status: text('status').$type<SaleImportStatus>().notNull().default('draft'),
    postedAt: timestamptz('posted_at'),
    postedBy: uuid('posted_by'),
    reversedAt: timestamptz('reversed_at'),
    reversedBy: uuid('reversed_by'),
    importId: uuid('import_id'),
  },
  (t) => [
    tenantRef('channel_statements_channel_fk', [t.businessId, t.channelId], salesChannels),
    tenantRef('channel_statements_import_fk', [t.businessId, t.importId], saleImports),
    index('channel_statements_channel_idx').on(t.businessId, t.channelId, t.periodFrom),
    uniqueIndex('channel_statements_import_key')
      .on(t.businessId, t.importId)
      .where(sql`import_id is not null and deleted_at is null`),
    check('channel_statements_status_check', sql`status in (${quoted(SALE_IMPORT_STATUSES)})`),
    check(
      'channel_statements_period_check',
      sql`period_from <= period_to and period_to - period_from < 366`,
    ),
    check(
      'channel_statements_amounts_check',
      sql`sales >= 0 and commission >= 0 and payment_fees >= 0 and other_fees >= 0 and ads >= 0
        and refunds_charged >= 0`,
    ),
    check('channel_statements_notes_check', sql`char_length(notes) <= 1000`),
    check(
      'channel_statements_posted_check',
      sql`(status = 'draft') = (posted_at is null) and (status = 'draft') = (posted_by is null)`,
    ),
    check(
      'channel_statements_reversed_check',
      sql`(status = 'reversed') = (reversed_at is not null)
        and (status = 'reversed') = (reversed_by is not null)`,
    ),
  ],
)

export type SaleImportRow = typeof saleImportRows.$inferSelect
export type NewSaleImportRow = typeof saleImportRows.$inferInsert
export type ImportProfile = typeof importProfiles.$inferSelect
export type ProductAlias = typeof productAliases.$inferSelect
export type NewProductAlias = typeof productAliases.$inferInsert
export type ChannelStatement = typeof channelStatements.$inferSelect
export type NewChannelStatement = typeof channelStatements.$inferInsert
