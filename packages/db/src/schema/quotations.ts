import {
  QUOTATION_STATUSES,
  STANDARD_UNITS,
  VAT_CATEGORIES,
  type QuotationStatus,
  type StandardUnit,
  type VatCategory,
} from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  text,
  uniqueIndex,
  uuid,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core'
import { timestamptz } from './_app'
import { tenantRef, tenantTable } from './_helpers'
import { productsServices } from './catalog'
import { customers } from './customers'
import { invoices } from './invoices'
import { locations } from './locations'
import { orders } from './orders'

const quoted = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))
const STANDARD_UNIT_LIST = quoted(Object.keys(STANDARD_UNITS))

const money = (name: string) => numeric(name, { precision: 20, scale: 4 })
const percent = (name: string) => numeric(name, { precision: 9, scale: 6 })
const quantity = (name: string) => numeric(name, { precision: 24, scale: 6 })

/** One VAT rate of a quotation, as computeSale gave it (a tax invoice's VAT breakdown, ibg-23). */
export interface StoredVatRate {
  readonly vatCategory: VatCategory | null
  readonly vatRate: string | null
  readonly net: string
  readonly vat: string
}

// Quotations (M3 Step 7; docs/DATA_MODEL.md §6; the owner's answers Q21–Q25 of D-218). A quotation is
// numbered when its first revision is created (document_counters `quotation`, Q-0001…; a discarded
// draft keeps its number, so numbers may skip) and every revision keeps that number: `root_id` is the
// first revision (its own id) and `revision` counts from 1. A revision is a draft until sent, then
// frozen by the trigger guard_quotation (only its answer, its supersession and its order link may
// still be written); "Revise" makes revision n + 1, and once that is sent the one before is
// `superseded`. Its amounts are computeSale's with the document discount and "Round the total" (the
// total typed `round_to`, the adjustment before VAT and the rounding difference, D-221), and the VAT
// per rate as computed (`vat_rates`), kept on every save of the draft. `intro`, `terms`, `notes` and
// the payment stages (quotation_stages) are printed on its PDF. One revision of a quotation becomes
// an order at most (`order_id`); `invoice_id` links the first invoice issued from it (M3 Step 8; a
// quotation billed in stages names its others on theirs). The customer is required ("Dear …").
export const quotations = tenantTable(
  'quotations',
  {
    seq: integer('seq').notNull(),
    // As printed when its first revision was created ("Q-0001").
    number: text('number').notNull(),
    rootId: uuid('root_id').notNull(),
    revision: integer('revision').notNull().default(1),
    status: text('status').$type<QuotationStatus>().notNull().default('draft'),
    customerId: uuid('customer_id').notNull(),
    locationId: uuid('location_id').notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    // The last day it is valid (its PDF says so); null: not said.
    validUntil: date('valid_until', { mode: 'string' }),
    // The customer's own reference (their enquiry or LPO number).
    customerRef: text('customer_ref'),
    // The project or site the work is for ("Villa 12, Al Barsha"), printed after the customer's name.
    site: text('site'),
    // businesses.vat_registered when it was last saved (frozen once sent).
    vatRegistered: boolean('vat_registered').notNull().default(false),
    currency: char('currency', { length: 3 }).notNull(),
    // The discount on the whole quotation, as typed (a % or an amount; computeSale splits it).
    discountPercent: percent('discount_percent'),
    discountAmount: money('discount_amount'),
    // "Round the total" (D-221): the total with VAT the member typed, the adjustment before VAT it
    // came to and the fils no VAT rate could reach (at most 2 minor units).
    roundTo: money('round_to'),
    adjustment: money('adjustment').notNull().default('0'),
    roundingDifference: money('rounding_difference').notNull().default('0'),
    subtotal: money('subtotal').notNull().default('0'),
    discountTotal: money('discount_total').notNull().default('0'),
    netTotal: money('net_total').notNull().default('0'),
    vatTotal: money('vat_total').notNull().default('0'),
    total: money('total').notNull().default('0'),
    // total + rounding difference: what the customer is asked to pay (ibt-115).
    payable: money('payable').notNull().default('0'),
    vatRates: jsonb('vat_rates')
      .$type<readonly StoredVatRate[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Printed: the greeting as typed (null: the business's language's own, «السادة / <name>،»), the
    // sentence after it (null: the default of each language), the terms (copied from the business's
    // default terms when created) and notes.
    greeting: text('greeting'),
    intro: text('intro'),
    terms: text('terms'),
    notes: text('notes'),
    sentAt: timestamptz('sent_at'),
    sentBy: uuid('sent_by'),
    acceptedAt: timestamptz('accepted_at'),
    acceptedBy: uuid('accepted_by'),
    acceptNote: text('accept_note'),
    declinedAt: timestamptz('declined_at'),
    declinedBy: uuid('declined_by'),
    declineReason: text('decline_reason'),
    // When a later revision was sent.
    supersededAt: timestamptz('superseded_at'),
    orderId: uuid('order_id'),
    invoiceId: uuid('invoice_id'),
    // "Copy": the revision it was copied from (another quotation's, or its own number's).
    copiedFromId: uuid('copied_from_id'),
  },
  (t): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'quotations_root_fk',
      columns: [t.businessId, t.rootId],
      foreignColumns: [t.businessId, t.id],
    }),
    foreignKey({
      name: 'quotations_copied_from_fk',
      columns: [t.businessId, t.copiedFromId],
      foreignColumns: [t.businessId, t.id],
    }),
    tenantRef('quotations_customer_fk', [t.businessId, t.customerId], customers),
    tenantRef('quotations_location_fk', [t.businessId, t.locationId], locations),
    tenantRef('quotations_order_fk', [t.businessId, t.orderId], orders),
    tenantRef('quotations_invoice_fk', [t.businessId, t.invoiceId], invoices),
    index('quotations_invoice_idx').on(t.businessId, t.invoiceId),
    // The series `quotation` is the table: one integer per quotation, shared by its revisions.
    // A revision counts n + 1 over the live ones: a discarded draft revision's count is used again
    // (D-296).
    uniqueIndex('quotations_seq_key')
      .on(t.businessId, t.seq, t.revision)
      .where(sql`deleted_at is null`),
    uniqueIndex('quotations_revision_key')
      .on(t.businessId, t.rootId, t.revision)
      .where(sql`deleted_at is null`),
    // One draft revision of a quotation at a time.
    uniqueIndex('quotations_draft_key')
      .on(t.businessId, t.rootId)
      .where(sql`status = 'draft' and deleted_at is null`),
    // One revision of a quotation becomes an order, and an order comes from one quotation.
    uniqueIndex('quotations_root_order_key')
      .on(t.businessId, t.rootId)
      .where(sql`order_id is not null`),
    uniqueIndex('quotations_order_key')
      .on(t.businessId, t.orderId)
      .where(sql`order_id is not null`),
    // Lists: newest first by status; a customer's; a member's own; a revision's siblings.
    index('quotations_list_idx').on(t.businessId, t.businessDate, t.seq),
    index('quotations_status_idx').on(t.businessId, t.status),
    index('quotations_customer_idx').on(t.businessId, t.customerId),
    index('quotations_root_idx').on(t.businessId, t.rootId),
    index('quotations_created_by_idx').on(t.businessId, t.createdBy),
    index('quotations_location_idx').on(t.businessId, t.locationId),
    index('quotations_copied_from_idx').on(t.businessId, t.copiedFromId),
    check('quotations_status_check', sql`status in (${quoted(QUOTATION_STATUSES)})`),
    check('quotations_seq_check', sql`seq >= 1`),
    check('quotations_revision_check', sql`revision >= 1 and (revision = 1) = (root_id = id)`),
    check('quotations_number_check', sql`btrim(number) <> '' and char_length(number) <= 40`),
    check(
      'quotations_customer_ref_check',
      sql`btrim(customer_ref) <> '' and char_length(customer_ref) <= 100`,
    ),
    check('quotations_site_check', sql`btrim(site) <> '' and char_length(site) <= 200`),
    check('quotations_valid_until_check', sql`valid_until >= business_date`),
    check('quotations_currency_check', sql`currency ~ '^[A-Z]{3}$'`),
    check(
      'quotations_discount_check',
      sql`num_nonnulls(discount_percent, discount_amount) <= 1
        and discount_percent between 0 and 100 and discount_amount >= 0`,
    ),
    check(
      'quotations_round_check',
      sql`round_to >= 0 and (round_to is not null or (adjustment = 0 and rounding_difference = 0))`,
    ),
    check('quotations_vat_rates_check', sql`jsonb_typeof(vat_rates) = 'array'`),
    check('quotations_greeting_check', sql`btrim(greeting) <> '' and char_length(greeting) <= 200`),
    check('quotations_intro_check', sql`btrim(intro) <> '' and char_length(intro) <= 1000`),
    check('quotations_terms_check', sql`btrim(terms) <> '' and char_length(terms) <= 4000`),
    check('quotations_notes_check', sql`btrim(notes) <> '' and char_length(notes) <= 1000`),
    check(
      'quotations_sent_check',
      sql`(status <> 'draft') = (sent_at is not null) and (sent_at is null) = (sent_by is null)`,
    ),
    check(
      'quotations_accepted_check',
      sql`(accepted_at is null) = (accepted_by is null)
        and (status <> 'accepted' or accepted_at is not null)
        and (accept_note is null or accepted_at is not null)`,
    ),
    check(
      'quotations_declined_check',
      sql`(declined_at is null) = (declined_by is null)
        and (status <> 'declined' or declined_at is not null)
        and (decline_reason is null or declined_at is not null)
        and (accepted_at is null or declined_at is null)`,
    ),
    check(
      'quotations_superseded_check',
      sql`(status = 'superseded') = (superseded_at is not null)`,
    ),
    check('quotations_order_check', sql`order_id is null or accepted_at is not null`),
    check(
      'quotations_accept_note_check',
      sql`btrim(accept_note) <> '' and char_length(accept_note) <= 500`,
    ),
    check(
      'quotations_decline_reason_check',
      sql`btrim(decline_reason) <> '' and char_length(decline_reason) <= 500`,
    ),
    check('quotations_copied_from_check', sql`copied_from_id <> id`),
  ],
)

