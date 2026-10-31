import { costOfQty, type CostBasis } from '../costing/recipe'
import { exactProduct, plain, roundHalfUp, toDec } from '../numbers/decimal'
import {
  checkDecimal,
  COST_SCALE,
  QUANTITY_SCALE,
  type CostAmount,
  type Percent,
  type Quantity,
} from '../numbers/kinds'
import { MAX_PREPARED_DEPTH } from './keys'

// Preparation loss, production and prepared items (M4 Step 1; the owner's answers Q14 and Q15 of
// D-339).
// - Preparation loss: a recipe line may say what share of the material is lost before it goes in
//   (peeling, trimming, offcuts). The line then uses its quantity ÷ (1 − loss): 200 g with 20% lost
//   uses 250 g, in expected usage and in the product's cost. One division, rounded once to 6 decimals.
// - Production ("What did you make?"): making `qty` units of an item made in batches uses, of each
//   material of its recipe, qty × the line's base quantity ÷ what the recipe makes, rounded once to 6
//   decimals (as a sale does, D-178). The items made come into stock at exactly what their materials
//   cost when they went out: the sum of those costs, unrounded. A material without a price yet adds
//   nothing, and the value says it is incomplete.
// - Prepared items (a syrup, a dough, a sauce): an item made in batches has a linked stock item, used
//   in other recipes like a material. Until it is counted (Q2), its cost is its own recipe's: the
//   lines' costs at their averages over the base quantity the recipe makes, worked out on read. Items
//   may nest up to MAX_PREPARED_DEPTH levels; a loop, or deeper nesting, leaves them without a price
//   and is reported (the API refuses saving such a recipe).

/**
 * What a recipe line uses once its preparation loss is counted: `baseQty` ÷ (1 − `lossPercent` ÷
 * 100), rounded once to 6 decimals. No loss (null or 0) gives the quantity as it is. Throws
 * RangeError for a loss below 0 or of 100 or more.
 */
export function withPreparationLoss(baseQty: string, lossPercent: Percent | null): Quantity {
  const qty = toDec(baseQty)
  if (qty.lt(0)) throw new RangeError(`A quantity must not be negative: "${baseQty}"`)
  if (lossPercent === null || toDec(lossPercent).isZero()) return plain(qty) as Quantity
  const loss = toDec(lossPercent)
  if (loss.lt(0) || !loss.lt(100)) {
    throw new RangeError(`A preparation loss is from 0 to under 100%: "${lossPercent}"`)
  }
  return plain(
    roundHalfUp(
      exactProduct([qty, toDec('100')]).dividedBy(toDec('100').minus(loss)),
      QUANTITY_SCALE,
    ),
  ) as Quantity
}

/** An item's recipe as production reads it: what it makes and each line's base quantity. */
export interface BatchRecipe {
  /** What the recipe makes, in the item's own unit (more than zero). */
  readonly yieldQty: string
  /** Each line: its material and the base quantity the whole recipe uses (loss included). */
  readonly lines: readonly { readonly materialId: string; readonly baseQty: string }[]
}

/** What making `qty` units uses of each material: qty × line ÷ yield, rounded once to 6 decimals. */
export function productionUsage(
  qty: Quantity,
  recipe: BatchRecipe,
): { readonly materialId: string; readonly baseQty: Quantity }[] {
  const made = toDec(qty)
  if (checkDecimal(qty, 'quantity') !== null || !made.gt(0)) {
    throw new RangeError(`Not a quantity made: "${qty}"`)
  }
  const yieldQty = toDec(recipe.yieldQty)
  if (!yieldQty.gt(0)) throw new RangeError(`A yield must be more than zero: "${recipe.yieldQty}"`)
  return recipe.lines.map((line) => {
    const base = toDec(line.baseQty)
    if (base.lt(0)) throw new RangeError(`A quantity must not be negative: "${line.baseQty}"`)
    return {
      materialId: line.materialId,
      baseQty: plain(
        roundHalfUp(exactProduct([made, base]).dividedBy(yieldQty), QUANTITY_SCALE),
      ) as Quantity,
    }
  })
}

