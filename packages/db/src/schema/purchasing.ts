import {
  DOCUMENT_STATUSES,
  PAYMENT_METHODS,
  PURCHASE_DOCUMENT_TYPES,
  PURCHASE_LINE_KINDS,
  PURCHASE_RETURN_KINDS,
  STANDARD_UNITS,
  type DocumentStatus,
  type PaymentMethod,
  type PurchaseDocumentType,
  type PurchaseLineKind,
  type PurchaseReturnKind,
  type StandardUnit,
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
  numeric,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { timestamptz } from './_app'
import { tenantRef, tenantTable } from './_helpers'
import { materials, materialUnits } from './catalog'
import { locations } from './locations'
import { suppliers } from './suppliers'

// Purchases, supplier returns and credit notes (M2 Step 3; docs/DATA_MODEL.md §6, D-114, D-120).
// Documents go draft → posted → reversed. A draft changes nothing; posting writes the stock ledger
// (stock.ts) and the material's average; a posted document is never edited (triggers in the
// purchasing_security migration refuse it) and is corrected by a reversal. Amounts are document
// amounts (numeric(20,4), rounded to the currency's minor unit), computed by the API with the domain's
// computePurchase on every save and frozen at posting; posted lines keep what their goods cost (the
// receipt's value) and their base quantity as snapshots. The value lists of the CHECKs come from
// @bizcost/domain, so code and database cannot disagree.

const quoted = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))
const STANDARD_UNIT_LIST = quoted(Object.keys(STANDARD_UNITS))

const money = (name: string) => numeric(name, { precision: 20, scale: 4 })
const percent = (name: string) => numeric(name, { precision: 9, scale: 6 })
const quantity = (name: string) => numeric(name, { precision: 24, scale: 6 })

/**
 * A purchase: what was bought from a supplier (optional) on a business day, at a location (the
 * default one unless the business has branches), with the document the supplier gave and how it was
 * paid. `vat_not_reclaimable` marks a document whose VAT cannot be reclaimed; `vat_in_cost` is the
 * choice made at posting (D-114 rule 4).
 */