/**
 * A line of a quotation (Q21): a product or service of the business (`product_id`, its name copied as
 * the title and editable, D-002), or typed (no product: custom work, priced on the spot). An optional
 * area or room groups its lines on the PDF ("MAJLIS", "Dining room"; the API saves each area's lines
 * together, D-299; at most 40 characters, so its name fits up their side); the title prints bold,
 * the details under it keep their line breaks, and a highlighted note prints in red. Its picture is an
 * attachment of entity `quotation_line` (images only). The amounts are computeSale's, with the
 * quotation's discount and rounding. Changed only while its quotation is a draft.
 */
export const quotationLines = tenantTable(
  'quotation_lines',
  {
    quotationId: uuid('quotation_id').notNull(),
    position: integer('position').notNull(),
    productId: uuid('product_id'),
    area: text('area'),
    description: text('description').notNull(),
    details: text('details'),
    note: text('note'),
    qty: quantity('qty').notNull(),
    unit: text('unit').$type<StandardUnit>(),
    unitPrice: money('unit_price').notNull(),
    priceIncludesVat: boolean('price_includes_vat').notNull().default(false),
    discountPercent: percent('discount_percent'),
    discountAmount: money('discount_amount'),
    vatCategory: text('vat_category').$type<VatCategory>(),
    vatRate: percent('vat_rate'),
    subtotal: money('subtotal').notNull().default('0'),
    discount: money('discount').notNull().default('0'),
    net: money('net').notNull().default('0'),
    vat: money('vat').notNull().default('0'),
    total: money('total').notNull().default('0'),
  },
  (t) => [
    tenantRef('quotation_lines_quotation_fk', [t.businessId, t.quotationId], quotations),
    tenantRef('quotation_lines_product_fk', [t.businessId, t.productId], productsServices),
    index('quotation_lines_quotation_idx').on(t.businessId, t.quotationId),
    index('quotation_lines_product_idx').on(t.businessId, t.productId),
    check('quotation_lines_position_check', sql`position >= 0`),
    check('quotation_lines_area_check', sql`btrim(area) <> '' and char_length(area) <= 40`),
    check(
      'quotation_lines_description_check',
      sql`btrim(description) <> '' and char_length(description) <= 200`,
    ),
    check(
      'quotation_lines_details_check',
      sql`btrim(details) <> '' and char_length(details) <= 2000`,
    ),
    check('quotation_lines_note_check', sql`btrim(note) <> '' and char_length(note) <= 500`),
    check('quotation_lines_qty_check', sql`qty > 0`),
    check('quotation_lines_unit_check', sql`unit in (${STANDARD_UNIT_LIST})`),
    check('quotation_lines_unit_price_check', sql`unit_price >= 0`),
    check(
      'quotation_lines_discount_check',
      sql`num_nonnulls(discount_percent, discount_amount) <= 1
        and discount_percent between 0 and 100 and discount_amount >= 0`,
    ),
    check('quotation_lines_vat_category_check', sql`vat_category in (${quoted(VAT_CATEGORIES)})`),
    check('quotation_lines_vat_rate_check', sql`vat_rate between 0 and 100`),
    check('quotation_lines_vat_check', sql`(vat_category is null) = (vat_rate is null)`),
  ],
)

