import {
  CREDIT_BY,
  CREDIT_NOTE_KINDS,
  CREDIT_REASONS,
  CUSTOMER_KINDS,
  EMIRATES,
  INVOICE_BILLS,
  INVOICE_KINDS,
  INVOICE_LINE_KINDS,
  INVOICE_STATUSES,
  STANDARD_UNITS,
  VAT_CATEGORIES,
  type CreditBy,
  type CreditNoteKind,
  type CreditReason,
  type CustomerKind,
  type Emirate,
  type InvoiceBills,
  type InvoiceKind,
  type InvoiceLineKind,
  type InvoiceStatus,
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
import { fileUploads } from './files'
import { locations } from './locations'
import { orders } from './orders'
import { quotations, type StoredVatRate } from './quotations'
import { saleLines, sales, salesChannels } from './sales'

const quoted = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))
const STANDARD_UNIT_LIST = quoted(Object.keys(STANDARD_UNITS))

const money = (name: string) => numeric(name, { precision: 20, scale: 4 })
const percent = (name: string) => numeric(name, { precision: 9, scale: 6 })
const quantity = (name: string) => numeric(name, { precision: 24, scale: 6 })

/**
 * The print settings an issued document froze (its letterhead as it was at issue: accent, watermark,
 * whole amounts, contact lines, signatory, bank details and the Storage paths of its logo, signature and
 * stamp), so its PDF renders again identically when the first attempt failed.
 */
export type FrozenLetterhead = Readonly<Record<string, unknown>>

/** The seller's and the customer's particulars frozen at issue (D-002; VAT ER Arts 59(1)(b), (c)). */
const snapshotColumns = () => ({
  customerName: text('customer_name'),
  customerKind: text('customer_kind').$type<CustomerKind>(),
  customerTrn: text('customer_trn'),
  customerTradeLicence: text('customer_trade_licence'),
  customerAddressLine: text('customer_address_line'),
  customerCity: text('customer_city'),
  customerEmirate: text('customer_emirate').$type<Emirate>(),
  customerCountry: char('customer_country', { length: 2 }),
  sellerName: text('seller_name'),
  sellerNameAr: text('seller_name_ar'),
  sellerTrn: text('seller_trn'),
  sellerTradeLicence: text('seller_trade_licence'),
  sellerTradeLicenceAuthority: text('seller_trade_licence_authority'),
  sellerAddressLine: text('seller_address_line'),
  sellerCity: text('seller_city'),
  sellerEmirate: text('seller_emirate').$type<Emirate>(),
})