export const purchases = tenantTable(
  'purchases',
  {
    supplierId: uuid('supplier_id'),
    locationId: uuid('location_id').notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    documentType: text('document_type').$type<PurchaseDocumentType>().notNull(),
    // The supplier's invoice or receipt number.
    reference: text('reference'),
    paymentMethod: text('payment_method').$type<PaymentMethod>(),
    vatNotReclaimable: boolean('vat_not_reclaimable').notNull().default(false),
    currency: char('currency', { length: 3 }).notNull(),
    // The document discount: a percentage of the material lines' net, or an amount (at most one).
    discountPercent: percent('discount_percent'),
    discountAmount: money('discount_amount'),
    notes: text('notes'),
    status: text('status').$type<DocumentStatus>().notNull().default('draft'),
    // Totals (computePurchase), kept by the API on every save of a draft and frozen at posting.
    subtotal: money('subtotal').notNull().default('0'),
    documentDiscount: money('document_discount').notNull().default('0'),
    discountTotal: money('discount_total').notNull().default('0'),
    netTotal: money('net_total').notNull().default('0'),
    vatTotal: money('vat_total').notNull().default('0'),
    total: money('total').notNull().default('0'),
    // Set when posted: whether VAT is part of the cost, and what the goods cost in all.
    vatInCost: boolean('vat_in_cost'),
    costTotal: money('cost_total'),
    postedAt: timestamptz('posted_at'),
    postedBy: uuid('posted_by'),
    // Set when reversed: the reversal's business day (the purchase's own, or the first open day when
    // the books are closed on it; D-114 rule 3).
    reversedAt: timestamptz('reversed_at'),
    reversedBy: uuid('reversed_by'),
    reversalDate: date('reversal_date', { mode: 'string' }),
    // A draft made by "correct": the reversed purchase it replaces.
    copiedFromId: uuid('copied_from_id'),
  },
  (t) => [
    tenantRef('purchases_supplier_fk', [t.businessId, t.supplierId], suppliers),
    tenantRef('purchases_location_fk', [t.businessId, t.locationId], locations),
    foreignKey({
      name: 'purchases_copied_from_fk',
      columns: [t.businessId, t.copiedFromId],
      foreignColumns: [t.businessId, t.id],
    }),
    // Lists: newest business day first.
    index('purchases_business_date_idx').on(t.businessId, t.businessDate, t.id),
    index('purchases_supplier_idx').on(t.businessId, t.supplierId),
    check(
      'purchases_document_type_check',
      sql`document_type in (${quoted(PURCHASE_DOCUMENT_TYPES)})`,
    ),
    check('purchases_payment_method_check', sql`payment_method in (${quoted(PAYMENT_METHODS)})`),
    check('purchases_status_check', sql`status in (${quoted(DOCUMENT_STATUSES)})`),
    check('purchases_currency_check', sql`currency ~ '^[A-Z]{3}$'`),
    check(
      'purchases_discount_check',
      sql`num_nonnulls(discount_percent, discount_amount) <= 1
        and discount_percent between 0 and 100 and discount_amount >= 0`,
    ),
    check(
      'purchases_reference_check',
      sql`btrim(reference) <> '' and char_length(reference) <= 100`,
    ),
    check('purchases_notes_check', sql`char_length(notes) <= 1000`),
    check(
      'purchases_posted_check',
      sql`(status = 'draft') = (posted_at is null)
        and (status = 'draft') = (posted_by is null)
        and (status = 'draft') = (vat_in_cost is null)
        and (status = 'draft') = (cost_total is null)`,
    ),
    check(
      'purchases_reversed_check',
      sql`(status = 'reversed') = (reversed_at is not null)
        and (status = 'reversed') = (reversed_by is not null)
        and (status = 'reversed') = (reversal_date is not null)`,
    ),
    check('purchases_copied_from_check', sql`copied_from_id <> id`),
  ],
)

/**
 * A line of a purchase: a material bought in any unit of its dimension (a standard unit, or one of
 * its packs; a unit of another dimension through its cross factor), or delivery charged on the same
 * invoice (qty 1, `unit_price` = the amount). What the user typed stays as typed; the amounts are
 * computed; `base_qty` (the quantity in the material's base unit), `delivery_share` and `cost` (what
 * the goods cost: the receipt's value) are set when the purchase is posted.
 */
