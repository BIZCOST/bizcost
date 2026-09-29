import type {
  MaterialsCostDto,
  ProductCostDto,
  productCostsInput,
  ProductCostsDto,
  RecipeDto,
  recipeGetInput,
  RecipeLineDto,
  RecipeResultDto,
  saveRecipeInput,
} from '@bizcost/contracts'
import { productsServices, recipeLines, recipes, type Tx } from '@bizcost/db'
import {
  compareDecimal,
  costOfQty,
  costRatio,
  dimensionOf,
  newId,
  rollUpRecipe,
  STANDARD_UNITS,
  unitCostOf,
  type Dimension,
  type Quantity,
  type StandardUnit,
} from '@bizcost/domain'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import {
  averageBasisOf,
  averageWindowOf,
  costRecordsOf,
  type AverageBasis,
  type CostRecord,
} from './material-costs'
import { baseQtyOf, loadMaterials } from './purchase-materials'
import { lockMaterials, uuidArray } from './stock'

// Recipes and product cost (ROADMAP.md M2 Step 4; DATA_MODEL.md §6; D-115, D-117, D-146–D-150, D-178).
// One structure for a recipe, a bill of materials and "what you use": what it takes to make its
// `yield_qty` units of a product or service (1 by default: what ONE unit uses; a cake that makes 12
// slices), each line a material and a quantity in any unit or pack of it, kept as typed and in the
// material's base unit. Module `products` (and `materials`: lines are materials), products.recipes.view
// to read and products.recipes.manage to write (the router checks them). A save names the recipe's
// version (0 before its first save; CONFLICT otherwise); lines are matched by their client ids, and
// lines taken out are soft-deleted. An item bought ready to sell has no recipe (VALIDATION): it costs
// its material's average for one unit sold.
//
// Cost, computed on read (D-115, D-138): each line's base quantity × its material's average today,
// the one material.costs shows (costRecordsOf, averageBasisOf), an exact product divided once and
// rounded once to 12 decimals by the domain (rollUpRecipe); never rounded to the currency. One unit
// sold costs the total ÷ the yield (`perUnit`, one more division, 12 decimals). A material never
// bought has no price (null, never 0), and the total says it is incomplete. Every cost is `cost` (the
// redact middleware removes it for members who may not see it).
//
// Locks: a save locks the recipe's row (its version), then its materials FOR SHARE by ascending id
// (lock 3 of postings, D-135), before it reads their units: a material's change of units or dimension
// either finishes first, and the save converts with the new units, or waits for the save and then
// sees its lines (MATERIAL_IN_USE, or its lines worked out again, UNIT_IN_USE when one no longer
// converts; D-148).

type GetInput = z.output<typeof recipeGetInput>
type SaveInput = z.output<typeof saveRecipeInput>
type CostsInput = z.output<typeof productCostsInput>

/** Most product names a UNIT_IN_USE refusal says. */
const UNIT_IN_USE_NAMES_MAX = 5

interface ProductInfo {
  readonly id: string
  readonly unit: StandardUnit
  readonly resaleMaterialId: string | null
}

