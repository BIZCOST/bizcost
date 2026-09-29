import type {
  catalogIdInput,
  catalogListInput,
  createMaterialInput,
  MaterialDto,
  MaterialListDto,
  updateMaterialInput,
} from '@bizcost/contracts'
import { createIdempotent, materials, materialUnits, productsServices, type Tx } from '@bizcost/db'
import {
  can,
  compareDecimal,
  dimensionOf,
  validateMaterialUnits,
  type Dimension,
  type MaterialUnitKind,
  type MaterialUnits,
  type StandardUnit,
} from '@bizcost/domain'
import { and, asc, eq, ilike, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { assertPermission } from '../trpc'
import {
  containsPattern,
  decodeCursor,
  encodeCursor,
  requestHashOf,
  withUniqueName,
} from './catalog'
import { recomputeRecipeLines } from './recipes'

// Materials (ROADMAP.md M2 Step 2; DATA_MODEL.md §6, D-108, D-122, D-123): what a business buys to
// make or sell, with the units it buys it in. Module `materials`, materials.items.view to read and
// materials.items.manage to write (the router checks both). A material is saved whole: its name, its
// unit (which fixes its dimension) and every pack and cross factor, checked together by the domain's
// units engine. Nothing is ever deleted: a material is archived, and units taken out of it are
// soft-deleted.
//
// M2 Step 4: recipes name materials in any of their units, so a material that recipes use keeps its
// dimension (MATERIAL_IN_USE), and a change of its units works their base quantities out again, or is
// refused when a line would no longer convert (UNIT_IN_USE, D-148). The material of an item bought
// ready to sell (D-117) moves with its product: its name, unit and archiving change both, with the
// product's permission too, and its product's row is locked first (as product.update does).

type ListInput = z.output<typeof catalogListInput>
type IdInput = z.output<typeof catalogIdInput>
type CreateInput = z.output<typeof createMaterialInput>
type UpdateInput = z.output<typeof updateMaterialInput>
type UnitsInput = Pick<CreateInput, 'packs' | 'crossFactors'>

/**
 * The unique index on (business_id, app.name_key(name)) of live materials: one name per business,
 * compared the way people read it (nameKey in @bizcost/domain; migration name_key).
 */
export const MATERIAL_NAME_KEY = 'materials_name_key'

/** The same index of products and services (an item bought ready to sell has both names). */
const PRODUCT_NAME_KEY = 'products_services_name_key'

const materialColumns = {
  id: materials.id,
  name: materials.name,
  dimension: materials.dimension,
  unit: materials.unit,
  archivedAt: materials.archivedAt,
  version: materials.version,
}

type MaterialRow = {
  id: string
  name: string
  dimension: Dimension
  unit: StandardUnit
  archivedAt: Date | null
  version: number
}

const unitColumns = {
  id: materialUnits.id,
  materialId: materialUnits.materialId,
  kind: materialUnits.kind,
  name: materialUnits.name,
  unit: materialUnits.unit,
  // Exact, without the column's trailing zeros ("12", not "12.000000000000").
  qty: sql<string>`trim_scale(${materialUnits.qty})::text`,
  ofUnit: materialUnits.ofUnit,
  ofPackId: materialUnits.ofPackId,
}

type UnitRow = {
  id: string
  materialId: string
  kind: MaterialUnitKind
  name: string | null
  unit: StandardUnit | null
  qty: string
  ofUnit: StandardUnit | null
  ofPackId: string | null
}

/** A unit as stored: the rows `material_units` holds for a material's packs and cross factors. */
type UnitValues = Omit<UnitRow, 'materialId'>

function toDto(
  row: MaterialRow,
  units: readonly UnitRow[],
  resaleProductId: string | null,
): MaterialDto {
  return {
    id: row.id,
    name: row.name,
    dimension: row.dimension,
    unit: row.unit,
    packs: units
      .filter((u) => u.kind === 'pack')
      .map((u) => ({
        id: u.id,
        name: u.name ?? '',
        qty: u.qty,
        ofUnit: u.ofUnit,
        ofPackId: u.ofPackId,
      })),
    crossFactors: units
      .filter((u) => u.kind === 'cross')
      .map((u) => ({ id: u.id, unit: u.unit ?? 'g', qty: u.qty, ofUnit: u.ofUnit ?? 'g' })),
    resaleProductId,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
  }
}

async function unitsOf(tx: Tx, businessId: string, ids: readonly string[]): Promise<UnitRow[]> {
  if (ids.length === 0) return []
  return tx
    .select(unitColumns)
    .from(materialUnits)
    .where(
      and(
        eq(materialUnits.businessId, businessId),
        inArray(materialUnits.materialId, [...ids]),
        isNull(materialUnits.deletedAt),
      ),
    )
    .orderBy(asc(materialUnits.createdAt), asc(materialUnits.id))
}

/** The products these materials are sold as (items bought ready to sell, D-117), by material. */
async function resaleProductsOf(
  tx: Tx,
  businessId: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await tx
    .select({ id: productsServices.id, materialId: productsServices.resaleMaterialId })
    .from(productsServices)
    .where(
      and(
        eq(productsServices.businessId, businessId),
        inArray(productsServices.resaleMaterialId, [...ids]),
        isNull(productsServices.deletedAt),
      ),
    )
  return new Map(rows.flatMap((r) => (r.materialId ? [[r.materialId, r.id] as const] : [])))
}

/**
 * The product an item bought ready to sell is sold as, locked FOR UPDATE: whoever changes the pair
 * (product.update, material.update, archiving either) locks the product first, then the material.
 */
async function lockResaleProduct(tx: Tx, businessId: string, materialId: string) {
  const [row] = await tx
    .select({
      id: productsServices.id,
      name: productsServices.name,
      unit: productsServices.unit,
    })
    .from(productsServices)
    .where(
      and(
        eq(productsServices.businessId, businessId),
        eq(productsServices.resaleMaterialId, materialId),
        isNull(productsServices.deletedAt),
      ),
    )
    .for('update')
  return row
}

async function findMaterial(tx: Tx, businessId: string, id: string) {
  const [row] = await tx
    .select(materialColumns)
    .from(materials)
    .where(
      and(eq(materials.businessId, businessId), eq(materials.id, id), isNull(materials.deletedAt)),
    )
  return row
}

async function loadMaterial(tx: Tx, businessId: string, id: string): Promise<MaterialDto> {
  const row = await findMaterial(tx, businessId, id)
  if (!row) throw new AppError('not_found')
  const resale = await resaleProductsOf(tx, businessId, [id])
  return toDto(row, await unitsOf(tx, businessId, [id]), resale.get(id) ?? null)
}

/**
 * The units as the table stores them, after the domain's check of the whole set: every chain ends at
 * a standard unit without loops, units of another dimension need a cross factor, at most one cross
 * factor per dimension (VALIDATION otherwise). Ids are unique across packs and cross factors, and
 * pack names unique ignoring case.
 */
export function checkedUnits(dimension: Dimension, input: UnitsInput): UnitValues[] {
  const units: MaterialUnits = {
    dimension,
    packs: input.packs.map((p) => ({
      id: p.id,
      qty: p.qty,
      of: p.ofUnit ?? { pack: p.ofPackId ?? '' },
    })),
    crossFactors: input.crossFactors.map((c) => ({ unit: c.unit, qty: c.qty, of: c.ofUnit })),
  }
  const problems = validateMaterialUnits(units).map((e) => e.code)
  const ids = [...input.packs, ...input.crossFactors].map((u) => u.id)
  if (new Set(ids).size !== ids.length) problems.push('duplicate_pack')
  const names = input.packs.map((p) => p.name.toLocaleLowerCase())
  if (new Set(names).size !== names.length) problems.push('duplicate_pack')
  if (problems.length > 0) {
    throw new AppError('validation', { message: `units: ${[...new Set(problems)].join(', ')}` })
  }
  return [
    ...input.packs.map((p): UnitValues => ({
      id: p.id,
      kind: 'pack',
      name: p.name,
      unit: null,
      qty: p.qty,
      ofUnit: p.ofUnit ?? null,
      ofPackId: p.ofPackId ?? null,
    })),
    ...input.crossFactors.map((c): UnitValues => ({
      id: c.id,
      kind: 'cross',
      name: null,
      unit: c.unit,
      qty: c.qty,
      ofUnit: c.ofUnit,
      ofPackId: null,
    })),
  ]
}

/** `material.list`: a page by name (case ignored), with its units. */
export async function listMaterials(ctx: BusinessCtx, input: ListInput): Promise<MaterialListDto> {
  const conditions: SQL[] = [eq(materials.businessId, ctx.businessId), isNull(materials.deletedAt)]
  if (input.status === 'active') conditions.push(isNull(materials.archivedAt))
  if (input.status === 'archived') conditions.push(isNotNull(materials.archivedAt))
  if (input.search) conditions.push(ilike(materials.name, containsPattern(input.search)))
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor)
    conditions.push(
      sql`(lower(${materials.name}), ${materials.id}) > (${cursor.key}, ${cursor.id}::uuid)`,
    )
  }
  return ctx.tx(async (tx) => {
    const rows = await tx
      .select({ ...materialColumns, sortKey: sql<string>`lower(${materials.name})` })
      .from(materials)
      .where(and(...conditions))
      .orderBy(sql`lower(${materials.name})`, asc(materials.id))
      .limit(input.limit + 1)
    const page = rows.slice(0, input.limit)
    const ids = page.map((r) => r.id)
    const units = await unitsOf(tx, ctx.businessId, ids)
    const resale = await resaleProductsOf(tx, ctx.businessId, ids)
    const last = page.at(-1)
    return {
      items: page.map((row) =>
        toDto(
          row,
          units.filter((u) => u.materialId === row.id),
          resale.get(row.id) ?? null,
        ),
      ),
      nextCursor:
        rows.length > input.limit && last ? encodeCursor({ key: last.sortKey, id: last.id }) : null,
    }
  })
}

