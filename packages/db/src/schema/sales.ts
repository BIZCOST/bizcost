import {
  DOCUMENT_STATUSES,
  SALE_COST_BASES,
  SALE_LINE_KINDS,
  SALE_MATERIAL_BASES,
  SALE_SOURCES,
  SALES_CHANNEL_KINDS,
  STANDARD_UNITS,
  VAT_CATEGORIES,
  type DocumentStatus,
  type SaleCostBasis,
  type SaleLineKind,
  type SaleMaterialBasis,
  type SaleSource,
  type SalesChannelKind,
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
  numeric,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { timestamptz } from './_app'
import { tenantRef, tenantTable } from './_helpers'
import { materials, productsServices } from './catalog'
import { locations } from './locations'

// Sales (M3 Step 2; docs/DATA_MODEL.md §6, D-219–D-222, D-225–D-231). A sale goes draft → posted →
// reversed, like a purchase: a draft changes nothing; posting freezes its amounts (computeSale) and
// the cost of what was sold (saleLineCost: each line's cost, cost basis and the owner's time, and one
// sale_line_materials row per material, at the 90-day average as of the sale's day); nothing leaves
// stock until the first stock count (Phase 4, D-219). A posted sale is never edited (database
// triggers refuse it), except the fill-once columns that complete a cost shown as "no price yet": a
// material's cost and the line cost that follows (filled by the first purchase that prices it), the
// owner's time (filled when the hourly rate is set) and the delivery cost (filled once by a member who
// sees costs). The cost columns are unbounded numeric with a scale check, so no hidden cost can make a
// posting fail (D-209). The value lists of the CHECKs come from @bizcost/domain.

const quoted = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))
const STANDARD_UNIT_LIST = quoted(Object.keys(STANDARD_UNITS))

const money = (name: string) => numeric(name, { precision: 20, scale: 4 })
const percent = (name: string) => numeric(name, { precision: 9, scale: 6 })
const quantity = (name: string) => numeric(name, { precision: 24, scale: 6 })
/** Unbounded numeric (a cost, or a base quantity used): its scale is checked instead (D-209). */
const unbounded = (name: string) => numeric(name)

/**
 * A way the business sells (one table for every way): its shop, WhatsApp and phone, its website, a
 * delivery app, a marketplace. `fee_percent`: what a delivery app or marketplace keeps of each sale
 * before VAT, from the contract (Q8), a `cost`. Seeded from the Smart Setup answers (D-226); one name
 * per business compared the way people read it (app.name_key; archived ones included). Archived:
 * hidden from pickers, kept on its sales; never deleted.
 */
export const salesChannels = tenantTable(
  'sales_channels',
  {
    name: text('name').notNull(),
    kind: text('kind').$type<SalesChannelKind>().notNull(),
    feePercent: percent('fee_percent'),
    archivedAt: timestamptz('archived_at'),
  },
  (t) => [
    uniqueIndex('sales_channels_name_key')
      .on(t.businessId, sql`app.name_key(name)`)
      .where(sql`deleted_at is null`),
    check('sales_channels_name_check', sql`btrim(name) <> '' and char_length(name) <= 100`),
    check('sales_channels_kind_check', sql`kind in (${quoted(SALES_CHANNEL_KINDS)})`),
    check('sales_channels_fee_percent_check', sql`fee_percent between 0 and 100`),
  ],
)

/**
 * A sale: Today's sales (`day_sheet`: one member's sheet for a day, or for several days within one
 * month posted on its last day, `period_from` its first, Q9) or One sale (`single`), on a business
 * day, at a location (the default one unless the business has branches), through a channel. Its
 * document amounts (computeSale) are kept on every save of a draft and frozen at posting, with the VAT
 * registration it was made under. Delivery: whether it was needed, the area, and what it actually cost
 * the business (`delivery_cost`, a `cost`; delivery charged to the customer is a `delivery` line). No
 * cost total on the header: costs are worked out on read from its lines (H4). One live sheet per member
 * × days × channel × location (Q10); a reversed one frees its key.
 */