/**
 * A payment stage of a quotation's terms (the owner's request of 2026-10-16): when it is due ("Upon
 * signing"), an optional label (null: "Payment 1"…), its % of the payable total and the amount that
 * comes to (paymentStageAmounts: each but the last rounded on its own, the last the exact rest; the
 * stages' % add up to 100). Step 8's stage invoices bill them. Changed only while its quotation is a
 * draft.
 */
export const quotationStages = tenantTable(
  'quotation_stages',
  {
    quotationId: uuid('quotation_id').notNull(),
    position: integer('position').notNull(),
    label: text('label'),
    due: text('due').notNull(),
    percent: percent('percent').notNull(),
    amount: money('amount').notNull(),
  },
  (t) => [
    tenantRef('quotation_stages_quotation_fk', [t.businessId, t.quotationId], quotations),
    index('quotation_stages_quotation_idx').on(t.businessId, t.quotationId),
    check('quotation_stages_position_check', sql`position >= 0`),
    check('quotation_stages_label_check', sql`btrim(label) <> '' and char_length(label) <= 100`),
    check('quotation_stages_due_check', sql`btrim(due) <> '' and char_length(due) <= 100`),
    check('quotation_stages_percent_check', sql`percent > 0 and percent <= 100`),
    check('quotation_stages_amount_check', sql`amount >= 0`),
  ],
)