/** `material.get`: NOT_FOUND unless it is a material of this business. */
export function getMaterial(ctx: BusinessCtx, input: IdInput): Promise<MaterialDto> {
  return ctx.tx((tx) => loadMaterial(tx, ctx.businessId, input.id))
}

/**
 * The name of the live material (archived ones included) that is the same name as `name` the way
 * people read it (app.name_key), for NAME_TAKEN to name it.
 */
async function sameNamed(ctx: BusinessCtx, name: string): Promise<string[]> {
  return ctx.tx(async (tx) => {
    const rows = (await tx.execute(sql`
      select m.name from app.materials m
       where m.business_id = ${ctx.businessId} and m.deleted_at is null
         and app.name_key(m.name) = app.name_key(${name})
       limit 1
    `)) as unknown as { name: string }[]
    return rows.map((row) => row.name)
  })
}

/**
 * `material.create`, and `material.quickCreate` from a purchase line: idempotent on the client's id
 * (the same payload again returns the material; an id used by another create or another business is
 * CONFLICT). NAME_TAKEN when the business already has a material with that name the way people read
 * it (case, spaces, Arabic letter forms, marks, digits; archived ones included), naming it in
 * `error.data.names` so the screen can offer it instead.
 */
export async function createMaterial(ctx: BusinessCtx, input: CreateInput): Promise<MaterialDto> {
  try {
    return await insertMaterial(ctx, input)
  } catch (error) {
    if (error instanceof AppError && error.appCode === 'name_taken') {
      throw new AppError('name_taken', { cause: error, names: await sameNamed(ctx, input.name) })
    }
    throw error
  }
}

