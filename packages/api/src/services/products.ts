import type {
  catalogIdInput,
  catalogListInput,
  createProductInput,
  ProductDto,
  ProductListDto,
  updateProductInput,
} from '@bizcost/contracts'
import {
  createIdempotent,
  locations,
  productLocations,
  productsServices,
  type Tx,
} from '@bizcost/db'
import { can, newId, type ProductType, type StandardUnit, type VatCategory } from '@bizcost/domain'
import {
  and,
  asc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  sql,
  type SQL,
} from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import {
  containsPattern,
  decodeCursor,
  encodeCursor,
  requestHashOf,
  withUniqueName,
} from './catalog'

// Products & Services (ROADMAP.md M2 Step 2; DATA_MODEL.md §6, D-121, D-123): what a business sells.
// Module `products`, products.items.view to read and products.items.manage to write (the router
// checks both). Where each is sold is a list of locations, only for a business with more than one
// (capability multi_location): empty means every location. Only members who manage the branches
// (settings.locations.manage) change it (D-129). Nothing is ever deleted: a record is archived.

type ListInput = z.output<typeof catalogListInput>
type IdInput = z.output<typeof catalogIdInput>
type CreateInput = z.output<typeof createProductInput>
type UpdateInput = z.output<typeof updateProductInput>
type Fields = Omit<CreateInput, 'id'>

/** The unique index on (business_id, lower(name)) of live products and services. */
const NAME_KEY = 'products_services_name_key'

/** Who may choose where a product is sold: the members who manage the branches (D-129). */
const PICK_LOCATIONS = 'settings.locations.manage'

const productColumns = {
  id: productsServices.id,
  name: productsServices.name,
  description: productsServices.description,
  type: productsServices.type,
  unit: productsServices.unit,
  // Without the column's trailing zeros ("15.5", not "15.5000").
  defaultPrice: sql<string | null>`trim_scale(${productsServices.defaultPrice})::text`,
  vatCategory: productsServices.vatCategory,
  priceIncludesVat: productsServices.priceIncludesVat,
  archivedAt: productsServices.archivedAt,
  version: productsServices.version,
}

type ProductRow = {
  id: string
  name: string
  description: string | null
  type: ProductType
  unit: StandardUnit
  defaultPrice: string | null
  vatCategory: VatCategory
  priceIncludesVat: boolean
  archivedAt: Date | null
  version: number
}

function toDto(row: ProductRow, locationIds: readonly string[]): ProductDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    unit: row.unit,
    defaultPrice: row.defaultPrice,
    vatCategory: row.vatCategory,
    priceIncludesVat: row.priceIncludesVat,
    locationIds: [...locationIds],
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
  }
}

/**
 * Where these products are sold: their live links to live locations, by product (location ids
 * sorted). Removing a location takes its links with it (removeLocation, D-129); a link to one
 * removed before that rule is left out too, so a product never names a location that is gone.
 */
async function locationsOf(
  tx: Tx,
  businessId: string,
  ids: readonly string[],
): Promise<Map<string, string[]>> {
  const byProduct = new Map<string, string[]>()
  if (ids.length === 0) return byProduct
  const rows = await tx
    .select({ productId: productLocations.productId, locationId: productLocations.locationId })
    .from(productLocations)
    .innerJoin(
      locations,
      and(
        eq(locations.businessId, productLocations.businessId),
        eq(locations.id, productLocations.locationId),
      ),
    )
    .where(
      and(
        eq(productLocations.businessId, businessId),
        inArray(productLocations.productId, [...ids]),
        isNull(productLocations.deletedAt),
        isNull(locations.deletedAt),
      ),
    )
    .orderBy(asc(productLocations.locationId))
  for (const row of rows) {
    byProduct.set(row.productId, [...(byProduct.get(row.productId) ?? []), row.locationId])
  }
  return byProduct
}

async function findProduct(tx: Tx, businessId: string, id: string) {
  const [row] = await tx
    .select(productColumns)
    .from(productsServices)
    .where(
      and(
        eq(productsServices.businessId, businessId),
        eq(productsServices.id, id),
        isNull(productsServices.deletedAt),
      ),
    )
  return row
}

