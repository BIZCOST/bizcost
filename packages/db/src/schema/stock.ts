import {
  DOCUMENT_STATUSES,
  STOCK_COUNT_KINDS,
  STOCK_MOVEMENT_KINDS,
  type DocumentStatus,
  type StockCountKind,
  type StockMovementKind,
} from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  numeric,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { timestamptz } from './_app'
import { tenantRef, tenantTable } from './_helpers'
import { materials } from './catalog'
import { locations } from './locations'
import { purchaseLines, purchaseReturnLines } from './purchasing'

// The stock ledger and its projections (M2 Step 3; D-006, D-109, D-110, D-120; docs/DATA_MODEL.md §6).
// `stock_movements` is append-only: bizcost_api may only read and insert it, and a trigger refuses
// every change. Every movement has a location (the default one for a single-location business) and a
// material; quantities are signed base quantities (numeric(24,6)), values signed cost-engine amounts
// (numeric(28,12), never rounded to the currency). `seq` is the posting order: taken when the row is
// inserted, after the posting's locks (D-110), so movements of one material are in the order they
// were posted. The projections are written in the same transaction as the movements and equal a
// replay of the ledger (replayWac in @bizcost/domain): one cost row per material for the whole
// business (quantity, value, average), and the quantity per location and material.

const quoted = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))

/**
 * A stock count (M4 Step 2; D-339 Q2, Q3, Q5, Q6). `kind` `opening`: the first count of some
 * materials, in every active branch on one day (`location_id` null); it starts their stock and sets
 * `materials.stock_tracked_from`. `count`: a later count of one branch (`location_id`), whose lines
 * find what differs from the book. `business_date`: the stock counted is the stock at the END of that
 * day. Documents as purchases: a draft (soft-deleted when discarded) becomes posted ("finalized" on
 * screen) and then only reversed, never edited (trigger guard_posted); posting writes the stock
 * ledger, reversing undoes it on its own day or the first open day (`reversal_date`).
 */
export const stockCounts = tenantTable(
  'stock_counts',
  {
    kind: text('kind').$type<StockCountKind>().notNull(),
    locationId: uuid('location_id'),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    status: text('status').$type<DocumentStatus>().notNull().default('draft'),
    note: text('note'),
    postedAt: timestamptz('posted_at'),
    postedBy: uuid('posted_by'),
    reversedAt: timestamptz('reversed_at'),
    reversedBy: uuid('reversed_by'),
    reversalDate: date('reversal_date', { mode: 'string' }),
  },
  (t) => [
    tenantRef('stock_counts_location_fk', [t.businessId, t.locationId], locations),
    // Lists: newest business day first.
    index('stock_counts_business_date_idx').on(t.businessId, t.businessDate, t.id),
    index('stock_counts_location_idx').on(t.businessId, t.locationId),
    check('stock_counts_kind_check', sql`kind in (${quoted(STOCK_COUNT_KINDS)})`),
    check('stock_counts_location_check', sql`(kind = 'opening') = (location_id is null)`),
    check('stock_counts_status_check', sql`status in (${quoted(DOCUMENT_STATUSES)})`),
    check('stock_counts_note_check', sql`char_length(note) <= 500`),
    check(
      'stock_counts_posted_check',
      sql`(status = 'draft') = (posted_at is null) and (status = 'draft') = (posted_by is null)`,
    ),
    check(
      'stock_counts_reversed_check',
      sql`(status = 'reversed') = (reversed_at is not null)
        and (status = 'reversed') = (reversed_by is not null)
        and (status = 'reversed') = (reversal_date is not null)`,
    ),
  ],
)

/**
 * A line of a count: one material in one branch, once per count. `parts` is what was typed, in any
 * unit or pack of the material, one or several ("3 cartons + 4 bottles": `[{qty, unit}|{qty,
 * pack_id}]`); `counted_base_qty` the same in base units (countedBaseQty), null until counted. Lines
 * are saved one by one, each with its own `version`, by whoever counts (`counted_by`, `counted_at`), so
 * several people fill one count (Q6). Finalizing stores what the book said at the end of the count's
 * day (`book_base_qty`), the difference (counted − book) and what it moved the stock's value by
 * (`difference_value`, at `unit_cost`). Lines of a posted count never change (trigger guard_posted).
 */