async function insertMaterial(ctx: BusinessCtx, input: CreateInput): Promise<MaterialDto> {
  const dimension = dimensionOf(input.unit)
  const units = checkedUnits(dimension, input)
  const requestHash = requestHashOf({
    name: input.name,
    unit: input.unit,
    packs: input.packs,
    crossFactors: input.crossFactors,
  })
  return withUniqueName(MATERIAL_NAME_KEY, () =>
    ctx.tx(async (tx) => {
      const { row, created } = await createIdempotent(tx, materials, {
        id: input.id,
        businessId: ctx.businessId,
        name: input.name,
        dimension,
        unit: input.unit,
        requestHash,
      })
      if (row.deletedAt !== null)
        throw new AppError('conflict', { message: 'material was removed' })
      // One statement: a pack may name another new pack (the FK is checked at its end).
      if (created && units.length > 0) {
        await tx
          .insert(materialUnits)
          .values(units.map((u) => ({ ...u, businessId: ctx.businessId, materialId: row.id })))
      }
      return loadMaterial(tx, ctx.businessId, row.id)
    }),
  )
}

/** Whether a purchase line (drafts too), a stock movement or a recipe line names the material. */
async function materialInUse(tx: Tx, businessId: string, id: string): Promise<boolean> {
  const [row] = (await tx.execute(sql`
    select exists (
             select 1 from app.purchase_lines l
              where l.business_id = ${businessId} and l.material_id = ${id}
                and l.deleted_at is null
           )
        or exists (
             select 1 from app.stock_movements m
              where m.business_id = ${businessId} and m.material_id = ${id}
           )
        or exists (
             select 1 from app.recipe_lines r
              where r.business_id = ${businessId} and r.material_id = ${id}
                and r.deleted_at is null
           ) as used
  `)) as unknown as { used: boolean }[]
  return row?.used === true
}