async function findProduct(
  tx: Tx,
  businessId: string,
  id: string,
): Promise<ProductInfo | undefined> {
  const [row] = await tx
    .select({
      id: productsServices.id,
      unit: productsServices.unit,
      resaleMaterialId: productsServices.resaleMaterialId,
    })
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

/** A product of the business that may have a recipe: NOT_FOUND, or VALIDATION when bought ready to sell. */
async function recipeProduct(tx: Tx, businessId: string, id: string): Promise<ProductInfo> {
  const product = await findProduct(tx, businessId, id)
  if (!product) throw new AppError('not_found')
  if (product.resaleMaterialId !== null) {
    throw new AppError('validation', { message: 'bought ready to sell: it has no recipe' })
  }
  return product
}

export interface RecipeRow {
  readonly id: string
  readonly version: number
  /** How many of the product's unit it makes, without trailing zeros. */
  readonly yieldQty: string
}

/** The recipe's yield as a plain decimal string ("12", not "12.000000"). */
const yieldOf = sql<string>`trim_scale(${recipes.yieldQty})::text`

export async function findRecipe(
  tx: Tx,
  businessId: string,
  productId: string,
): Promise<RecipeRow | undefined> {
  const [row] = await tx
    .select({ id: recipes.id, version: recipes.version, yieldQty: yieldOf })
    .from(recipes)
    .where(
      and(
        eq(recipes.businessId, businessId),
        eq(recipes.productId, productId),
        isNull(recipes.deletedAt),
      ),
    )
  return row
}

export interface LineRecord extends Record<string, unknown> {
  id: string
  material_id: string
  qty: string
  unit: StandardUnit | null
  pack_id: string | null
  base_qty: string
  material_name: string
  material_unit: StandardUnit
  dimension: Dimension
  material_archived: boolean
  pack_name: string | null
}

/** The live lines of a recipe, in their order, with their materials as they are now. */
export async function linesOf(tx: Tx, businessId: string, recipeId: string): Promise<LineRecord[]> {
  return (await tx.execute(sql`
    select l.id, l.material_id, trim_scale(l.qty)::text as qty, l.unit, l.pack_id,
           trim_scale(l.base_qty)::text as base_qty, m.name as material_name,
           m.unit as material_unit, m.dimension, m.archived_at is not null as material_archived,
           u.name as pack_name
      from app.recipe_lines l
      join app.materials m on m.business_id = l.business_id and m.id = l.material_id
      left join app.material_units u on u.business_id = l.business_id and u.id = l.pack_id
     where l.business_id = ${businessId}
       and l.recipe_id = ${recipeId}
       and l.deleted_at is null
     order by l.position, l.id
  `)) as unknown as LineRecord[]
}

/** The D-115 basis of each material (null: never bought), from one read of the ledger. */
export async function basesOf(
  tx: Tx,
  businessId: string,
  materialIds: readonly string[],
): Promise<Map<string, { record: CostRecord; basis: AverageBasis | null }>> {
  const records = await costRecordsOf(tx, businessId, [...new Set(materialIds)])
  return new Map(
    [...records].map(([id, record]) => [id, { record, basis: averageBasisOf(record) }] as const),
  )
}

async function recipeDtoOf(
  tx: Tx,
  businessId: string,
  product: ProductInfo,
  recipe: RecipeRow | undefined,
): Promise<RecipeDto> {
  const lines = recipe ? await linesOf(tx, businessId, recipe.id) : []
  const bases = await basesOf(
    tx,
    businessId,
    lines.map((l) => l.material_id),
  )
  const window = await averageWindowOf(tx, businessId)
  const basisOf = (line: LineRecord) => bases.get(line.material_id)?.basis ?? null
  const yieldQty = recipe?.yieldQty ?? '1'
  const rolled = rollUpRecipe(
    lines.map((l) => ({ baseQty: l.base_qty, basis: basisOf(l) })),
    yieldQty,
  )
  return {
    productId: product.id,
    productUnit: product.unit,
    yieldQty,
    version: recipe?.version ?? 0,
    lines: lines.map((line, i): RecipeLineDto => {
      const basis = basisOf(line)
      const lineCost = rolled.lines[i] ?? null
      const perBaseUnit = basis ? costRatio([basis.value], [basis.qty]) : null
      const perUnit = basis
        ? costRatio([basis.value, STANDARD_UNITS[line.material_unit].factor], [basis.qty])
        : null
      return {
        id: line.id,
        materialId: line.material_id,
        materialName: line.material_name,
        materialUnit: line.material_unit,
        dimension: line.dimension,
        materialArchived: line.material_archived,
        qty: line.qty,
        unit: line.unit,
        packId: line.pack_id,
        packName: line.pack_name,
        baseQty: line.base_qty,
        cost:
          basis && lineCost !== null && perBaseUnit !== null && perUnit !== null
            ? { basis: basis.basis, perUnit, perBaseUnit, lineCost }
            : null,
      }
    }),
    cost: {
      total: rolled.total,
      perUnit: rolled.perUnit,
      tooLarge: rolled.tooLarge,
      unpricedLines: rolled.unpriced,
      complete: rolled.complete,
    },
    averageFrom: window.from,
    averageTo: window.to,
  }
}

/** `recipe.get`: NOT_FOUND unless it is a product or service of this business. */
export function getRecipe(ctx: BusinessCtx, input: GetInput): Promise<RecipeResultDto> {
  return ctx.tx(async (tx) => {
    const product = await recipeProduct(tx, ctx.businessId, input.productId)
    const recipe = await findRecipe(tx, ctx.businessId, product.id)
    return { data: await recipeDtoOf(tx, ctx.businessId, product, recipe), meta: { redacted: [] } }
  })
}

interface WantedLine {
  readonly id: string
  readonly position: number
  readonly materialId: string
  readonly qty: string
  readonly unit: StandardUnit | null
  readonly packId: string | null
  readonly baseQty: Quantity
}

interface StoredLine {
  readonly id: string
  readonly position: number
  readonly materialId: string
  readonly qty: string
  readonly unit: StandardUnit | null
  readonly packId: string | null
  readonly baseQty: string
}

function sameLine(a: WantedLine, b: StoredLine): boolean {
  return (
    a.position === b.position &&
    a.materialId === b.materialId &&
    compareDecimal(a.qty, b.qty) === 0 &&
    a.unit === b.unit &&
    a.packId === b.packId &&
    compareDecimal(a.baseQty, b.baseQty) === 0
  )
}

/**
 * `recipe.save`: the whole recipe, `version` as read (0 before its first save). CONFLICT when it
 * changed since (or was made meanwhile); NOT_FOUND for a product or a material that is not one of the
 * business; VALIDATION for an item bought ready to sell, or a line whose unit is not one of its
 * material's (a pack of another material, another dimension without a conversion) or whose quantity
 * in base units is 0 or too large. A line id used anywhere else is CONFLICT. `yieldQty` omitted keeps
 * the recipe's (1 for a new one). A save that changes nothing (the same yield and lines, in the same
 * order and units) writes nothing: the version stays and no audit row is added.
 */
export function saveRecipe(ctx: BusinessCtx, input: SaveInput): Promise<RecipeResultDto> {
  const businessId = ctx.businessId
  return ctx.tx(async (tx) => {
    const product = await recipeProduct(tx, businessId, input.productId)

    // The recipe's row: made by its first save, then versioned (touch_row adds 1 on every save that
    // changes something). Its lock comes first (FOR NO KEY UPDATE, as the UPDATE takes it).
    let recipeId: string
    // The yield as stored before this save (for a new recipe, the default 1), and as it is wanted.
    let storedYield: string
    if (input.version === 0) {
      const [made] = await tx
        .insert(recipes)
        .values({
          id: newId(),
          businessId,
          productId: product.id,
          yieldQty: input.yieldQty ?? '1',
        })
        .onConflictDoNothing({ target: [recipes.businessId, recipes.productId] })
        .returning({ id: recipes.id })
      if (!made) throw new AppError('conflict')
      recipeId = made.id
      storedYield = '1'
    } else {
      const [row] = await tx
        .select({ id: recipes.id, version: recipes.version, yieldQty: yieldOf })
        .from(recipes)
        .where(
          and(
            eq(recipes.businessId, businessId),
            eq(recipes.productId, product.id),
            isNull(recipes.deletedAt),
          ),
        )
        .for('no key update')
      if (!row || row.version !== input.version) throw new AppError('conflict')
      recipeId = row.id
      storedYield = row.yieldQty
    }
    const wantedYield = input.yieldQty ?? storedYield
    const yieldChanged = compareDecimal(wantedYield, storedYield) !== 0

    // Its materials, locked FOR SHARE by ascending id before their units are read (D-145, D-148).
    const materialIds = input.lines.map((line) => line.materialId)
    const locked = await lockMaterials(tx, businessId, materialIds)
    if (locked.size !== materialIds.length) throw new AppError('not_found')
    const materials = await loadMaterials(tx, businessId, materialIds)
    const wanted = input.lines.map((line, position): WantedLine => {
      const material = materials.get(line.materialId)
      if (!material) throw new AppError('not_found')
      const unit = { unit: line.unit ?? null, packId: line.packId ?? null }
      return {
        id: line.id,
        position,
        materialId: line.materialId,
        qty: line.qty,
        ...unit,
        baseQty: baseQtyOf(material, line.qty, unit),
      }
    })

    const stored = await tx
      .select({
        id: recipeLines.id,
        position: recipeLines.position,
        materialId: recipeLines.materialId,
        qty: recipeLines.qty,
        unit: recipeLines.unit,
        packId: recipeLines.packId,
        baseQty: recipeLines.baseQty,
      })
      .from(recipeLines)
      .where(
        and(
          eq(recipeLines.businessId, businessId),
          eq(recipeLines.recipeId, recipeId),
          isNull(recipeLines.deletedAt),
        ),
      )
    const live = new Map(stored.map((line) => [line.id, line] as const))
    const keep = new Set(wanted.map((line) => line.id))
    const added = wanted.filter((line) => !live.has(line.id))
    const changed = wanted.filter((line) => {
      const before = live.get(line.id)
      return before !== undefined && !sameLine(line, before)
    })
    const removed = stored.filter((line) => !keep.has(line.id)).map((line) => line.id)
    if (
      added.length + changed.length + removed.length === 0 &&
      !yieldChanged &&
      input.version !== 0
    ) {
      const recipe = { id: recipeId, version: input.version, yieldQty: storedYield }
      return { data: await recipeDtoOf(tx, businessId, product, recipe), meta: { redacted: [] } }
    }
    if (input.version !== 0) {
      // One new version of the recipe per save that changes something (its yield, or its lines).
      await tx
        .update(recipes)
        .set(yieldChanged ? { yieldQty: wantedYield } : { updatedAt: sql`now()` })
        .where(and(eq(recipes.businessId, businessId), eq(recipes.id, recipeId)))
    }
    // A line that now names another material leaves its old one first, with the lines taken out,
    // so no two live lines ever name one material (the partial unique index), whatever the order.
    const moved = changed
      .filter((line) => live.get(line.id)?.materialId !== line.materialId)
      .map((line) => line.id)
    if (removed.length + moved.length > 0) {
      await tx
        .update(recipeLines)
        .set({ deletedAt: sql`now()` })
        .where(
          and(
            eq(recipeLines.businessId, businessId),
            eq(recipeLines.recipeId, recipeId),
            inArray(recipeLines.id, [...removed, ...moved]),
          ),
        )
    }
    for (const line of changed) {
      await tx
        .update(recipeLines)
        .set({
          position: line.position,
          materialId: line.materialId,
          qty: line.qty,
          unit: line.unit,
          packId: line.packId,
          baseQty: line.baseQty,
          deletedAt: null,
        })
        .where(
          and(
            eq(recipeLines.businessId, businessId),
            eq(recipeLines.recipeId, recipeId),
            eq(recipeLines.id, line.id),
          ),
        )
    }
    if (added.length > 0) {
      await tx.insert(recipeLines).values(
        added.map((line) => ({
          id: line.id,
          businessId,
          recipeId,
          position: line.position,
          materialId: line.materialId,
          qty: line.qty,
          unit: line.unit,
          packId: line.packId,
          baseQty: line.baseQty,
        })),
      )
    }
    const recipe = await findRecipe(tx, businessId, product.id)
    const saved = await recipeDtoOf(tx, businessId, product, recipe)
    // A yield so small that one unit's cost would not fit a cost amount is refused, and the whole save
    // with it (D-178): what one unit costs is what the product's cost is made of.
    if (yieldChanged && saved.cost.tooLarge) {
      throw new AppError('validation', {
        message: 'yieldQty: too small for what this recipe costs',
      })
    }
    return { data: saved, meta: { redacted: [] } }
  })
}

/**
 * After a material's units changed (material.update, under its row lock): every live recipe line in it
 * is converted again to base units with the units as they are now, and its base quantity updated when
 * it changed. A line that no longer converts (its pack or conversion taken out, or out of range) makes
 * the change UNIT_IN_USE: the recipe is changed first (D-148). The error names the products whose
 * recipes use it that way, for a member who may see recipes (D-152).
 *
 * The lines are locked FOR UPDATE (by ascending id) as they are read: a recipe.save that moves a line
 * to another material, or takes it out, holds the line's row without locking this material (its lines
 * no longer name it). The read waits for that save and then reads the line again as committed; a line
 * that no longer names this material, or was taken out, is left out, so a base quantity worked out in
 * this material's units never lands on a line of another material (D-151). The UPDATE says the same.
 */
export async function recomputeRecipeLines(
  tx: Tx,
  businessId: string,
  materialId: string,
  namesVisible = false,
): Promise<void> {
  const lines = await tx
    .select({
      id: recipeLines.id,
      recipeId: recipeLines.recipeId,
      qty: recipeLines.qty,
      unit: recipeLines.unit,
      packId: recipeLines.packId,
      baseQty: recipeLines.baseQty,
    })
    .from(recipeLines)
    .where(
      and(
        eq(recipeLines.businessId, businessId),
        eq(recipeLines.materialId, materialId),
        isNull(recipeLines.deletedAt),
      ),
    )
    .orderBy(asc(recipeLines.id))
    .for('update')
  if (lines.length === 0) return
  const material = (await loadMaterials(tx, businessId, [materialId])).get(materialId)
  if (!material) throw new AppError('not_found')
  const broken: string[] = []
  for (const line of lines) {
    let baseQty: Quantity
    try {
      baseQty = baseQtyOf(material, line.qty, { unit: line.unit, packId: line.packId })
    } catch {
      broken.push(line.recipeId)
      continue
    }
    if (compareDecimal(baseQty, line.baseQty) !== 0) {
      await tx
        .update(recipeLines)
        .set({ baseQty })
        .where(
          and(
            eq(recipeLines.businessId, businessId),
            eq(recipeLines.id, line.id),
            eq(recipeLines.materialId, materialId),
            isNull(recipeLines.deletedAt),
          ),
        )
    }
  }
  if (broken.length > 0) {
    throw new AppError('unit_in_use', {
      names: namesVisible ? await productNamesOf(tx, businessId, broken) : [],
    })
  }
}

/** The names of the products or services of these recipes, sorted (at most 5). */
async function productNamesOf(
  tx: Tx,
  businessId: string,
  recipeIds: readonly string[],
): Promise<string[]> {
  const rows = await tx
    .select({ name: productsServices.name })
    .from(recipes)
    .innerJoin(
      productsServices,
      and(
        eq(productsServices.businessId, recipes.businessId),
        eq(productsServices.id, recipes.productId),
      ),
    )
    .where(and(eq(recipes.businessId, businessId), inArray(recipes.id, [...new Set(recipeIds)])))
    .orderBy(sql`lower(${productsServices.name})`)
    .limit(UNIT_IN_USE_NAMES_MAX)
  return rows.map((row) => row.name)
}

/** A product whose materials are costed: its id, the unit it is sold by, and how it is made. */
export interface CostedProduct {
  readonly id: string
  readonly unit: StandardUnit
  readonly resaleMaterialId: string | null
}

/** What the materials of one unit sold of a product cost today (product.costs, productCost.*). */
export interface ProductMaterialCost {
  readonly kind: 'recipe' | 'resale'
  /** How many of its unit the recipe makes (1 without a recipe and for an item bought ready to sell). */
  readonly yieldQty: string
  /** Recipe lines (1 for an item bought ready to sell; 0: no recipe yet). */
  readonly lineCount: number
  /** For an item bought ready to sell: which average its cost is (null: never bought). */
  readonly basis: AverageBasis['basis'] | null
  readonly cost: Required<MaterialsCostDto>
}

/**
 * The material cost of one unit sold of each product, by id. A recipe: the roll-up of its lines (none
 * yet: no total), and one unit its total ÷ its yield (D-178). Bought ready to sell: its material's
 * average for one unit (the product's unit is always the material's, D-117). Two reads of recipes and
 * one of the ledger for all of them (costRecordsOf).
 */
export async function materialCostsOf(
  tx: Tx,
  businessId: string,
  products: readonly CostedProduct[],
): Promise<Map<string, ProductMaterialCost>> {
  const ids = products.map((p) => p.id)
  if (ids.length === 0) return new Map()
  const yields = new Map(
    (
      await tx
        .select({ productId: recipes.productId, yieldQty: yieldOf })
        .from(recipes)
        .where(
          and(
            eq(recipes.businessId, businessId),
            inArray(recipes.productId, ids),
            isNull(recipes.deletedAt),
          ),
        )
    ).map((row) => [row.productId, row.yieldQty] as const),
  )
  const lines = (await tx.execute(sql`
    select r.product_id, l.material_id, trim_scale(l.base_qty)::text as base_qty
      from app.recipes r
      join app.recipe_lines l
        on l.business_id = r.business_id and l.recipe_id = r.id and l.deleted_at is null
     where r.business_id = ${businessId}
       and r.product_id = any(${uuidArray(ids)})
       and r.deleted_at is null
     order by r.product_id, l.position, l.id
  `)) as unknown as { product_id: string; material_id: string; base_qty: string }[]
  const bases = await basesOf(tx, businessId, [
    ...lines.map((l) => l.material_id),
    ...products.flatMap((p) => (p.resaleMaterialId ? [p.resaleMaterialId] : [])),
  ])
  const linesByProduct = new Map<string, { material_id: string; base_qty: string }[]>()
  for (const line of lines) {
    linesByProduct.set(line.product_id, [...(linesByProduct.get(line.product_id) ?? []), line])
  }
  const costs = new Map<string, ProductMaterialCost>()
  for (const product of products) {
    if (product.resaleMaterialId !== null) {
      const found = bases.get(product.resaleMaterialId)
      // One unit sold, in base units of the material (its unit is the product's, D-117).
      const basis =
        found?.basis && dimensionOf(found.record.unit) === dimensionOf(product.unit)
          ? found.basis
          : null
      const total = basis ? costOfQty(STANDARD_UNITS[product.unit].factor, basis) : null
      costs.set(product.id, {
        kind: 'resale',
        yieldQty: '1',
        lineCount: 1,
        basis: basis?.basis ?? null,
        cost: {
          total,
          ...unitCostOf(total),
          unpricedLines: total === null ? 1 : 0,
          complete: total !== null,
        },
      })
      continue
    }
    const own = linesByProduct.get(product.id) ?? []
    const yieldQty = yields.get(product.id) ?? '1'
    const rolled = rollUpRecipe(
      own.map((line) => ({
        baseQty: line.base_qty,
        basis: bases.get(line.material_id)?.basis ?? null,
      })),
      yieldQty,
    )
    costs.set(product.id, {
      kind: 'recipe',
      yieldQty,
      lineCount: own.length,
      basis: null,
      cost: {
        total: rolled.total,
        perUnit: rolled.perUnit,
        tooLarge: rolled.tooLarge,
        unpricedLines: rolled.unpriced,
        complete: rolled.complete,
      },
    })
  }
  return costs
}

/**
 * `product.costs`: what the materials of one unit of each product cost today (materialCostsOf), and
 * the owner's minutes for one unit (the product form of a business without a team, D-119; null with
 * a team: kept, not counted). NOT_FOUND unless every id is a product or service of this business.
 */
export function productCosts(ctx: BusinessCtx, input: CostsInput): Promise<ProductCostsDto> {
  const businessId = ctx.businessId
  const hasTeam = ctx.access.capabilities.has_team
  return ctx.tx(async (tx) => {
    const products = await tx
      .select({
        id: productsServices.id,
        unit: productsServices.unit,
        resaleMaterialId: productsServices.resaleMaterialId,
        ownerMinutes: sql<string | null>`trim_scale(${productsServices.ownerMinutes})::text`,
      })
      .from(productsServices)
      .where(
        and(
          eq(productsServices.businessId, businessId),
          inArray(productsServices.id, input.ids),
          isNull(productsServices.deletedAt),
        ),
      )
    if (products.length !== input.ids.length) throw new AppError('not_found')
    const costs = await materialCostsOf(tx, businessId, products)
    const byId = new Map(products.map((p) => [p.id, p] as const))
    const items = input.ids.map((id): ProductCostDto => {
      const product = byId.get(id)!
      const cost = costs.get(id)!
      return {
        productId: id,
        kind: cost.kind,
        unit: product.unit,
        yieldQty: cost.yieldQty,
        lineCount: cost.lineCount,
        basis: cost.basis,
        cost: cost.cost,
        ownerMinutes: hasTeam ? null : product.ownerMinutes,
      }
    })
    return { data: { items }, meta: { redacted: [] } }
  })
}
