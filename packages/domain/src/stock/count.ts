import { costOfQty, type CostBasis } from '../costing/recipe'
import type { WacOpening } from '../costing/wac'
import { splitDecimals } from '../documents/split'
import { exactProduct, plain, roundHalfUp, toDec } from '../numbers/decimal'
import {
  checkDecimal,
  COST_SCALE,
  type CostAmount,
  type Quantity,
  type UnitCost,
} from '../numbers/kinds'
import { toBase } from '../units/convert'
import type { MaterialUnits, UnitRef } from '../units/materials'
import { COUNT_REASONS, type CountReason } from './keys'

// Stock counts (M4 Step 1; the owner's answers Q2, Q3 and Q6 of D-339).
// - A counted line is typed the way the material is kept, in one unit or pack or several ("3 cartons
//   + 4 bottles"): each part goes to base units (toBase, 6 decimals) and the parts are added.
// - A material's first count (its opening) starts its stock at the counted quantity × that day's
//   90-day purchase average (D-115), so its cost the day after is the cost the day before. The value
//   is the exact product divided once, as a recipe line's cost (D-147): 40 L at 72 for 12 L is 240.
// - A later count's difference is counted − book (a loss below zero). A loss can be split by the
//   reasons given at the review; each part's value is its share of the loss's value, divided once,
//   and what no reason covers (the remainder, exactly) is unexplained usage.

/** One part of a counted line: a quantity in one unit or pack of the material. */
export interface CountedPart {
  readonly qty: Quantity
  readonly unit: UnitRef
}

/**
 * A counted line in base units: each part converted and added. Throws RangeError for no part, a
 * part below zero, or a total a stock quantity cannot hold (numeric(24,6)).
 */
export function countedBaseQty(parts: readonly CountedPart[], units: MaterialUnits): Quantity {
  if (parts.length === 0) throw new RangeError('A counted line needs a quantity')
  let total = toDec('0')
  for (const part of parts) {
    if (checkDecimal(part.qty, 'quantity') !== null || toDec(part.qty).lt(0)) {
      throw new RangeError(`Not a counted quantity: "${part.qty}"`)
    }
    total = total.plus(toDec(toBase(part.qty, part.unit, units)))
  }
  const qty = plain(total)
  if (checkDecimal(qty, 'quantity') !== null) {
    throw new RangeError(`A counted line is more than stock can hold: "${qty}"`)
  }
  return qty as Quantity
}

/**
 * A material's first count as the cost engine takes it (wacOpen): `countedQty` (every branch
 * together) at the average `average` is made of (the D-115 sums as of the count's day; null: no
 * price yet, the stock then has no value until a receipt prices it).
 */
export function openingOf(countedQty: Quantity, average: CostBasis | null): WacOpening {
  if (checkDecimal(countedQty, 'quantity') !== null || toDec(countedQty).lt(0)) {
    throw new RangeError(`Not a counted quantity: "${countedQty}"`)
  }
  const value = average === null ? null : costOfQty(countedQty, average)
  if (average === null || value === null) {
    return { qty: countedQty, value: '0' as CostAmount, avgCost: null }
  }
  const avgCost = plain(
    roundHalfUp(toDec(average.value).dividedBy(toDec(average.qty)), COST_SCALE),
  ) as UnitCost
  return { qty: countedQty, value, avgCost }
}

/** One branch line of a material's first count, as its stock movement stores it (M4 Step 2). */
export interface OpeningRow {
  /** Its share of what the counted stock is worth. */
  readonly value: CostAmount
  /** Its share of the book value the count replaces (all of it on the first line). */
  readonly adjustment: CostAmount
}

/**
 * The rows of a material's first count, one per branch line, in the order given (the API gives the
 * lowest location id first): the opening's `value` (zero or more, at most 12 decimals) split by the
 * counted quantities with the largest remainder at 12 decimals (splitByWeights: the shares add up to
 * it exactly, each within one last decimal of its exact share, equal shares when nothing was counted),
 * and the book value the count replaces (`bookValue`: the cost row's value before it, of any sign)
 * entirely on the first row. So Σ (value − adjustment) = value − bookValue, exactly what wacOpen moves
 * the stock's value by, and Σ value is the value the cost engine reads back (D-340). Throws RangeError
 * for no line, a counted quantity below zero, or a value below zero or with more than 12 decimals.
 */