// Invoices (M3 Step 8; docs/DATA_MODEL.md §6; the owner's answers Q3, Q17, Q22, Q24–Q27 of D-218). A
// draft has no number; issuing takes the next number of the gapless series `invoice` (INV-0001…, the
// counter row locked last in the issuing transaction, a replayed issue answered before a number is
// taken, Q25), dates it today (`issue_date`; numbers and dates rise together), sets its kind by the VAT
// registration (`tax_invoice` | `invoice`, Q26) and freezes it with the seller's and the customer's
// particulars (D-002). An issued invoice is never edited, reversed or deleted (the trigger
// guard_invoice): only a credit note corrects it. It may come from an accepted quotation revision, an
// order or a recorded sale (at most one), billing everything, a part (a stage or a deposit, % or
// amount) or the rest (Q22). Counting once (Q3): issuing posts its sale on its supply date (sales of
// source `invoice`, `counted_on`: the first open day when its books are closed) unless its order, its
// sale, the final invoice or recorded sales count it (`counted_elsewhere`). Its id is its UUID
// (PINT-AE BTAE-07). Its PDF is rendered after the issue commits and stored (`pdf_upload_id`).
export const invoices = tenantTable(
  'invoices',
  {
    // Taken at issue (null while a draft).
    seq: integer('seq'),
    number: text('number'),
    kind: text('kind').$type<InvoiceKind>().notNull(),
    status: text('status').$type<InvoiceStatus>().notNull().default('draft'),
    customerId: uuid('customer_id').notNull(),
    locationId: uuid('location_id').notNull(),
    // The channel its sale posts on (with several active channels; null: the only one).
    channelId: uuid('channel_id'),
    // The day it was issued (today at issue).
    issueDate: date('issue_date', { mode: 'string' }),
    // The date of supply, on or before the issue date (null on a draft: the issue date).
    supplyDate: date('supply_date', { mode: 'string' }),
    dueDate: date('due_date', { mode: 'string' }),
    // The customer's LPO number (copied from the order).
    lpoReference: text('lpo_reference'),
    // businesses.vat_registered when it was last saved; frozen at issue.
    vatRegistered: boolean('vat_registered').notNull().default(false),
    currency: char('currency', { length: 3 }).notNull(),
    // What it is made from (one at most): an accepted quotation revision, an order, a recorded sale.
    quotationId: uuid('quotation_id'),
    orderId: uuid('order_id'),
    saleId: uuid('sale_id'),
    // What it bills of its source (Q22): everything, a part (a % or an amount) or the rest.
    bills: text('bills').$type<InvoiceBills>().notNull().default('everything'),
    billPercent: percent('bill_percent'),
    billAmount: money('bill_amount'),
    // A quotation's payment stage it bills (0-based): stages are billed in their order, each once.
    billStage: integer('bill_stage'),
    isDeposit: boolean('is_deposit').notNull().default(false),
    // The project or site the work is for (copied from its quotation), printed with the customer.
    site: text('site'),
    // "Is this sale already in your recorded sales?" (Q3); null: not asked.
    countedElsewhere: boolean('counted_elsewhere'),
    discountPercent: percent('discount_percent'),
    discountAmount: money('discount_amount'),
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
    terms: text('terms'),
    notes: text('notes'),
    // The day its sale counts on (its supply date, or the first open day: closed books never block an
    // issue, H5); null when issuing posts no sale.
    countedOn: date('counted_on', { mode: 'string' }),
    issuedAt: timestamptz('issued_at'),
    issuedBy: uuid('issued_by'),
    ...snapshotColumns(),
    // The customer's phone as it was at issue (printed on its PDF, made again identically).
    customerPhone: text('customer_phone'),
    letterhead: jsonb('letterhead').$type<FrozenLetterhead>(),
    pdfUploadId: uuid('pdf_upload_id'),
  },
  (t): PgTableExtraConfigValue[] => [
    tenantRef('invoices_customer_fk', [t.businessId, t.customerId], customers),
    tenantRef('invoices_location_fk', [t.businessId, t.locationId], locations),
    tenantRef('invoices_channel_fk', [t.businessId, t.channelId], salesChannels),
    tenantRef('invoices_quotation_fk', [t.businessId, t.quotationId], quotations),
    tenantRef('invoices_order_fk', [t.businessId, t.orderId], orders),
    tenantRef('invoices_sale_fk', [t.businessId, t.saleId], sales),
    tenantRef('invoices_pdf_upload_fk', [t.businessId, t.pdfUploadId], fileUploads),
    // The series `invoice` is the table: one integer per issued invoice, never twice.
    uniqueIndex('invoices_seq_key')
      .on(t.businessId, t.seq)
      .where(sql`seq is not null`),
    index('invoices_list_idx').on(t.businessId, t.issueDate, t.seq),
    index('invoices_status_idx').on(t.businessId, t.status),
    index('invoices_customer_idx').on(t.businessId, t.customerId),
    index('invoices_quotation_idx').on(t.businessId, t.quotationId),
    index('invoices_order_idx').on(t.businessId, t.orderId),
    index('invoices_sale_idx').on(t.businessId, t.saleId),
    index('invoices_location_idx').on(t.businessId, t.locationId),
    index('invoices_channel_idx').on(t.businessId, t.channelId),
    index('invoices_created_by_idx').on(t.businessId, t.createdBy),
    check('invoices_kind_check', sql`kind in (${quoted(INVOICE_KINDS)})`),
    check('invoices_status_check', sql`status in (${quoted(INVOICE_STATUSES)})`),
    check('invoices_bills_check', sql`bills in (${quoted(INVOICE_BILLS)})`),
    check('invoices_kind_vat_check', sql`(kind = 'tax_invoice') = vat_registered`),
    check(
      'invoices_tax_currency_check',
      sql`status <> 'issued' or kind <> 'tax_invoice' or currency = 'AED'`,
    ),
    check(
      'invoices_issued_check',
      sql`(status = 'issued') = (seq is not null)
        and (status = 'issued') = (number is not null)
        and (status = 'issued') = (issue_date is not null)
        and (status <> 'issued' or supply_date is not null)
        and (status = 'issued') = (issued_at is not null)
        and (status = 'issued') = (issued_by is not null)
        and (status = 'issued') = (customer_name is not null)
        and (status = 'issued') = (seller_name is not null)`,
    ),
    check('invoices_seq_check', sql`seq >= 1`),
    check('invoices_number_check', sql`btrim(number) <> '' and char_length(number) <= 40`),
    check('invoices_supply_check', sql`supply_date <= issue_date`),
    check('invoices_due_check', sql`due_date >= issue_date`),
    check('invoices_counted_on_check', sql`counted_on >= supply_date`),
    check(
      'invoices_lpo_check',
      sql`btrim(lpo_reference) <> '' and char_length(lpo_reference) <= 100`,
    ),
    check('invoices_currency_check', sql`currency ~ '^[A-Z]{3}$'`),
    check('invoices_source_check', sql`num_nonnulls(quotation_id, order_id, sale_id) <= 1`),
    check(
      'invoices_bill_check',
      sql`(bills = 'part') = (num_nonnulls(bill_percent, bill_amount) = 1)
        and num_nonnulls(bill_percent, bill_amount) <= 1
        and bill_percent > 0 and bill_percent <= 100 and bill_amount > 0
        and (bills = 'everything' or quotation_id is not null or order_id is not null)
        and (not is_deposit or bills = 'part')
        and (sale_id is null or (bills = 'everything' and not is_deposit))`,
    ),
    check(
      'invoices_discount_check',
      sql`num_nonnulls(discount_percent, discount_amount) <= 1
        and discount_percent between 0 and 100 and discount_amount >= 0`,
    ),
    check(
      'invoices_round_check',
      sql`round_to >= 0 and (round_to is not null or (adjustment = 0 and rounding_difference = 0))`,
    ),
    check(
      'invoices_bill_stage_check',
      sql`bill_stage is null
        or (bill_stage between 0 and 9 and quotation_id is not null and not is_deposit)`,
    ),
    check('invoices_site_check', sql`btrim(site) <> '' and char_length(site) <= 200`),
    check(
      'invoices_customer_phone_check',
      sql`btrim(customer_phone) <> '' and char_length(customer_phone) <= 30`,
    ),
    check('invoices_vat_rates_check', sql`jsonb_typeof(vat_rates) = 'array'`),
    check('invoices_letterhead_check', sql`jsonb_typeof(letterhead) = 'object'`),
    check('invoices_terms_check', sql`btrim(terms) <> '' and char_length(terms) <= 4000`),
    check('invoices_notes_check', sql`btrim(notes) <> '' and char_length(notes) <= 1000`),
    check('invoices_customer_kind_check', sql`customer_kind in (${quoted(CUSTOMER_KINDS)})`),
    check('invoices_customer_emirate_check', sql`customer_emirate in (${quoted(EMIRATES)})`),
    check('invoices_seller_emirate_check', sql`seller_emirate in (${quoted(EMIRATES)})`),
    check('invoices_customer_trn_check', sql`customer_trn ~ '^[0-9]{15}$'`),
    check('invoices_seller_trn_check', sql`seller_trn ~ '^[0-9]{15}$'`),
    check('invoices_pdf_check', sql`pdf_upload_id is null or status = 'issued'`),
  ],
)