export const stockCountLines = tenantTable(
  'stock_count_lines',
  {
    countId: uuid('count_id').notNull(),
    locationId: uuid('location_id').notNull(),
    materialId: uuid('material_id').notNull(),
    parts: jsonb('parts').$type<StoredCountPart[]>(),
    countedBaseQty: numeric('counted_base_qty', { precision: 24, scale: 6 }),
    countedBy: uuid('counted_by'),
    countedAt: timestamptz('counted_at'),
    bookBaseQty: numeric('book_base_qty', { precision: 24, scale: 6 }),
    differenceQty: numeric('difference_qty', { precision: 24, scale: 6 }),
    differenceValue: numeric('difference_value', { precision: 28, scale: 12 }),
    unitCost: numeric('unit_cost', { precision: 28, scale: 12 }),
  },
  (t) => [
    tenantRef('stock_count_lines_count_fk', [t.businessId, t.countId], stockCounts),
    tenantRef('stock_count_lines_location_fk', [t.businessId, t.locationId], locations),
    tenantRef('stock_count_lines_material_fk', [t.businessId, t.materialId], materials),
    // A material once per branch in a count (lines taken out are soft-deleted and may come back).
    uniqueIndex('stock_count_lines_count_location_material_key')
      .on(t.businessId, t.countId, t.locationId, t.materialId)
      .where(sql`deleted_at is null`),
    // The counts of a branch's material (the last one, a later one): by material and branch.
    index('stock_count_lines_material_location_idx').on(t.businessId, t.materialId, t.locationId),
    check(
      'stock_count_lines_counted_check',
      sql`(parts is null) = (counted_base_qty is null)
        and (parts is null) = (counted_by is null)
        and (parts is null) = (counted_at is null)
        and counted_base_qty >= 0`,
    ),
    check(
      'stock_count_lines_parts_check',
      sql`jsonb_typeof(parts) = 'array' and jsonb_array_length(parts) between 1 and 10`,
    ),
    check(
      'stock_count_lines_result_check',
      sql`(book_base_qty is null) = (difference_qty is null)
        and (book_base_qty is null) = (difference_value is null)
        and (book_base_qty is null or counted_base_qty is not null)
        and difference_qty = counted_base_qty - book_base_qty`,
    ),
  ],
)

/** A counted part as stored in `stock_count_lines.parts`: a standard unit or one of its packs. */
export type StoredCountPart =
  | { readonly qty: string; readonly unit: string }
  | { readonly qty: string; readonly pack_id: string }

/**
 * One stock movement. `value` is what it moved (+ in, − out); `adjustment` what it booked as a
 * correction of costs already charged (D-109: value after = value before + value − adjustment).
 * `unit_cost` is value ÷ qty, for display. A purchase names its line; a return or credit names its
 * line and the receipt it takes from; a reversal names the movement it reverses (at most once).
 */