function sameUnit(a: UnitValues, b: UnitValues): boolean {
  return (
    a.kind === b.kind &&
    a.name === b.name &&
    a.unit === b.unit &&
    compareDecimal(a.qty, b.qty) === 0 &&
    a.ofUnit === b.ofUnit &&
    a.ofPackId === b.ofPackId
  )
}

/**
 * `material.update`: the whole material, `version` as read (CONFLICT when it changed since, NOT_FOUND
 * when it is not a material of this business). Units are matched by id: new ids are added, changed
 * ones updated, missing ones soft-deleted. A unit id cannot turn from a pack into a cross factor, and
 * an id that belongs to another material or business is refused (VALIDATION, CONFLICT). Recipe lines
 * in its units are worked out again (UNIT_IN_USE when one no longer converts, D-148). The material of
 * an item bought ready to sell renames its product and changes its unit too, which needs
 * products.items.manage (FORBIDDEN otherwise; NAME_TAKEN when another product has the name).
 */
export async function updateMaterial(ctx: BusinessCtx, input: UpdateInput): Promise<MaterialDto> {
  const dimension = dimensionOf(input.unit)
  const wanted = checkedUnits(dimension, input)
  return withUniqueName([MATERIAL_NAME_KEY, PRODUCT_NAME_KEY], () =>
    ctx.tx(async (tx) => {
      // Bought ready to sell: its product's row first (the lock order of every change of the pair).
      const product = await lockResaleProduct(tx, ctx.businessId, input.id)
      // As read: the update below matches only this version, so its dimension is the one it changes.
      const current = await findMaterial(tx, ctx.businessId, input.id)
      // The row lock taken here also makes saves of this material wait for each other, and a draft
      // save or a posting of it (they lock it FOR SHARE first) waits for this one, or this one for it.
      // With the row locked, the trigger keep_dimension refuses a change of dimension once the
      // material is in the stock ledger (MATERIAL_IN_USE, D-145).
      const [row] = await tx
        .update(materials)
        .set({ name: input.name, dimension, unit: input.unit })
        .where(
          and(
            eq(materials.businessId, ctx.businessId),
            eq(materials.id, input.id),
            isNull(materials.deletedAt),
            eq(materials.version, input.version),
          ),
        )
        .returning({ id: materials.id })
      if (!row) {
        if (await findMaterial(tx, ctx.businessId, input.id)) throw new AppError('conflict')
        throw new AppError('not_found')
      }
      // A material with purchases (drafts too) or anything in the ledger keeps its kind of measure:
      // their quantities are in its base unit (D-134). Its unit may still change within the
      // dimension. Checked under the row lock, so a draft saved meanwhile is seen (D-145).
      if (current?.dimension !== dimension && (await materialInUse(tx, ctx.businessId, input.id))) {
        throw new AppError('material_in_use')
      }

      const live = new Map(
        (await unitsOf(tx, ctx.businessId, [input.id])).map((u) => [u.id, u] as const),
      )
      const added = wanted.filter((u) => !live.has(u.id))
      const changed = wanted.filter((u) => {
        const before = live.get(u.id)
        return before !== undefined && !sameUnit(u, before)
      })
      if (changed.some((u) => live.get(u.id)?.kind !== u.kind)) {
        throw new AppError('validation', { message: 'a unit cannot change its kind' })
      }
      const kept = new Set(wanted.map((u) => u.id))
      const removed = [...live.keys()].filter((id) => !kept.has(id))

      // New units first (a changed pack may now name one), in one statement (they may name each
      // other); then the changes; then what was taken out. Soft-deleted rows stay, so a reference
      // to them never breaks.
      if (added.length > 0) {
        await tx
          .insert(materialUnits)
          .values(added.map((u) => ({ ...u, businessId: ctx.businessId, materialId: input.id })))
      }
      for (const unit of changed) {
        await tx
          .update(materialUnits)
          .set({
            name: unit.name,
            unit: unit.unit,
            qty: unit.qty,
            ofUnit: unit.ofUnit,
            ofPackId: unit.ofPackId,
          })
          .where(
            and(
              eq(materialUnits.businessId, ctx.businessId),
              eq(materialUnits.materialId, input.id),
              eq(materialUnits.id, unit.id),
            ),
          )
      }
      if (removed.length > 0) {
        await tx
          .update(materialUnits)
          .set({ deletedAt: sql`now()` })
          .where(
            and(
              eq(materialUnits.businessId, ctx.businessId),
              eq(materialUnits.materialId, input.id),
              inArray(materialUnits.id, removed),
            ),
          )
      }
      // Recipes that use it in a pack or a conversion follow what its units say now.
      if (added.length + changed.length + removed.length > 0) {
        await recomputeRecipeLines(
          tx,
          ctx.businessId,
          input.id,
          can(ctx.access.effective, 'products.recipes.view'),
        )
      }
      if (product && (product.name !== input.name || product.unit !== input.unit)) {
        assertPermission(ctx, 'products.items.manage')
        await tx
          .update(productsServices)
          .set({ name: input.name, unit: input.unit })
          .where(
            and(
              eq(productsServices.businessId, ctx.businessId),
              eq(productsServices.id, product.id),
            ),
          )
      }
      return loadMaterial(tx, ctx.businessId, input.id)
    }),
  )
}