/**
 * A line of an invoice: an `item` (a product or service, or typed, Q21: also a stage's or a deposit's
 * line, one per VAT rate of its source, priced with VAT), the `delivery` charged (from an order), or a
 * `deduction` (a final invoice's line per deposit invoice and VAT rate taking that invoice's net and VAT
 * off, qty −1, naming it: `deposit_invoice_id`, H8). As a quotation line: an area, details and a red
 * note print on its PDF; its picture is an attachment of entity `invoice_line`. `sale_line_id`: the sale
 * line it counted in (its own sale's, or its order's or sale's), whose frozen cost a credit note by
 * quantity takes back. Changed only while its invoice is a draft.
 */
export const invoiceLines = tenantTable(
  'invoice_lines',
  {
    invoiceId: uuid('invoice_id').notNull(),
    position: integer('position').notNull(),
    kind: text('kind').$type<InvoiceLineKind>().notNull(),
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
    depositInvoiceId: uuid('deposit_invoice_id'),
    saleLineId: uuid('sale_line_id'),
  },
  (t) => [
    tenantRef('invoice_lines_invoice_fk', [t.businessId, t.invoiceId], invoices),
    tenantRef('invoice_lines_product_fk', [t.businessId, t.productId], productsServices),
    tenantRef('invoice_lines_deposit_fk', [t.businessId, t.depositInvoiceId], invoices),
    tenantRef('invoice_lines_sale_line_fk', [t.businessId, t.saleLineId], saleLines),
    index('invoice_lines_invoice_idx').on(t.businessId, t.invoiceId),
    index('invoice_lines_product_idx').on(t.businessId, t.productId),
    index('invoice_lines_deposit_idx').on(t.businessId, t.depositInvoiceId),
    index('invoice_lines_sale_line_idx').on(t.businessId, t.saleLineId),
    check('invoice_lines_kind_check', sql`kind in (${quoted(INVOICE_LINE_KINDS)})`),
    check('invoice_lines_position_check', sql`position >= 0`),
    check('invoice_lines_product_check', sql`kind = 'item' or product_id is null`),
    check(
      'invoice_lines_deduction_check',
      sql`(kind = 'deduction') = (deposit_invoice_id is not null)
        and (kind = 'deduction') = (qty < 0)
        and (kind <> 'deduction' or (qty = -1 and discount_percent is null
          and discount_amount is null))`,
    ),
    check(
      'invoice_lines_delivery_check',
      sql`kind <> 'delivery' or (qty = 1 and unit is null
        and discount_percent is null and discount_amount is null)`,
    ),
    check('invoice_lines_area_check', sql`btrim(area) <> '' and char_length(area) <= 40`),
    check(
      'invoice_lines_description_check',
      sql`btrim(description) <> '' and char_length(description) <= 200`,
    ),
    check(
      'invoice_lines_details_check',
      sql`btrim(details) <> '' and char_length(details) <= 2000`,
    ),
    check('invoice_lines_note_check', sql`btrim(note) <> '' and char_length(note) <= 500`),
    check('invoice_lines_qty_check', sql`qty <> 0`),
    check('invoice_lines_unit_check', sql`unit in (${STANDARD_UNIT_LIST})`),
    check('invoice_lines_unit_price_check', sql`unit_price >= 0`),
    check(
      'invoice_lines_discount_check',
      sql`num_nonnulls(discount_percent, discount_amount) <= 1
        and discount_percent between 0 and 100 and discount_amount >= 0`,
    ),
    check('invoice_lines_vat_category_check', sql`vat_category in (${quoted(VAT_CATEGORIES)})`),
    check('invoice_lines_vat_rate_check', sql`vat_rate between 0 and 100`),
    check('invoice_lines_vat_check', sql`(vat_category is null) = (vat_rate is null)`),
  ],
)

