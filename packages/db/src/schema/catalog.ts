import {
  DIMENSIONS,
  MATERIAL_UNIT_KINDS,
  PRODUCT_TYPES,
  STANDARD_UNITS,
  VAT_CATEGORIES,
  type Dimension,
  type MaterialUnitKind,
  type ProductType,
  type StandardUnit,
  type VatCategory,
} from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  foreignKey,
  index,
  numeric,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { timestamptz } from './_app'
import { tenantRef, tenantTable } from './_helpers'
import { locations } from './locations'

// Materials and Products & Services (M2 Step 2; docs/DATA_MODEL.md §6, D-113, D-121–D-123). One name
// per record, in any language. A record is archived (hidden from pickers, kept with its history),
// never deleted: no API path soft-deletes these rows. Names are unique per business, ignoring case,
// among rows that are not deleted (archived ones included). The value lists of the CHECKs come from
// @bizcost/domain, so code and database cannot disagree.

const quoted = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))

/** Every standard unit code ('mg', 'g', 'kg', 'ml', 'l', 'piece', …). */
const STANDARD_UNIT_LIST = quoted(Object.keys(STANDARD_UNITS))

/** The (dimension, unit) pairs of the standard units: a unit belongs to exactly one dimension. */
const UNIT_DIMENSION_PAIRS = sql.raw(
  Object.entries(STANDARD_UNITS)
    .map(([unit, { dimension }]) => `('${dimension}', '${unit}')`)
    .join(', '),
)

/**
 * Something the business buys to make or sell (D-108, D-122). `dimension` fixes how it is costed:
 * quantities and costs are kept per base unit of it (g, ml, piece, mm, cm², s: BASE_UNITS in
 * @bizcost/domain). `unit` is the standard unit the business counts it in (kg, l, piece…), shown with
 * its cost and chosen first in pickers; it is always of the material's dimension.
 */
export const materials = tenantTable(
  'materials',
  {
    name: text('name').notNull(),
    dimension: text('dimension').$type<Dimension>().notNull(),
    unit: text('unit').$type<StandardUnit>().notNull(),
    // Archived: hidden from pickers; still listed (filter) and never deleted (D-123).
    archivedAt: timestamptz('archived_at'),
  },
  (t) => [
    // One name per business, compared the way people read it (app.name_key: case, spaces, Arabic
    // letter forms, marks and digits; nameKey in @bizcost/domain, migration name_key).
    uniqueIndex('materials_name_key')
      .on(t.businessId, sql`app.name_key(name)`)
      .where(sql`deleted_at is null`),
    check('materials_name_check', sql`btrim(name) <> '' and char_length(name) <= 100`),
    check('materials_dimension_check', sql`dimension in (${quoted(DIMENSIONS)})`),
    check('materials_unit_check', sql`(dimension, unit) in (${UNIT_DIMENSION_PAIRS})`),
  ],
)

/**
 * A material's own units (D-108, D-122), validated as a whole with validateMaterialUnits before every
 * write:
 * - `pack`: a named unit, "1 <name> = qty <of_unit | of_pack>": 1 carton = 12 bottles, 1 bottle =
 *   1 l. Every chain ends at a standard unit, without loops (checked by the API with the domain
 *   engine); the composite FK keeps `of_pack_id` inside the same material and business.
 * - `cross`: "1 <unit> = qty <of_unit>", a standard unit of another dimension in terms of one of the
 *   material's own ("1 l = 920 g" for oil kept in grams), at most one per other dimension.
 * `qty` is exact, numeric(28,12). Units removed in an edit are soft-deleted, so what referred to them
 * keeps working. Pack names (case ignored) and cross-factor dimensions are unique per material: the
 * API checks the whole set on every save, and saves of one material wait for each other on its row
 * (version). No unique index: a save that swaps two names would trip it halfway.
 */
export const materialUnits = tenantTable(
  'material_units',
  {
    materialId: uuid('material_id').notNull(),
    kind: text('kind').$type<MaterialUnitKind>().notNull(),
    // pack: its name ('carton'); NULL for a cross factor.
    name: text('name'),
    // cross: the standard unit of another dimension ('l'); NULL for a pack.
    unit: text('unit').$type<StandardUnit>(),
    qty: numeric('qty', { precision: 28, scale: 12 }).notNull(),
    // What one of it holds: a standard unit, or (packs only) another pack of the same material.
    ofUnit: text('of_unit').$type<StandardUnit>(),
    ofPackId: uuid('of_pack_id'),
  },
  (t) => [
    tenantRef('material_units_material_fk', [t.businessId, t.materialId], materials),
    // Target of the pack → pack reference: it cannot leave the material.
    unique('material_units_material_id_key').on(t.businessId, t.materialId, t.id),
    foreignKey({
      name: 'material_units_of_pack_fk',
      columns: [t.businessId, t.materialId, t.ofPackId],
      foreignColumns: [t.businessId, t.materialId, t.id],
    }),
    check('material_units_kind_check', sql`kind in (${quoted(MATERIAL_UNIT_KINDS)})`),
    check('material_units_pack_name_check', sql`(kind = 'pack') = (name is not null)`),
    check('material_units_cross_unit_check', sql`(kind = 'cross') = (unit is not null)`),
    check('material_units_of_check', sql`num_nonnulls(of_unit, of_pack_id) = 1`),
    check('material_units_of_pack_check', sql`kind = 'pack' or of_pack_id is null`),
    check('material_units_qty_check', sql`qty > 0`),
    check('material_units_name_check', sql`btrim(name) <> '' and char_length(name) <= 50`),
    check('material_units_unit_check', sql`unit in (${STANDARD_UNIT_LIST})`),
    check('material_units_of_unit_check', sql`of_unit in (${STANDARD_UNIT_LIST})`),
  ],
)