async function loadProduct(tx: Tx, businessId: string, id: string): Promise<ProductDto> {
  const row = await findProduct(tx, businessId, id)
  if (!row) throw new AppError('not_found')
  return toDto(row, (await locationsOf(tx, businessId, [id])).get(id) ?? [])
}

/**
 * The locations a save may set, given what is `stored` (the product's list as product.get returns
 * it; empty for a new one). With multi_location off, the list is hidden: a non-empty one is
 * CAPABILITY_DISABLED, and an empty one leaves what is stored alone (null: no change), since a hidden
 * field is kept, never cleared. A member without settings.locations.manage sees the list read only:
 * the list as stored changes nothing (null), and any other is FORBIDDEN (D-129). Otherwise every id
 * must be a live location of the business (NOT_FOUND).
 */
async function checkedLocations(
  ctx: BusinessCtx,
  tx: Tx,
  locationIds: readonly string[],
  stored: readonly string[],
): Promise<readonly string[] | null> {
  if (!ctx.access.capabilities.multi_location) {
    if (locationIds.length > 0) throw new AppError('capability_disabled')
    return null
  }
  if (!can(ctx.access.effective, PICK_LOCATIONS)) {
    const unchanged =
      locationIds.length === stored.length && locationIds.every((id) => stored.includes(id))
    if (!unchanged) {
      throw new AppError('forbidden', { message: `where it is sold needs ${PICK_LOCATIONS}` })
    }
    return null
  }
  if (locationIds.length === 0) return []
  // FOR SHARE: a removal of one of them (which locks it FOR UPDATE) waits for this save, or this
  // save waits for it and then finds the location gone (D-129).
  const found = await tx
    .select({ id: locations.id })
    .from(locations)
    .where(
      and(
        eq(locations.businessId, ctx.businessId),
        inArray(locations.id, [...locationIds]),
        isNull(locations.deletedAt),
      ),
    )
    .for('share')
  if (found.length !== locationIds.length) throw new AppError('not_found')
  return locationIds
}

/**
 * Makes the product's live links exactly `locationIds`: links taken out are soft-deleted, links
 * added are inserted or brought back.
 */
async function setLocations(
  tx: Tx,
  businessId: string,
  productId: string,
  locationIds: readonly string[],
): Promise<void> {
  const keep = [...locationIds]
  await tx
    .update(productLocations)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        eq(productLocations.businessId, businessId),
        eq(productLocations.productId, productId),
        isNull(productLocations.deletedAt),
        ...(keep.length > 0 ? [notInArray(productLocations.locationId, keep)] : []),
      ),
    )
  if (keep.length === 0) return
  await tx
    .insert(productLocations)
    .values(keep.map((locationId) => ({ id: newId(), businessId, productId, locationId })))
    .onConflictDoUpdate({
      target: [
        productLocations.businessId,
        productLocations.productId,
        productLocations.locationId,
      ],
      set: { deletedAt: null },
      setWhere: isNotNull(productLocations.deletedAt),
    })
}

function columnsOf(fields: Fields) {
  return {
    name: fields.name,
    description: fields.description,
    type: fields.type,
    unit: fields.unit,
    defaultPrice: fields.defaultPrice,
    vatCategory: fields.vatCategory,
    priceIncludesVat: fields.priceIncludesVat,
  }
}

/** `product.list`: a page by name (case ignored). */
export async function listProducts(ctx: BusinessCtx, input: ListInput): Promise<ProductListDto> {
  const conditions: SQL[] = [
    eq(productsServices.businessId, ctx.businessId),
    isNull(productsServices.deletedAt),
  ]
  if (input.status === 'active') conditions.push(isNull(productsServices.archivedAt))
  if (input.status === 'archived') conditions.push(isNotNull(productsServices.archivedAt))
  if (input.search) conditions.push(ilike(productsServices.name, containsPattern(input.search)))
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor)
    conditions.push(
      sql`(lower(${productsServices.name}), ${productsServices.id}) > (${cursor.key}, ${cursor.id}::uuid)`,
    )
  }
  return ctx.tx(async (tx) => {
    const rows = await tx
      .select({ ...productColumns, sortKey: sql<string>`lower(${productsServices.name})` })
      .from(productsServices)
      .where(and(...conditions))
      .orderBy(sql`lower(${productsServices.name})`, asc(productsServices.id))
      .limit(input.limit + 1)
    const page = rows.slice(0, input.limit)
    const links = await locationsOf(
      tx,
      ctx.businessId,
      page.map((r) => r.id),
    )
    const last = page.at(-1)
    return {
      items: page.map((row) => toDto(row, links.get(row.id) ?? [])),
      nextCursor:
        rows.length > input.limit && last ? encodeCursor({ key: last.sortKey, id: last.id }) : null,
    }
  })
}