/**
 * Keeps the material of an item bought ready to sell in step with its product (D-117), after
 * product.update changed the product's name or unit (the product's row is locked already): the same
 * name and unit, so the same dimension. A new dimension needs the material's packs and conversions to
 * fit it (VALIDATION) and nothing to use the material (MATERIAL_IN_USE: purchases, the ledger,
 * recipes), checked under its row lock as material.update does.
 */
export async function syncResaleMaterial(
  tx: Tx,
  businessId: string,
  materialId: string,
  name: string,
  unit: StandardUnit,
): Promise<void> {
  const current = await findMaterial(tx, businessId, materialId)
  if (!current) throw new AppError('not_found')
  if (current.name === name && current.unit === unit) return
  const dimension = dimensionOf(unit)
  if (dimension !== current.dimension) {
    const units = await unitsOf(tx, businessId, [materialId])
    checkedUnits(dimension, {
      packs: units
        .filter((u) => u.kind === 'pack')
        .map((u) => ({
          id: u.id,
          name: u.name ?? '',
          qty: u.qty,
          ofUnit: u.ofUnit,
          ofPackId: u.ofPackId,
        })),
      crossFactors: units
        .filter((u) => u.kind === 'cross')
        .map((u) => ({ id: u.id, unit: u.unit ?? 'g', qty: u.qty, ofUnit: u.ofUnit ?? 'g' })),
    })
  }
  await tx
    .update(materials)
    .set({ name, unit, dimension })
    .where(and(eq(materials.businessId, businessId), eq(materials.id, materialId)))
  if (dimension !== current.dimension && (await materialInUse(tx, businessId, materialId))) {
    throw new AppError('material_in_use')
  }
}

/**
 * Archives or brings back the material of an item bought ready to sell with its product (D-117; the
 * product's row is locked already). A material already in that state is left as it is.
 */
export async function setResaleMaterialArchived(
  tx: Tx,
  businessId: string,
  materialId: string,
  archived: boolean,
): Promise<void> {
  await tx
    .update(materials)
    .set({ archivedAt: archived ? sql`now()` : null })
    .where(
      and(
        eq(materials.businessId, businessId),
        eq(materials.id, materialId),
        isNull(materials.deletedAt),
        archived ? isNull(materials.archivedAt) : isNotNull(materials.archivedAt),
      ),
    )
}

/**
 * Sets or clears archived_at; a material already in that state is returned unchanged. The material of
 * an item bought ready to sell takes its product with it (D-117), which needs products.items.manage.
 */
async function setArchived(
  ctx: BusinessCtx,
  input: IdInput,
  archived: boolean,
): Promise<MaterialDto> {
  return ctx.tx(async (tx) => {
    const product = await lockResaleProduct(tx, ctx.businessId, input.id)
    if (product) assertPermission(ctx, 'products.items.manage')
    await setResaleMaterialArchived(tx, ctx.businessId, input.id, archived)
    if (product) {
      await tx
        .update(productsServices)
        .set({ archivedAt: archived ? sql`now()` : null })
        .where(
          and(
            eq(productsServices.businessId, ctx.businessId),
            eq(productsServices.id, product.id),
            archived ? isNull(productsServices.archivedAt) : isNotNull(productsServices.archivedAt),
          ),
        )
    }
    return loadMaterial(tx, ctx.businessId, input.id)
  })
}

/** `material.archive`: hidden from pickers from now on; kept with its history (never deleted). */
export function archiveMaterial(ctx: BusinessCtx, input: IdInput): Promise<MaterialDto> {
  return setArchived(ctx, input, true)
}

/** `material.unarchive`: back in the pickers. */
export function unarchiveMaterial(ctx: BusinessCtx, input: IdInput): Promise<MaterialDto> {
  return setArchived(ctx, input, false)
}