/**
 * What the business sells: a product, or a service (D-113, D-121). `unit` is the standard unit it is
 * sold by (piece, kg, h…); `default_price` the usual selling price per unit in the business currency
 * (NULL: not set yet), before VAT unless `price_includes_vat`. The VAT setting applies only while the
 * business is VAT-registered. Document lines copy these values; editing a line never edits the record
 * (D-002).
 *
 * `resale_material_id` (M2 Step 4, D-117): an item bought ready to sell is one product and its
 * material, created together and kept in step by the API (name, unit, archiving). Purchases buy the
 * material, and the product costs the material's average for one unit sold, with no recipe. At most
 * one product per material, only a product (not a service), and the link never changes (trigger
 * keep_resale_link).
 */
export const productsServices = tenantTable(
  'products_services',
  {
    name: text('name').notNull(),
    description: text('description'),
    type: text('type').$type<ProductType>().notNull(),
    unit: text('unit').$type<StandardUnit>().notNull(),
    defaultPrice: numeric('default_price', { precision: 20, scale: 4 }),
    vatCategory: text('vat_category').$type<VatCategory>().notNull().default('standard'),
    priceIncludesVat: boolean('price_includes_vat').notNull().default(false),
    // Archived: hidden from pickers; still listed (filter) and never deleted (D-123).
    archivedAt: timestamptz('archived_at'),
    // Bought ready to sell: the material bought for it (D-117); NULL for anything made or done.
    resaleMaterialId: uuid('resale_material_id'),
    // The owner's minutes for one unit, for a business without a team (M2 Step 6, D-119): its cost
    // has a line for the owner's time. NULL: none. Kept, and hidden, when the business has a team.
    ownerMinutes: numeric('owner_minutes', { precision: 24, scale: 6 }),
  },
  (t) => [
    tenantRef(
      'products_services_resale_material_fk',
      [t.businessId, t.resaleMaterialId],
      materials,
    ),
    // One product per material bought ready to sell.
    uniqueIndex('products_services_resale_material_key')
      .on(t.businessId, t.resaleMaterialId)
      .where(sql`resale_material_id is not null`),
    check('products_services_resale_check', sql`resale_material_id is null or type = 'product'`),
    // One name per business (case ignored); also the order of the list and its cursor.
    uniqueIndex('products_services_name_key')
      .on(t.businessId, sql`lower(name)`)
      .where(sql`deleted_at is null`),
    check('products_services_name_check', sql`btrim(name) <> '' and char_length(name) <= 100`),
    check('products_services_description_check', sql`char_length(description) <= 1000`),
    check('products_services_type_check', sql`type in (${quoted(PRODUCT_TYPES)})`),
    check('products_services_unit_check', sql`unit in (${STANDARD_UNIT_LIST})`),
    check('products_services_default_price_check', sql`default_price >= 0`),
    check('products_services_owner_minutes_check', sql`owner_minutes > 0`),
    check('products_services_vat_category_check', sql`vat_category in (${quoted(VAT_CATEGORIES)})`),
  ],
)

/**
 * Where a product or service is sold, for a business with more than one location (capability
 * multi_location). No row = every location, including ones added later (as a member's location
 * scope, D-054). A location taken out of the list is soft-deleted and comes back on the same row.
 */
export const productLocations = tenantTable(
  'product_locations',
  {
    productId: uuid('product_id').notNull(),
    locationId: uuid('location_id').notNull(),
  },
  (t) => [
    tenantRef('product_locations_product_fk', [t.businessId, t.productId], productsServices),
    tenantRef('product_locations_location_fk', [t.businessId, t.locationId], locations),
    unique('product_locations_product_location_key').on(t.businessId, t.productId, t.locationId),
    index('product_locations_location_idx').on(t.businessId, t.locationId),
  ],
)

export type Material = typeof materials.$inferSelect
export type NewMaterial = typeof materials.$inferInsert
export type MaterialUnit = typeof materialUnits.$inferSelect
export type NewMaterialUnit = typeof materialUnits.$inferInsert
export type ProductService = typeof productsServices.$inferSelect
export type NewProductService = typeof productsServices.$inferInsert
export type ProductLocation = typeof productLocations.$inferSelect
export type NewProductLocation = typeof productLocations.$inferInsert