export const purchaseLines = tenantTable(
  'purchase_lines',
  {
    purchaseId: uuid('purchase_id').notNull(),
    position: integer('position').notNull(),
    kind: text('kind').$type<PurchaseLineKind>().notNull(),
    materialId: uuid('material_id'),
    // The material's name when the line was saved (D-002), or the delivery's own text.
    description: text('description'),
    qty: quantity('qty').notNull(),
    // The purchase unit: a standard unit, or one of the material's packs (exactly one for a material).
    unit: text('unit').$type<StandardUnit>(),
    packId: uuid('pack_id'),
    unitPrice: money('unit_price').notNull(),
    discountPercent: percent('discount_percent'),
    discountAmount: money('discount_amount'),
    vatRate: percent('vat_rate').notNull().default('0'),
    subtotal: money('subtotal').notNull().default('0'),
    discount: money('discount').notNull().default('0'),
    net: money('net').notNull().default('0'),
    documentDiscount: money('document_discount').notNull().default('0'),
    taxable: money('taxable').notNull().default('0'),
    vat: money('vat').notNull().default('0'),
    total: money('total').notNull().default('0'),
    // Posting snapshots (material lines).
    baseQty: quantity('base_qty'),
    deliveryShare: money('delivery_share'),
    cost: money('cost'),
  },
  (t) => [
    tenantRef('purchase_lines_purchase_fk', [t.businessId, t.purchaseId], purchases),
    tenantRef('purchase_lines_material_fk', [t.businessId, t.materialId], materials),
    // A pack of the line's own material only.
    foreignKey({
      name: 'purchase_lines_pack_fk',
      columns: [t.businessId, t.materialId, t.packId],
      foreignColumns: [materialUnits.businessId, materialUnits.materialId, materialUnits.id],
    }),
    // Target of return lines: a line of the return's own purchase.
    unique('purchase_lines_purchase_id_key').on(t.businessId, t.purchaseId, t.id),
    index('purchase_lines_material_idx').on(t.businessId, t.materialId),
    check('purchase_lines_kind_check', sql`kind in (${quoted(PURCHASE_LINE_KINDS)})`),
    check('purchase_lines_material_check', sql`(kind = 'material') = (material_id is not null)`),
    check(
      'purchase_lines_unit_check',
      sql`case kind when 'material' then num_nonnulls(unit, pack_id) = 1
        else unit is null and pack_id is null and qty = 1
          and discount_percent is null and discount_amount is null end`,
    ),
    check('purchase_lines_unit_code_check', sql`unit in (${STANDARD_UNIT_LIST})`),
    check('purchase_lines_position_check', sql`position >= 0`),
    check('purchase_lines_qty_check', sql`qty > 0`),
    check('purchase_lines_unit_price_check', sql`unit_price >= 0`),
    check(
      'purchase_lines_discount_check',
      sql`num_nonnulls(discount_percent, discount_amount) <= 1
        and discount_percent between 0 and 100 and discount_amount >= 0`,
    ),
    check('purchase_lines_vat_rate_check', sql`vat_rate between 0 and 100`),
    check(
      'purchase_lines_description_check',
      sql`btrim(description) <> '' and char_length(description) <= 200`,
    ),
    check('purchase_lines_base_qty_check', sql`base_qty > 0`),
  ],
)

/**
 * A supplier return (goods sent back: a quantity per purchase line) or a credit note (a price cut
 * without goods: an amount per purchase line, or one amount split over the lines by their net,
 * `split_amount`), linked to a posted purchase (D-120). Posted on its own business day; reversed as if
 * never posted.
 */
export const purchaseReturns = tenantTable(
  'purchase_returns',
  {
    purchaseId: uuid('purchase_id').notNull(),
    kind: text('kind').$type<PurchaseReturnKind>().notNull(),
    status: text('status').$type<DocumentStatus>().notNull().default('draft'),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    // The supplier's return note or credit note number.
    reference: text('reference'),
    notes: text('notes'),
    currency: char('currency', { length: 3 }).notNull(),
    // A credit note entered as one amount (before VAT), split over the purchase's material lines.
    splitAmount: money('split_amount'),
    // Totals of the lines: before VAT, VAT, and with VAT (document amounts).
    netTotal: money('net_total').notNull().default('0'),
    vatTotal: money('vat_total').notNull().default('0'),
    total: money('total').notNull().default('0'),
    // Set when posted: what it took off the goods' cost in all (the ledger's value, 12 decimals).
    costTotal: numeric('cost_total', { precision: 28, scale: 12 }),
    postedAt: timestamptz('posted_at'),
    postedBy: uuid('posted_by'),
    reversedAt: timestamptz('reversed_at'),
    reversedBy: uuid('reversed_by'),
    reversalDate: date('reversal_date', { mode: 'string' }),
  },
  (t) => [
    tenantRef('purchase_returns_purchase_fk', [t.businessId, t.purchaseId], purchases),
    // Target of its lines: they must name lines of this return's purchase.
    unique('purchase_returns_purchase_id_key').on(t.businessId, t.purchaseId, t.id),
    index('purchase_returns_business_date_idx').on(t.businessId, t.businessDate, t.id),
    check('purchase_returns_kind_check', sql`kind in (${quoted(PURCHASE_RETURN_KINDS)})`),
    check('purchase_returns_status_check', sql`status in (${quoted(DOCUMENT_STATUSES)})`),
    check('purchase_returns_currency_check', sql`currency ~ '^[A-Z]{3}$'`),
    check(
      'purchase_returns_split_amount_check',
      sql`split_amount is null or (kind = 'credit_note' and split_amount > 0)`,
    ),
    check(
      'purchase_returns_reference_check',
      sql`btrim(reference) <> '' and char_length(reference) <= 100`,
    ),
    check('purchase_returns_notes_check', sql`char_length(notes) <= 1000`),
    check(
      'purchase_returns_posted_check',
      sql`(status = 'draft') = (posted_at is null)
        and (status = 'draft') = (posted_by is null)
        and (status = 'draft') = (cost_total is null)`,
    ),
    check(
      'purchase_returns_reversed_check',
      sql`(status = 'reversed') = (reversed_at is not null)
        and (status = 'reversed') = (reversed_by is not null)
        and (status = 'reversed') = (reversal_date is not null)`,
    ),
  ],
)

