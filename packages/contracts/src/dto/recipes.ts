import { checkDecimal, compareDecimal } from '@bizcost/domain'
import { z } from 'zod'
import { withMeta } from '../envelope'
import { zBusinessDate, zDecimal, zUuid } from '../primitives'
import { PRODUCT_COSTS_MAX, RECIPE_LINES_MAX } from '../recipes'
import { sensitive } from '../sensitivity'
import { dimensionDto, standardUnitDto } from './catalog'
import { averageBasisDto } from './purchases'

// Recipes and product costs (ROADMAP.md M2 Step 4; docs/DATA_MODEL.md §6; D-115, D-117, D-146–D-150).
// One structure for a recipe, a bill of materials and "what you use" (the screens word it by the
// business's terminology profile). A recipe is what it takes to make `yieldQty` units of a product or
// service (its unit; 1 by default, a cake that makes 12 slices, D-178): materials and packaging, each
// in any unit or pack of the material, converted to its base unit. One unit sold costs the total ÷
// the yield.
// Material cost comes only from purchases: each line costs its base quantity × the material's average
// today (the D-115 basis: the 90-day purchase average, else the last purchase), computed on read,
// never rounded (12 decimals; screens round). A material never bought has no price ("no price yet",
// never 0) and the total is marked incomplete.
//
// Sensitive: every cost is `cost` (redacted without data.cost.view, which shows only with
// data.supplier_price.view, D-144); outputs are withMeta() envelopes.

/** A quantity: more than zero, numeric(24,6). */
const quantityInput = zDecimal.refine(
  (value) => checkDecimal(value, 'quantity') === null && compareDecimal(value, '0') > 0,
  { message: 'more than zero' },
)

/**
 * A line: how much of a material the recipe uses (for its yield), `qty` in a standard unit (`unit`:
 * of the material's dimension, or of another one through its cross factor) or in one of its packs
 * (`packId`); exactly one of the two. `id` is a client UUIDv7: lines are matched by id on every save.
 */
export const recipeLineInput = z
  .object({
    id: zUuid,
    materialId: zUuid,
    qty: quantityInput,
    unit: standardUnitDto.nullish(),
    packId: zUuid.nullish(),
  })
  .refine((line) => (line.unit == null) !== (line.packId == null), {
    message: 'exactly one of unit and packId',
  })
export type RecipeLineInput = z.input<typeof recipeLineInput>

/** `recipe.get`: the recipe of a product or service (not one bought ready to sell). */
export const recipeGetInput = z.object({ productId: zUuid })
export type RecipeGetInput = z.input<typeof recipeGetInput>

/**
 * `recipe.save`: the whole recipe, `version` as read (0 while it has none; CONFLICT when it changed
 * since). Lines not sent are taken out; one line per material.
 */
export const saveRecipeInput = z.object({
  productId: zUuid,
  version: z.int().min(0),
  /**
   * How many of the product's unit the recipe makes ("This recipe makes: 12"): more than zero,
   * numeric(24,6). Omitted: the recipe keeps its own (1 for a new recipe).
   */
  yieldQty: quantityInput.optional(),
  lines: z
    .array(recipeLineInput)
    .max(RECIPE_LINES_MAX)
    .refine((lines) => new Set(lines.map((l) => l.id)).size === lines.length, {
      message: 'duplicate line id',
    })
    .refine((lines) => new Set(lines.map((l) => l.materialId)).size === lines.length, {
      message: 'a material twice',
    }),
})
export type SaveRecipeInput = z.input<typeof saveRecipeInput>

/** What a line's material costs today and what the line costs (null: never bought). */
export const recipeLineCostDto = z.object({
  /** Which average (D-115): the last 90 days of purchases, or the last purchase. */
  basis: averageBasisDto,
  /** The material's average per the unit it is counted in, and per base unit (12 decimals). */
  perUnit: sensitive(zDecimal, 'cost'),
  perBaseUnit: sensitive(zDecimal, 'cost'),
  /** The line: base quantity × average, one division, 12 decimals (screens round). */
  lineCost: sensitive(zDecimal, 'cost'),
})
export type RecipeLineCostDto = z.infer<typeof recipeLineCostDto>