/** `product.get`: NOT_FOUND unless it is a product or service of this business. */
export function getProduct(ctx: BusinessCtx, input: IdInput): Promise<ProductDto> {
  return ctx.tx((tx) => loadProduct(tx, ctx.businessId, input.id))
}

/**
 * `product.create`: idempotent on the client's id (the same payload again returns it; an id used by
 * another create or another business is CONFLICT). NAME_TAKEN when the business already has a
 * product or service with that name (archived ones included).
 */
export async function createProduct(ctx: BusinessCtx, input: CreateInput): Promise<ProductDto> {
  const { id, ...fields } = input
  const requestHash = requestHashOf(fields)
  return withUniqueName(NAME_KEY, () =>
    ctx.tx(async (tx) => {
      const locationIds = await checkedLocations(ctx, tx, fields.locationIds, [])
      const { row, created } = await createIdempotent(tx, productsServices, {
        id,
        businessId: ctx.businessId,
        ...columnsOf(fields),
        requestHash,
      })
      if (row.deletedAt !== null) throw new AppError('conflict', { message: 'product was removed' })
      if (created && locationIds && locationIds.length > 0) {
        await setLocations(tx, ctx.businessId, id, locationIds)
      }
      return loadProduct(tx, ctx.businessId, id)
    }),
  )
}

/**
 * `product.update`: the whole record, `version` as read (CONFLICT when it changed since, NOT_FOUND
 * when it is not a product or service of this business). The locations are checked against what is
 * stored once the version matched, so a form opened before another change gets CONFLICT.
 */
export async function updateProduct(ctx: BusinessCtx, input: UpdateInput): Promise<ProductDto> {
  const { id, version, ...fields } = input
  return withUniqueName(NAME_KEY, () =>
    ctx.tx(async (tx) => {
      const [row] = await tx
        .update(productsServices)
        .set(columnsOf(fields))
        .where(
          and(
            eq(productsServices.businessId, ctx.businessId),
            eq(productsServices.id, id),
            isNull(productsServices.deletedAt),
            eq(productsServices.version, version),
          ),
        )
        .returning({ id: productsServices.id })
      if (!row) {
        if (await findProduct(tx, ctx.businessId, id)) throw new AppError('conflict')
        throw new AppError('not_found')
      }
      const stored = (await locationsOf(tx, ctx.businessId, [id])).get(id) ?? []
      const locationIds = await checkedLocations(ctx, tx, fields.locationIds, stored)
      if (locationIds) await setLocations(tx, ctx.businessId, id, locationIds)
      return loadProduct(tx, ctx.businessId, id)
    }),
  )
}

/** Sets or clears archived_at; a record already in that state is returned unchanged. */
async function setArchived(
  ctx: BusinessCtx,
  input: IdInput,
  archived: boolean,
): Promise<ProductDto> {
  return ctx.tx(async (tx) => {
    await tx
      .update(productsServices)
      .set({ archivedAt: archived ? sql`now()` : null })
      .where(
        and(
          eq(productsServices.businessId, ctx.businessId),
          eq(productsServices.id, input.id),
          isNull(productsServices.deletedAt),
          archived ? isNull(productsServices.archivedAt) : isNotNull(productsServices.archivedAt),
        ),
      )
    return loadProduct(tx, ctx.businessId, input.id)
  })
}

/** `product.archive`: hidden from pickers from now on; kept with its history (never deleted). */
export function archiveProduct(ctx: BusinessCtx, input: IdInput): Promise<ProductDto> {
  return setArchived(ctx, input, true)
}

/** `product.unarchive`: back in the pickers. */
export function unarchiveProduct(ctx: BusinessCtx, input: IdInput): Promise<ProductDto> {
  return setArchived(ctx, input, false)
}