/** What the items made are worth: Σ their materials' costs (null: no price yet), and whether all had one. */
export function madeValue(costs: readonly (CostAmount | null)[]): {
  readonly value: CostAmount
  readonly complete: boolean
} {
  let value = toDec('0')
  for (const cost of costs) if (cost !== null) value = value.plus(toDec(cost))
  return { value: plain(value) as CostAmount, complete: costs.every((cost) => cost !== null) }
}

/** A prepared item that is not counted yet: its stock item, what its recipe makes and its lines. */
export interface PreparedItem {
  /** The stock item other recipes name. */
  readonly materialId: string
  /** The base quantity of the stock item the whole recipe makes (more than zero). */
  readonly yieldBaseQty: string
  /** Each line: its material and the base quantity the whole recipe uses (loss included). */
  readonly lines: readonly { readonly materialId: string; readonly baseQty: string }[]
}

export interface PreparedProblem {
  readonly materialId: string
  readonly problem: 'loop' | 'too_deep'
}

/**
 * The average of each prepared item from its recipe: { value: Σ its lines' costs, qty: what it
 * makes }, so costOfQty(x, basis) = x × value ÷ qty, divided once. A line's material takes its basis
 * from `bases` (purchases, or the stock average of a counted item), or, when it is itself a prepared
 * item, from that item's recipe first. An item with a line that has no price yet has none (null,
 * never 0). Items in a loop, or nested deeper than MAX_PREPARED_DEPTH, get null and are reported.
 */
export function preparedBases(
  items: readonly PreparedItem[],
  bases: ReadonlyMap<string, CostBasis | null>,
): {
  readonly bases: ReadonlyMap<string, CostBasis | null>
  readonly problems: readonly PreparedProblem[]
} {
  const byId = new Map(items.map((item) => [item.materialId, item]))
  // Each item's basis and its height: how many prepared items deep its recipe goes (itself is 1).
  const resolved = new Map<string, { basis: CostBasis | null; height: number }>()
  const problems = new Map<string, PreparedProblem['problem']>()
  const visiting: string[] = []

  const resolve = (id: string): { basis: CostBasis | null; height: number } => {
    const item = byId.get(id)
    if (!item) return { basis: bases.get(id) ?? null, height: 0 }
    const known = resolved.get(id)
    if (known) return known
    const at = visiting.indexOf(id)
    if (at >= 0) {
      for (const looped of visiting.slice(at)) problems.set(looped, 'loop')
      return { basis: null, height: 0 }
    }
    if (!toDec(item.yieldBaseQty).gt(0)) {
      throw new RangeError(`A prepared item makes more than zero: "${item.yieldBaseQty}"`)
    }
    visiting.push(id)
    let height = 1
    let total = toDec('0')
    let priced = item.lines.length > 0
    for (const line of item.lines) {
      const below = resolve(line.materialId)
      height = Math.max(height, below.height + 1)
      const cost = below.basis === null ? null : costOfQty(line.baseQty, below.basis)
      if (cost === null) priced = false
      else total = total.plus(toDec(cost))
    }
    visiting.pop()
    if (height > MAX_PREPARED_DEPTH && !problems.has(id)) problems.set(id, 'too_deep')
    const basis =
      priced && !problems.has(id)
        ? { value: plain(roundHalfUp(total, COST_SCALE)), qty: item.yieldBaseQty }
        : null
    const own = { basis, height }
    resolved.set(id, own)
    return own
  }

  for (const item of items) resolve(item.materialId)
  const out = new Map<string, CostBasis | null>()
  // An item resolved before a loop below it was found keeps no price either.
  for (const [id, { basis }] of resolved) out.set(id, problems.has(id) ? null : basis)
  return {
    bases: out,
    problems: [...problems].map(([materialId, problem]) => ({ materialId, problem })),
  }
}