/** What a PDF was made of (document_renders.kind). */
export const DOCUMENT_RENDER_KINDS = ['quotation', 'invoice', 'credit_note', 'statement'] as const
export type DocumentRenderKind = (typeof DOCUMENT_RENDER_KINDS)[number]

/**
 * A PDF made of a document (M3 Step 7: a quotation; Step 8: invoices, credit notes and a customer's
 * statement, whose `document_id` is the customer's): who asked and when, so the database can hold the
 * rate limit (app.document_render_limits) for every API instance at once. Append-only.
 */
export const documentRenders = tenantTable(
  'document_renders',
  {
    kind: text('kind').$type<DocumentRenderKind>().notNull(),
    documentId: uuid('document_id').notNull(),
  },
  (t) => [
    index('document_renders_created_idx').on(t.businessId, t.createdAt),
    index('document_renders_created_by_idx').on(t.businessId, t.createdBy, t.createdAt),
    check('document_renders_kind_check', sql`kind in (${quoted(DOCUMENT_RENDER_KINDS)})`),
  ],
)

export type Quotation = typeof quotations.$inferSelect
export type NewQuotation = typeof quotations.$inferInsert
export type QuotationLine = typeof quotationLines.$inferSelect
export type NewQuotationLine = typeof quotationLines.$inferInsert
export type QuotationStage = typeof quotationStages.$inferSelect
export type NewQuotationStage = typeof quotationStages.$inferInsert
export type DocumentRender = typeof documentRenders.$inferSelect