export const sales = tenantTable(
  'sales',
  {
    source: text('source').$type<SaleSource>().notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    // A sheet for several days of one month: its first day (business_date is its last).
    periodFrom: date('period_from', { mode: 'string' }),
    locationId: uuid('location_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    status: text('status').$type<DocumentStatus>().notNull().default('draft'),
    // businesses.vat_registered when it was last saved; frozen at posting.
    vatRegistered: boolean('vat_registered').notNull().default(false),
    currency: char('currency', { length: 3 }).notNull(),
    subtotal: money('subtotal').notNull().default('0'),
    discountTotal: money('discount_total').notNull().default('0'),
    netTotal: money('net_total').notNull().default('0'),
    vatTotal: money('vat_total').notNull().default('0'),
    total: money('total').notNull().default('0'),
    deliveryNeeded: boolean('delivery_needed').notNull().default(false),
    deliveryArea: text('delivery_area'),
    deliveryCost: money('delivery_cost'),
    notes: text('notes'),
    postedAt: timestamptz('posted_at'),
    postedBy: uuid('posted_by'),
    // Set when reversed: the reversal's business day (the sale's own in an open period, or the first
    // open day when the books are closed on it; its negative counts in that day's month, D-227).
    reversedAt: timestamptz('reversed_at'),
    reversedBy: uuid('reversed_by'),
    reversalBusinessDate: date('reversal_business_date', { mode: 'string' }),
    // A draft made by "correct": the reversed sale it replaces.
    copiedFromId: uuid('copied_from_id'),
  },
  (t) => [
    tenantRef('sales_location_fk', [t.businessId, t.locationId], locations),
    tenantRef('sales_channel_fk', [t.businessId, t.channelId], salesChannels),
    foreignKey({
      name: 'sales_copied_from_fk',
      columns: [t.businessId, t.copiedFromId],
      foreignColumns: [t.businessId, t.id],
    }),
    // Lists: newest business day first; a member's own sales; a channel's or a location's.
    index('sales_business_date_idx').on(t.businessId, t.businessDate, t.id),
    index('sales_created_by_idx').on(t.businessId, t.createdBy, t.businessDate),
    index('sales_channel_idx').on(t.businessId, t.channelId),
    index('sales_location_idx').on(t.businessId, t.locationId),
    // One live sheet per member × days × channel × location (Q10): a reversed one frees its key.
    uniqueIndex('sales_day_sheet_key')
      .on(
        t.businessId,
        t.createdBy,
        t.locationId,
        t.channelId,
        t.businessDate,
        sql`coalesce(period_from, business_date)`,
      )
      .where(sql`source = 'day_sheet' and status <> 'reversed' and deleted_at is null`),
    check('sales_source_check', sql`source in (${quoted(SALE_SOURCES)})`),
    check('sales_status_check', sql`status in (${quoted(DOCUMENT_STATUSES)})`),
    check('sales_currency_check', sql`currency ~ '^[A-Z]{3}$'`),
    check(
      'sales_period_check',
      sql`period_from is null or (source = 'day_sheet' and period_from < business_date
        and date_trunc('month', period_from) = date_trunc('month', business_date))`,
    ),
    check(
      'sales_delivery_check',
      sql`delivery_needed or (delivery_area is null and delivery_cost is null)`,
    ),
    check('sales_delivery_cost_check', sql`delivery_cost >= 0`),
    check(
      'sales_delivery_area_check',
      sql`btrim(delivery_area) <> '' and char_length(delivery_area) <= 200`,
    ),
    check('sales_notes_check', sql`char_length(notes) <= 1000`),
    check(
      'sales_posted_check',
      sql`(status = 'draft') = (posted_at is null) and (status = 'draft') = (posted_by is null)`,
    ),
    check(
      'sales_reversed_check',
      sql`(status = 'reversed') = (reversed_at is not null)
        and (status = 'reversed') = (reversed_by is not null)
        and (status = 'reversed') = (reversal_business_date is not null)`,
    ),
    check('sales_copied_from_check', sql`copied_from_id <> id`),
  ],
)

/**
 * A line of a sale: an `item` (a product or service, its name copied as the description and editable,
 * D-002; its unit, its price and whether the price includes VAT copied from it, the price editable),
 * `delivery` charged to the customer (qty 1, the amount as its price), or another `charge` (from a
 * later step). The amounts are computeSale's (VAT once per rate, split back over the lines; no VAT
 * category or rate for a business not registered for VAT). Set at posting: what one unit sold uses
 * (`cost_basis`), what the line cost (`cost`, null while a material has no price yet), the owner's
 * minutes and time cost (only without a team; the cost null until the hourly rate is set).
 */
export const saleLines = tenantTable(
  'sale_lines',
  {
    saleId: uuid('sale_id').notNull(),
    position: integer('position').notNull(),
    kind: text('kind').$type<SaleLineKind>().notNull(),
    productId: uuid('product_id'),
    description: text('description'),
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
    // Posting snapshots (D-222).
    costBasis: text('cost_basis').$type<SaleCostBasis>(),
    cost: unbounded('cost'),
    timeMinutes: unbounded('time_minutes'),
    timeCost: unbounded('time_cost'),
  },
  (t) => [
    tenantRef('sale_lines_sale_fk', [t.businessId, t.saleId], sales),
    tenantRef('sale_lines_product_fk', [t.businessId, t.productId], productsServices),
    // Target of sale_line_materials: a line of the row's own sale.
    unique('sale_lines_sale_id_key').on(t.businessId, t.saleId, t.id),
    index('sale_lines_product_idx').on(t.businessId, t.productId),
    check('sale_lines_kind_check', sql`kind in (${quoted(SALE_LINE_KINDS)})`),
    check('sale_lines_product_check', sql`(kind = 'item') = (product_id is not null)`),
    check(
      'sale_lines_delivery_check',
      sql`kind <> 'delivery' or (qty = 1 and unit is null
        and discount_percent is null and discount_amount is null)`,
    ),
    check('sale_lines_unit_check', sql`unit in (${STANDARD_UNIT_LIST})`),
    check('sale_lines_position_check', sql`position >= 0`),
    check('sale_lines_qty_check', sql`qty <> 0`),
    check('sale_lines_unit_price_check', sql`unit_price >= 0`),
    check(
      'sale_lines_discount_check',
      sql`num_nonnulls(discount_percent, discount_amount) <= 1
        and discount_percent between 0 and 100 and discount_amount >= 0`,
    ),
    check('sale_lines_vat_category_check', sql`vat_category in (${quoted(VAT_CATEGORIES)})`),
    check('sale_lines_vat_rate_check', sql`vat_rate between 0 and 100`),
    check('sale_lines_vat_check', sql`(vat_category is null) = (vat_rate is null)`),
    check(
      'sale_lines_description_check',
      sql`btrim(description) <> '' and char_length(description) <= 200`,
    ),
    check('sale_lines_cost_basis_check', sql`cost_basis in (${quoted(SALE_COST_BASES)})`),
    check(
      'sale_lines_cost_check',
      sql`cost is null or (cost_basis is not null and scale(cost) <= 12)`,
    ),
    check(
      'sale_lines_time_check',
      sql`scale(time_minutes) <= 12 and scale(time_cost) <= 12
        and (time_cost is null or time_minutes is not null)`,
    ),
  ],
)

/**
 * What a sold line used of each material, frozen at posting (D-222): its base quantity (qty × the
 * recipe's base quantity ÷ its yield, or the material bought ready to sell, rounded once to 6
 * decimals) and its cost at the 90-day average as of the sale's day (`unit_cost`, `cost`, `basis`;
 * all three null while the material has no price yet, filled once by the first purchase that prices
 * it). These rows are the expected usage Phase 4 reads, with no migration.
 */
export const saleLineMaterials = tenantTable(
  'sale_line_materials',
  {
    saleId: uuid('sale_id').notNull(),
    saleLineId: uuid('sale_line_id').notNull(),
    materialId: uuid('material_id').notNull(),
    baseQty: unbounded('base_qty').notNull(),
    unitCost: unbounded('unit_cost'),
    cost: unbounded('cost'),
    basis: text('basis').$type<SaleMaterialBasis>(),
  },
  (t) => [
    foreignKey({
      name: 'sale_line_materials_line_fk',
      columns: [t.businessId, t.saleId, t.saleLineId],
      foreignColumns: [saleLines.businessId, saleLines.saleId, saleLines.id],
    }),
    // Also a plain composite FK to the sale (the catalog check wants one per parent).
    tenantRef('sale_line_materials_sale_fk', [t.businessId, t.saleId], sales),
    tenantRef('sale_line_materials_material_fk', [t.businessId, t.materialId], materials),
    uniqueIndex('sale_line_materials_line_material_key')
      .on(t.businessId, t.saleLineId, t.materialId)
      .where(sql`deleted_at is null`),
    index('sale_line_materials_material_idx').on(t.businessId, t.materialId),
    // The rows a purchase of the material fills (still without a price).
    index('sale_line_materials_unpriced_idx')
      .on(t.businessId, t.materialId)
      .where(sql`cost is null and deleted_at is null`),
    check('sale_line_materials_basis_check', sql`basis in (${quoted(SALE_MATERIAL_BASES)})`),
    check(
      'sale_line_materials_priced_check',
      sql`(cost is null) = (unit_cost is null) and (cost is null) = (basis is null)`,
    ),
    check(
      'sale_line_materials_scale_check',
      sql`scale(base_qty) <= 6 and scale(unit_cost) <= 12 and scale(cost) <= 12`,
    ),
  ],
)

export type SalesChannel = typeof salesChannels.$inferSelect
export type NewSalesChannel = typeof salesChannels.$inferInsert
export type Sale = typeof sales.$inferSelect
export type NewSale = typeof sales.$inferInsert
export type SaleLine = typeof saleLines.$inferSelect
export type NewSaleLine = typeof saleLines.$inferInsert
export type SaleLineMaterial = typeof saleLineMaterials.$inferSelect
export type NewSaleLineMaterial = typeof saleLineMaterials.$inferInsert