export const stockMovements = tenantTable(
  'stock_movements',
  {
    seq: bigint('seq', { mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    locationId: uuid('location_id').notNull(),
    materialId: uuid('material_id').notNull(),
    kind: text('kind').$type<StockMovementKind>().notNull(),
    qty: numeric('qty', { precision: 24, scale: 6 }).notNull(),
    value: numeric('value', { precision: 28, scale: 12 }).notNull(),
    adjustment: numeric('adjustment', { precision: 28, scale: 12 }).notNull().default('0'),
    unitCost: numeric('unit_cost', { precision: 28, scale: 12 }),
    purchaseLineId: uuid('purchase_line_id'),
    returnLineId: uuid('return_line_id'),
    receiptId: uuid('receipt_id'),
    reversesId: uuid('reverses_id'),
    // M4 Step 2: the count line an opening or a count row comes from (its reversal names it too).
    countLineId: uuid('count_line_id'),
  },
  (t) => [
    tenantRef('stock_movements_location_fk', [t.businessId, t.locationId], locations),
    tenantRef('stock_movements_count_line_fk', [t.businessId, t.countLineId], stockCountLines),
    tenantRef('stock_movements_material_fk', [t.businessId, t.materialId], materials),
    tenantRef('stock_movements_purchase_line_fk', [t.businessId, t.purchaseLineId], purchaseLines),
    tenantRef(
      'stock_movements_return_line_fk',
      [t.businessId, t.returnLineId],
      purchaseReturnLines,
    ),
    foreignKey({
      name: 'stock_movements_receipt_fk',
      columns: [t.businessId, t.receiptId],
      foreignColumns: [t.businessId, t.id],
    }),
    foreignKey({
      name: 'stock_movements_reverses_fk',
      columns: [t.businessId, t.reversesId],
      foreignColumns: [t.businessId, t.id],
    }),
    // A material's ledger in posting order (reversals and rebuilds replay it).
    index('stock_movements_material_seq_idx').on(t.businessId, t.materialId, t.seq),
    // The 90-day purchase average reads the purchase rows by material and business day (D-115).
    index('stock_movements_material_date_idx').on(t.businessId, t.materialId, t.businessDate),
    // Each purchase line comes in once, each return or credit line goes out once, each movement is
    // reversed at most once: a second posting of the same document cannot write twice.
    uniqueIndex('stock_movements_purchase_line_key')
      .on(t.businessId, t.purchaseLineId)
      .where(sql`kind = 'purchase'`),
    uniqueIndex('stock_movements_return_line_key')
      .on(t.businessId, t.returnLineId)
      .where(sql`kind in ('purchase_return', 'purchase_credit')`),
    uniqueIndex('stock_movements_reverses_key')
      .on(t.businessId, t.reversesId)
      .where(sql`reverses_id is not null`),
    // Each count line posts once (M4 Step 2): an opening's row of a branch, or a count's difference.
    uniqueIndex('stock_movements_count_line_key')
      .on(t.businessId, t.countLineId)
      .where(sql`kind in ('opening', 'count')`),
    index('stock_movements_receipt_idx').on(t.businessId, t.receiptId),
    check('stock_movements_kind_check', sql`kind in (${quoted(STOCK_MOVEMENT_KINDS)})`),
    // An opening row sets its branch to what was counted (any quantity: counted − the book before),
    // worth its share of the count's value (adjustment: its share of the book value replaced); a
    // count row is a difference, its value signed as its quantity (D-340).
    check(
      'stock_movements_shape_check',
      sql`case kind
        when 'purchase' then qty > 0 and value >= 0 and purchase_line_id is not null
          and return_line_id is null and receipt_id is null and reverses_id is null
          and count_line_id is null
        when 'purchase_return' then qty < 0 and value <= 0 and purchase_line_id is not null
          and return_line_id is not null and receipt_id is not null and reverses_id is null
          and count_line_id is null
        when 'purchase_credit' then qty = 0 and value < 0 and purchase_line_id is not null
          and return_line_id is not null and receipt_id is not null and reverses_id is null
          and count_line_id is null
        when 'opening' then value >= 0 and count_line_id is not null and purchase_line_id is null
          and return_line_id is null and receipt_id is null and reverses_id is null
        when 'count' then ((qty > 0 and value >= 0) or (qty < 0 and value <= 0))
          and count_line_id is not null and purchase_line_id is null
          and return_line_id is null and receipt_id is null and reverses_id is null
        else reverses_id is not null and receipt_id is null
      end`,
    ),
  ],
)

/**
 * The cost row of a material: ONE per material for the whole business (D-006). Quantity on hand in
 * base units, its value and the weighted-average cost per base unit (null before the first receipt
 * that still stands). `last_seq` is the last movement applied. Created at the material's first
 * posting. Value and average are numeric(38,12), wider than any one movement (numeric(28,12)): what
 * all the postings of a material add up to never overflows, so no posting fails on a hidden stock
 * value or average (an answer that would tell them, ARCHITECTURE §Redaction; D-209).
 */
export const materialCosts = tenantTable(
  'material_costs',
  {
    materialId: uuid('material_id').notNull(),
    qty: numeric('qty', { precision: 24, scale: 6 }).notNull().default('0'),
    value: numeric('value', { precision: 38, scale: 12 }).notNull().default('0'),
    avgCost: numeric('avg_cost', { precision: 38, scale: 12 }),
    lastSeq: bigint('last_seq', { mode: 'number' }),
  },
  (t) => [
    tenantRef('material_costs_material_fk', [t.businessId, t.materialId], materials),
    unique('material_costs_material_key').on(t.businessId, t.materialId),
  ],
)

/** The quantity of a material at a location (D-114 rule 5: quantities per branch, one cost). */
export const stockBalances = tenantTable(
  'stock_balances',
  {
    locationId: uuid('location_id').notNull(),
    materialId: uuid('material_id').notNull(),
    qty: numeric('qty', { precision: 24, scale: 6 }).notNull().default('0'),
  },
  (t) => [
    tenantRef('stock_balances_location_fk', [t.businessId, t.locationId], locations),
    tenantRef('stock_balances_material_fk', [t.businessId, t.materialId], materials),
    unique('stock_balances_location_material_key').on(t.businessId, t.locationId, t.materialId),
    index('stock_balances_material_idx').on(t.businessId, t.materialId),
  ],
)

export type StockMovement = typeof stockMovements.$inferSelect
export type NewStockMovement = typeof stockMovements.$inferInsert
export type MaterialCost = typeof materialCosts.$inferSelect
export type StockBalance = typeof stockBalances.$inferSelect
export type StockCount = typeof stockCounts.$inferSelect
export type NewStockCount = typeof stockCounts.$inferInsert
export type StockCountLine = typeof stockCountLines.$inferSelect
export type NewStockCountLine = typeof stockCountLines.$inferInsert
