import { STOCK_MOVEMENT_KINDS, type StockMovementKind } from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  numeric,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
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
  },
  (t) => [
    tenantRef('stock_movements_location_fk', [t.businessId, t.locationId], locations),
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
    index('stock_movements_receipt_idx').on(t.businessId, t.receiptId),
    check('stock_movements_kind_check', sql`kind in (${quoted(STOCK_MOVEMENT_KINDS)})`),
    check(
      'stock_movements_shape_check',
      sql`case kind
        when 'purchase' then qty > 0 and value >= 0 and purchase_line_id is not null
          and return_line_id is null and receipt_id is null and reverses_id is null
        when 'purchase_return' then qty < 0 and value <= 0 and purchase_line_id is not null
          and return_line_id is not null and receipt_id is not null and reverses_id is null
        when 'purchase_credit' then qty = 0 and value < 0 and purchase_line_id is not null
          and return_line_id is not null and receipt_id is not null and reverses_id is null
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
