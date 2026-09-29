import { exactProduct, plain, roundHalfUp, toDec } from '../numbers/decimal'
import { COST_SCALE, type CostAmount } from '../numbers/kinds'

// What a product's materials cost (ROADMAP.md M2 Step 4; D-115): each line of its recipe is a base
// quantity (the line's quantity in the material's base unit, D-108) × the material's average cost
// today. The average is passed as the sums it is made of (Σ value ÷ Σ base quantity of the purchases
// on the D-115 basis), so a line costs an exact product divided once and rounded once, to 12 decimals
// (D-107): 200 ml of milk bought at AED 72 for 12 000 ml costs 200 × 72 ÷ 12 000 = 1.2, never 200 × a
// per-ml average rounded first. Nothing here is rounded to the currency; screens round the total.
// A material never bought has no average: its line has no cost ("no price yet", never 0), and the
// total is the sum of the lines that have one, marked incomplete. An item bought ready to sell (D-117)
// costs its material's average for one unit sold: costOfQty(base units in one unit, basis).

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
  /** How many lines have no price yet. */
  readonly unpriced: number
  /** True when the recipe has lines and every one has a cost. */
  readonly complete: boolean
}

/** The cost of a recipe's materials: each line costOfQty, the total their exact sum. */
export function rollUpRecipe(lines: readonly RecipeCostLine[]): RecipeCost {
  const costs = lines.map((line) => (line.basis ? costOfQty(line.baseQty, line.basis) : null))
  const priced = costs.filter((cost): cost is CostAmount => cost !== null)
  const total =
    priced.length === 0
      ? null
      : (plain(priced.reduce((sum, cost) => sum.plus(toDec(cost)), toDec('0'))) as CostAmount)
  const unpriced = costs.length - priced.length
  return { lines: costs, total, unpriced, complete: costs.length > 0 && unpriced === 0 }
}