// Credit notes (M3 Step 8; VAT DL Arts 61, 62; ER Art. 60; MD 243 Art. 6(2)). A credit note corrects one
// issued invoice (even a full cancellation): its own gapless series `credit_note` (CN-0001…, taken at
// issue like an invoice's), its kind from its invoice's (a tax credit note for a tax invoice, B5), the
// day its reason happened (`event_date`), a reason mapped to VAT DL Art. 61(1), PINT-AE BTAE-03 and MD
// 243 Art. 6(2) with its text, lines by quantity or by amount (`credit_by`) never more than is left of
// the invoice's lines, and its amounts as positive numbers (the credit). Issuing posts a negative sale
// on its issue date (sales of source `credit_note`; `counted_on` the first open day when its books are
// closed) except on a deposit invoice or one counted elsewhere (`counted_elsewhere`, Q3), and freezes
// the particulars and ER Art. 60(1)(e)'s values (`value_before`: the invoice's value of the supply less
// the earlier credit notes, `value_after`). Never edited or deleted once issued.
export const creditNotes = tenantTable(
  'credit_notes',
  {
    seq: integer('seq'),
    number: text('number'),
    kind: text('kind').$type<CreditNoteKind>().notNull(),
    status: text('status').$type<InvoiceStatus>().notNull().default('draft'),
    invoiceId: uuid('invoice_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    locationId: uuid('location_id').notNull(),
    issueDate: date('issue_date', { mode: 'string' }),
    // The day the reason happened (the goods came back, the price was cut).
    eventDate: date('event_date', { mode: 'string' }).notNull(),
    reason: text('reason').$type<CreditReason>().notNull(),
    reasonText: text('reason_text').notNull(),
    creditBy: text('credit_by').$type<CreditBy>().notNull(),
    countedElsewhere: boolean('counted_elsewhere'),
    vatRegistered: boolean('vat_registered').notNull().default(false),
    currency: char('currency', { length: 3 }).notNull(),
    netTotal: money('net_total').notNull().default('0'),
    vatTotal: money('vat_total').notNull().default('0'),
    total: money('total').notNull().default('0'),
    // The invoice's rounding difference (D-221), taken back by the credit note that leaves nothing of
    // the invoice to credit (set at issue, D-333): what it takes back is total + rounding difference.
    roundingDifference: money('rounding_difference').notNull().default('0'),
    vatRates: jsonb('vat_rates')
      .$type<readonly StoredVatRate[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    valueBefore: money('value_before'),
    valueAfter: money('value_after'),
    notes: text('notes'),
    countedOn: date('counted_on', { mode: 'string' }),
    issuedAt: timestamptz('issued_at'),
    issuedBy: uuid('issued_by'),
    ...snapshotColumns(),
    letterhead: jsonb('letterhead').$type<FrozenLetterhead>(),
    pdfUploadId: uuid('pdf_upload_id'),
  },
  (t): PgTableExtraConfigValue[] => [
    tenantRef('credit_notes_invoice_fk', [t.businessId, t.invoiceId], invoices),
    tenantRef('credit_notes_customer_fk', [t.businessId, t.customerId], customers),
    tenantRef('credit_notes_location_fk', [t.businessId, t.locationId], locations),
    tenantRef('credit_notes_pdf_upload_fk', [t.businessId, t.pdfUploadId], fileUploads),
    uniqueIndex('credit_notes_seq_key')
      .on(t.businessId, t.seq)
      .where(sql`seq is not null`),
    index('credit_notes_invoice_idx').on(t.businessId, t.invoiceId),
    index('credit_notes_customer_idx').on(t.businessId, t.customerId),
    index('credit_notes_location_idx').on(t.businessId, t.locationId),
    index('credit_notes_list_idx').on(t.businessId, t.issueDate, t.seq),
    index('credit_notes_created_by_idx').on(t.businessId, t.createdBy),
    check('credit_notes_kind_check', sql`kind in (${quoted(CREDIT_NOTE_KINDS)})`),
    check('credit_notes_status_check', sql`status in (${quoted(INVOICE_STATUSES)})`),
    check('credit_notes_reason_check', sql`reason in (${quoted(CREDIT_REASONS)})`),
    check('credit_notes_credit_by_check', sql`credit_by in (${quoted(CREDIT_BY)})`),
    check('credit_notes_kind_vat_check', sql`(kind = 'tax_credit_note') = vat_registered`),
    check(
      'credit_notes_issued_check',
      sql`(status = 'issued') = (seq is not null)
        and (status = 'issued') = (number is not null)
        and (status = 'issued') = (issue_date is not null)
        and (status = 'issued') = (issued_at is not null)
        and (status = 'issued') = (issued_by is not null)
        and (status = 'issued') = (value_before is not null)
        and (status = 'issued') = (value_after is not null)
        and (status = 'issued') = (customer_name is not null)
        and (status = 'issued') = (seller_name is not null)`,
    ),
    check('credit_notes_seq_check', sql`seq >= 1`),
    check('credit_notes_number_check', sql`btrim(number) <> '' and char_length(number) <= 40`),
    check('credit_notes_event_check', sql`event_date <= issue_date`),
    check(
      'credit_notes_reason_text_check',
      sql`btrim(reason_text) <> '' and char_length(reason_text) <= 500`,
    ),
    check('credit_notes_currency_check', sql`currency ~ '^[A-Z]{3}$'`),
    check(
      'credit_notes_amounts_check',
      sql`net_total >= 0 and vat_total >= 0 and total >= 0
        and value_before >= 0 and value_after >= 0 and value_after <= value_before`,
    ),
    check('credit_notes_vat_rates_check', sql`jsonb_typeof(vat_rates) = 'array'`),
    check('credit_notes_letterhead_check', sql`jsonb_typeof(letterhead) = 'object'`),
    check('credit_notes_notes_check', sql`btrim(notes) <> '' and char_length(notes) <= 1000`),
    check('credit_notes_customer_kind_check', sql`customer_kind in (${quoted(CUSTOMER_KINDS)})`),
    check('credit_notes_customer_emirate_check', sql`customer_emirate in (${quoted(EMIRATES)})`),
    check('credit_notes_seller_emirate_check', sql`seller_emirate in (${quoted(EMIRATES)})`),
    check('credit_notes_customer_trn_check', sql`customer_trn ~ '^[0-9]{15}$'`),
    check('credit_notes_seller_trn_check', sql`seller_trn ~ '^[0-9]{15}$'`),
    check('credit_notes_pdf_check', sql`pdf_upload_id is null or status = 'issued'`),
    check('credit_notes_rounding_check', sql`rounding_difference = 0 or status = 'issued'`),
  ],
)

/**
 * A line of a credit note: the invoice line it takes back (`invoice_line_id`), by quantity (goods
 * returned: `qty` of it) or by amount (a price cut: qty 1, its amount as the line's prices are typed),
 * with its amounts as positive numbers, worked out with the sales engine under the invoice's VAT
 * registration (documents/credit.ts: never more than is left; the last of what is left copied exactly).
 */
export const creditNoteLines = tenantTable(
  'credit_note_lines',
  {
    creditNoteId: uuid('credit_note_id').notNull(),
    position: integer('position').notNull(),
    invoiceLineId: uuid('invoice_line_id').notNull(),
    description: text('description').notNull(),
    qty: quantity('qty').notNull(),
    unit: text('unit').$type<StandardUnit>(),
    unitPrice: money('unit_price').notNull(),
    priceIncludesVat: boolean('price_includes_vat').notNull().default(false),
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
    tenantRef('credit_note_lines_credit_note_fk', [t.businessId, t.creditNoteId], creditNotes),
    foreignKey({
      name: 'credit_note_lines_invoice_line_fk',
      columns: [t.businessId, t.invoiceLineId],
      foreignColumns: [invoiceLines.businessId, invoiceLines.id],
    }),
    index('credit_note_lines_credit_note_idx').on(t.businessId, t.creditNoteId),
    index('credit_note_lines_invoice_line_idx').on(t.businessId, t.invoiceLineId),
    check('credit_note_lines_position_check', sql`position >= 0`),
    check(
      'credit_note_lines_description_check',
      sql`btrim(description) <> '' and char_length(description) <= 200`,
    ),
    check('credit_note_lines_qty_check', sql`qty > 0`),
    check('credit_note_lines_unit_check', sql`unit in (${STANDARD_UNIT_LIST})`),
    check('credit_note_lines_unit_price_check', sql`unit_price >= 0`),
    check('credit_note_lines_discount_check', sql`discount_amount >= 0`),
    check(
      'credit_note_lines_amounts_check',
      sql`net >= 0 and vat >= 0 and total >= 0 and total = net + vat`,
    ),
    check('credit_note_lines_vat_category_check', sql`vat_category in (${quoted(VAT_CATEGORIES)})`),
    check('credit_note_lines_vat_rate_check', sql`vat_rate between 0 and 100`),
    check('credit_note_lines_vat_check', sql`(vat_category is null) = (vat_rate is null)`),
  ],
)

export type Invoice = typeof invoices.$inferSelect
export type NewInvoice = typeof invoices.$inferInsert
export type InvoiceLine = typeof invoiceLines.$inferSelect
export type NewInvoiceLine = typeof invoiceLines.$inferInsert
export type CreditNote = typeof creditNotes.$inferSelect
export type NewCreditNote = typeof creditNotes.$inferInsert
export type CreditNoteLine = typeof creditNoteLines.$inferSelect
export type NewCreditNoteLine = typeof creditNoteLines.$inferInsert