export const recipeLineDto = z.object({
  id: zUuid,
  materialId: zUuid,
  /** The material as it is now. */
  materialName: z.string(),
  /** The unit the material is counted in (perUnit is per one of it). */
  materialUnit: standardUnitDto,
  dimension: dimensionDto,
  materialArchived: z.boolean(),
  /** As typed: in `unit` or in the pack `packId` (named `packName`). */
  qty: zDecimal,
  unit: standardUnitDto.nullable(),
  packId: zUuid.nullable(),
  packName: z.string().nullable(),
  /** The same in the material's base unit (g, ml, piece, mm, cm², s). */
  baseQty: zDecimal,
  /** Null: the material was never bought ("no price yet", never 0). */
  cost: recipeLineCostDto.nullable(),
})
export type RecipeLineDto = z.infer<typeof recipeLineDto>

/** What the materials of a recipe cost, and one unit sold. */
export const materialsCostDto = z.object({
  /**
   * Σ the lines that have a price (the whole recipe, for its yield), 12 decimals; null when none has
   * one (or there are no lines).
   */
  total: sensitive(zDecimal.nullable(), 'cost'),
  /**
   * One unit sold: total ÷ the recipe's yield, divided once, 12 decimals (the total itself for a
   * yield of 1 and for an item bought ready to sell); null with the total, and when it is too large.
   */
  perUnit: sensitive(zDecimal.nullable(), 'cost'),
  /**
   * One unit's cost does not fit a cost amount (numeric(28,12): absurd quantities or prices, or a
   * tiny yield), so perUnit is null ("too large to work out"; D-178, D-184). `cost`: it tells how
   * large the cost is.
   */
  tooLarge: sensitive(z.boolean(), 'cost'),
  /** Lines whose material has no price yet. */
  unpricedLines: z.int().min(0),
  /** True when there are lines and every one has a price. */
  complete: z.boolean(),
})
export type MaterialsCostDto = z.infer<typeof materialsCostDto>

export const recipeDto = z.object({
  productId: zUuid,
  /** The product's unit: the recipe makes `yieldQty` of it. */
  productUnit: standardUnitDto,
  /** How many of the product's unit the recipe makes (1: its lines are what one unit uses). */
  yieldQty: zDecimal,
  /** The recipe's version (0: none saved yet); recipe.save names it. */
  version: z.int().min(0),
  /** In the order they were saved. */
  lines: z.array(recipeLineDto),
  cost: materialsCostDto,
  /** The days the 90-day average covers (to: today in the business's time zone). */
  averageFrom: zBusinessDate,
  averageTo: zBusinessDate,
})
export type RecipeDto = z.infer<typeof recipeDto>

/** `recipe.get` / `recipe.save` (sensitive fields may be removed; meta.redacted names them). */
export const recipeResultDto = withMeta(recipeDto)
export type RecipeResultDto = z.infer<typeof recipeResultDto>

/** `product.costs`: the products of a page (unique ids). */
export const productCostsInput = z.object({
  ids: z
    .array(zUuid)
    .min(1)
    .max(PRODUCT_COSTS_MAX)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'duplicate id' }),
})
export type ProductCostsInput = z.input<typeof productCostsInput>

/** How a product's material cost is made. */
export const productCostKindDto = z.enum(['recipe', 'resale'])

export const productCostDto = z.object({
  productId: zUuid,
  /** `recipe`: what its recipe uses; `resale`: bought ready to sell, its material's average. */
  kind: productCostKindDto,
  /** `cost.perUnit` is for one of this unit (the product's). */
  unit: standardUnitDto,
  /** How many of it the recipe makes (1 without a recipe, and for an item bought ready to sell). */
  yieldQty: zDecimal,
  /** Recipe lines (0: no recipe yet); 1 for an item bought ready to sell. */
  lineCount: z.int().min(0),
  /** For an item bought ready to sell: which average its cost is (null: never bought). */
  basis: averageBasisDto.nullable(),
  cost: materialsCostDto,
  /**
   * The owner's minutes for one unit (D-119; M2 Step 6), for the product form of a business without
   * a team; null: none, or a business with a team (kept, not counted).
   */
  ownerMinutes: sensitive(zDecimal.nullable(), 'cost'),
})
export type ProductCostDto = z.infer<typeof productCostDto>

export const productCostsDto = withMeta(z.object({ items: z.array(productCostDto) }))
export type ProductCostsDto = z.infer<typeof productCostsDto>