/**
 * A line of a return (`qty`, in the purchase line's unit) or of a credit note (`amount`, before VAT),
 * naming a material line of the same purchase (composite FKs). `net` and `vat` are its document
 * amounts; `base_qty` (returns) and `cost` (what it took off the goods' cost) are set when posted.
 */
export const purchaseReturnLines = tenantTable(
  'purchase_return_lines',
  {
    returnId: uuid('return_id').notNull(),
    purchaseId: uuid('purchase_id').notNull(),
    purchaseLineId: uuid('purchase_line_id').notNull(),
    position: integer('position').notNull(),
    qty: quantity('qty'),
    amount: money('amount'),
    net: money('net').notNull().default('0'),
    vat: money('vat').notNull().default('0'),
    baseQty: quantity('base_qty'),
    cost: numeric('cost', { precision: 28, scale: 12 }),
  },
  (t) => [
    foreignKey({
      name: 'purchase_return_lines_return_fk',
      columns: [t.businessId, t.purchaseId, t.returnId],
      foreignColumns: [purchaseReturns.businessId, purchaseReturns.purchaseId, purchaseReturns.id],
    }),
    foreignKey({
      name: 'purchase_return_lines_purchase_line_fk',
      columns: [t.businessId, t.purchaseId, t.purchaseLineId],
      foreignColumns: [purchaseLines.businessId, purchaseLines.purchaseId, purchaseLines.id],
    }),
    // Also a plain composite FK to the purchase (the catalog check wants one per parent).
    tenantRef('purchase_return_lines_purchase_fk', [t.businessId, t.purchaseId], purchases),
    uniqueIndex('purchase_return_lines_line_key')
      .on(t.businessId, t.returnId, t.purchaseLineId)
      .where(sql`deleted_at is null`),
    index('purchase_return_lines_purchase_line_idx').on(t.businessId, t.purchaseLineId),
    check('purchase_return_lines_what_check', sql`num_nonnulls(qty, amount) = 1`),
    check('purchase_return_lines_qty_check', sql`qty > 0`),
    check('purchase_return_lines_amount_check', sql`amount > 0`),
    check('purchase_return_lines_position_check', sql`position >= 0`),
    check('purchase_return_lines_base_qty_check', sql`base_qty > 0`),
  ],
)

export type Purchase = typeof purchases.$inferSelect
export type NewPurchase = typeof purchases.$inferInsert
export type PurchaseLine = typeof purchaseLines.$inferSelect
export type NewPurchaseLine = typeof purchaseLines.$inferInsert
export type PurchaseReturn = typeof purchaseReturns.$inferSelect
export type NewPurchaseReturn = typeof purchaseReturns.$inferInsert
export type PurchaseReturnLine = typeof purchaseReturnLines.$inferSelect
export type NewPurchaseReturnLine = typeof purchaseReturnLines.$inferInsert
