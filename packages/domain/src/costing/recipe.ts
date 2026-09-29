import { exactProduct, plain, roundHalfUp, toDec } from '../numbers/decimal'
import { checkDecimal, COST_SCALE, type CostAmount } from '../numbers/kinds'

// What a product's materials cost (ROADMAP.md M2 Step 4; D-115): each line of its recipe is a base
// quantity (the line's quantity in the material's base unit, D-108) × the material's average cost
// today. The average is passed as the sums it is made of (Σ value ÷ Σ base quantity of the purchases
// on the D-115 basis), so a line costs an exact product divided once and rounded once, to 12 decimals
// (D-107): 200 ml of milk bought at AED 72 for 12 000 ml costs 200 × 72 ÷ 12 000 = 1.2, never 200 × a
// per-ml average rounded first. Nothing here is rounded to the currency; screens round the total.
// A material never bought has no average: its line has no cost ("no price yet", never 0), and the
// total is the sum of the lines that have one, marked incomplete. An item bought ready to sell (D-117)
// costs its material's average for one unit sold: costOfQty(base units in one unit, basis).
// A recipe makes `yieldQty` units of its product (1 by default; a cake recipe that makes 12 slices,
// D-178): its lines are what the whole recipe uses, and one unit sold costs the total ÷ the yield,
// divided once and rounded once to 12 decimals (costPerUnit), never rounded to the currency. One
// unit's cost that does not fit a cost amount (numeric(28,12): absurd quantities or prices, or a tiny
// yield) is not worked out: null, and the recipe says it is too large (tooLarge).

/** The sums a material's average is made of: Σ value ÷ Σ base quantity (D-115). */
export interface CostBasis {
  /** Σ value of the purchases the average counts (numeric(28,12), zero or more). */
  readonly value: string
  /** Σ base quantity of those purchases (more than zero for an average to exist). */
  readonly qty: string
}

/**
 * `baseQty` × value ÷ qty: an exact product divided once, rounded half away from zero to 12
 * decimals. Null when the basis has no quantity (nothing to divide by). Throws RangeError for a
 * negative quantity or value.
 */
export function costOfQty(baseQty: string, basis: CostBasis): CostAmount | null {
  const qty = toDec(baseQty)
  const value = toDec(basis.value)
  if (qty.lt(0)) throw new RangeError(`A quantity must not be negative: "${baseQty}"`)
  if (value.lt(0)) throw new RangeError(`A cost must not be negative: "${basis.value}"`)
  const divisor = toDec(basis.qty)
  if (!divisor.gt(0)) return null
  return plain(roundHalfUp(exactProduct([qty, value]).dividedBy(divisor), COST_SCALE)) as CostAmount
}

/** One line of a recipe: its base quantity and its material's basis (null: never bought). */
export interface RecipeCostLine {
  readonly baseQty: string
  readonly basis: CostBasis | null
}

export interface RecipeCost {
  /** Each line's cost, in the order given; null for a line with no price yet. */
  readonly lines: readonly (CostAmount | null)[]
  /** Σ the lines that have a cost (exact); null when none has one (an empty recipe included). */
  readonly total: CostAmount | null
  /**
   * What one unit the recipe makes costs: total ÷ yield (costPerUnit); null with the total, and when
   * it does not fit a cost amount (tooLarge).
   */
  readonly perUnit: CostAmount | null
  /** One unit's cost does not fit a cost amount (numeric(28,12)), so perUnit is null. */
  readonly tooLarge: boolean
  /** How many lines have no price yet. */
  readonly unpriced: number
  /** True when the recipe has lines and every one has a cost. */
  readonly complete: boolean
}

/**
 * What one of the `yieldQty` units a recipe makes costs: `total` ÷ `yieldQty`, one division rounded
 * half away from zero to 12 decimals (a yield of 1 gives the total itself). Null when there is no
 * total. Throws RangeError for a yield that is not more than zero.
 */
export function costPerUnit(total: string | null, yieldQty: string): CostAmount | null {
  const divisor = toDec(yieldQty)
  if (!divisor.gt(0)) throw new RangeError(`A yield must be more than zero: "${yieldQty}"`)
  if (total === null) return null
  return plain(roundHalfUp(toDec(total).dividedBy(divisor), COST_SCALE)) as CostAmount
}

/**
 * One unit's cost as a cost amount, or null (with tooLarge) when it does not fit numeric(28,12): what
 * a product's cost per unit may be (D-178). Null in, null out.
 */
export function unitCostOf(perUnit: string | null): {
  perUnit: CostAmount | null
  tooLarge: boolean
} {
  if (perUnit === null) return { perUnit: null, tooLarge: false }
  return checkDecimal(perUnit, 'costAmount') === null
    ? { perUnit: perUnit as CostAmount, tooLarge: false }
    : { perUnit: null, tooLarge: true }
}

/**
 * The cost of a recipe's materials: each line costOfQty, the total their exact sum, and one of the
 * `yieldQty` units it makes (default 1) the total ÷ the yield (unitCostOf: null, tooLarge, when it
 * does not fit a cost amount).
 */
export function rollUpRecipe(lines: readonly RecipeCostLine[], yieldQty = '1'): RecipeCost {
  const costs = lines.map((line) => (line.basis ? costOfQty(line.baseQty, line.basis) : null))
  const priced = costs.filter((cost): cost is CostAmount => cost !== null)
  const total =
    priced.length === 0
      ? null
      : (plain(priced.reduce((sum, cost) => sum.plus(toDec(cost)), toDec('0'))) as CostAmount)
  const unpriced = costs.length - priced.length
  return {
    lines: costs,
    total,
    ...unitCostOf(costPerUnit(total, yieldQty)),
    unpriced,
    complete: costs.length > 0 && unpriced === 0,
  }
}