export function openingRows(
  counted: readonly Quantity[],
  value: CostAmount,
  bookValue: CostAmount,
): OpeningRow[] {
  if (counted.length === 0) throw new RangeError('A first count needs a line')
  const weights = counted.map((qty) => {
    if (checkDecimal(qty, 'quantity') !== null || toDec(qty).lt(0)) {
      throw new RangeError(`Not a counted quantity: "${qty}"`)
    }
    return toDec(qty)
  })
  const book = plain(toDec(bookValue)) as CostAmount
  return splitDecimals(toDec(value), weights, COST_SCALE).map((share, index) => ({
    value: plain(share) as CostAmount,
    adjustment: index === 0 ? book : ('0' as CostAmount),
  }))
}

/** counted − book: the line's difference (below zero: less was there than the book said). */
export function countDifference(counted: Quantity, book: Quantity): Quantity {
  return plain(toDec(counted).minus(toDec(book))) as Quantity
}

/** A part of a loss someone explained at the review. */
export interface ReasonPart {
  readonly reason: CountReason
  /** More than zero; together not more than the loss. */
  readonly qty: Quantity
}

export interface ExplainedPart extends ReasonPart {
  /** Its share of the loss's value: qty × value ÷ loss, divided once (12 decimals). */
  readonly value: CostAmount
}

export interface LossSplit {
  readonly parts: readonly ExplainedPart[]
  /** What no reason covers: the loss less the parts (zero or more). */
  readonly unexplained: { readonly qty: Quantity; readonly value: CostAmount }
}

/**
 * Splits a count's loss (`loss` more than zero, its `value` zero or more, both as positive amounts)
 * by the reasons given. Throws RangeError for an unknown or repeated reason, a part not more than
 * zero, or parts that add up to more than the loss.
 */
export function splitLoss(
  loss: Quantity,
  value: CostAmount,
  parts: readonly ReasonPart[],
): LossSplit {
  const lost = toDec(loss)
  const worth = toDec(value)
  if (!lost.gt(0)) throw new RangeError(`A loss must be more than zero: "${loss}"`)
  if (worth.lt(0)) throw new RangeError(`A loss's value must not be negative: "${value}"`)
  const seen = new Set<string>()
  let explainedQty = toDec('0')
  let explainedValue = toDec('0')
  const out: ExplainedPart[] = []
  for (const part of parts) {
    if (!(COUNT_REASONS as readonly string[]).includes(part.reason)) {
      throw new RangeError(`Not a reason: "${part.reason}"`)
    }
    if (seen.has(part.reason)) throw new RangeError(`A reason is given once: "${part.reason}"`)
    seen.add(part.reason)
    const qty = toDec(part.qty)
    if (checkDecimal(part.qty, 'quantity') !== null || !qty.gt(0)) {
      throw new RangeError(`A reason's quantity must be more than zero: "${part.qty}"`)
    }
    explainedQty = explainedQty.plus(qty)
    if (explainedQty.gt(lost)) throw new RangeError('The reasons add up to more than the loss')
    // Rounded on the running total, so the parts add up to the explained share exactly: never more
    // than the loss's value, and all of it when the reasons cover the whole loss.
    const upTo = roundHalfUp(exactProduct([explainedQty, worth]).dividedBy(lost), COST_SCALE)
    out.push({
      reason: part.reason,
      qty: part.qty,
      value: plain(upTo.minus(explainedValue)) as CostAmount,
    })
    explainedValue = upTo
  }
  return {
    parts: out,
    unexplained: {
      qty: plain(lost.minus(explainedQty)) as Quantity,
      value: plain(worth.minus(explainedValue)) as CostAmount,
    },
  }
}
