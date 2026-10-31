import { dayNumber } from '../costing/cost-share'
import { plain, toDec } from '../numbers/decimal'
import { checkDecimal, type CostAmount, type Quantity } from '../numbers/kinds'

// Entries posted after a count for a day it already covers (M4 Step 1; the owner's answer Q5 of
// D-339). A count is the stock at the end of its day, and it stays the truth for that day: a sale,
// purchase, return, waste or transfer of a branch's material dated on or before a finalized count of
// it, posted after that count, still posts (nothing is refused for stock, Q4), and the count absorbs
// it. The count that absorbs it is the first finalized count of that branch and material dated on or
// after the entry's day: the counts after that one start from it, so they are not touched. The
// absorbing count's difference moves by the opposite quantity, so the stock now stays what that count
// found plus what came after it, whatever the order things were posted in. An entry dated after
// every count needs none. The offset's value keeps the cost engine whole:
// - an issue (a sale, waste, work, production taking its materials) is put back at exactly what it
//   cost (a restock): issue and offset leave the stock's quantity, value and average as they were,
//   the issue's cost stays where it counts (the sale's frozen cost), and the count's unexplained usage
//   shrinks by that cost, so nothing is counted twice;
// - anything else (a purchase, which moves the average by posting order (D-114 rule 2), a supplier
//   return, a transfer, a refund back to stock) is offset as a count difference at the average: what
//   came in leaves as a loss the count now finds, what went out comes back as a gain. Its value
//   follows the average the entry left, never a price from before it.
// This holds because a branch's counts of a material are finalized in day order: a count is dated
// after the last finalized count of each of its lines (the API refuses one dated before; a count
// into the past would otherwise move the stock a later count fixed).

/** A finalized count of one branch and material: its id and the day it counted (YYYY-MM-DD). */
export interface FinalCount {
  readonly id: string
  readonly day: string
}

/**
 * The count that absorbs an entry dated `entryDay`: the earliest of `counts` dated on or after it
 * (of two on one day, the first given); null when every count is before it.
 */
export function absorbingCount(entryDay: string, counts: readonly FinalCount[]): FinalCount | null {
  const day = dayNumber(entryDay)
  let found: FinalCount | null = null
  let foundDay = Number.POSITIVE_INFINITY
  for (const count of counts) {
    const at = dayNumber(count.day)
    if (at >= day && at < foundDay) {
      found = count
      foundDay = at
    }
  }
  return found
}

/** The movement that keeps an absorbing count's stock (see the rules at the top). */
export type LateOffset =
  /** Put back exactly what an issue cost. */
  | { readonly kind: 'restock'; readonly qty: Quantity; readonly value: CostAmount }
  /** A count difference at the average (signed). */
  | { readonly kind: 'count'; readonly qty: Quantity }

/**
 * The offset of a late entry: its signed base quantity (in above zero, out below) the other way.
 * `issueCost` is given only for an issue (what it cost, zero or more): it is put back at exactly
 * that. Throws RangeError for a zero quantity, or a cost given for an entry that brought stock in.
 */
export function lateOffset(entryQty: Quantity, issueCost?: CostAmount): LateOffset {
  if (checkDecimal(entryQty, 'quantity') !== null || toDec(entryQty).isZero()) {
    throw new RangeError(`Not an entry's quantity: "${entryQty}"`)
  }
  const qty = toDec(entryQty).negated()
  if (issueCost === undefined) return { kind: 'count', qty: plain(qty) as Quantity }
  if (!qty.gt(0)) throw new RangeError('Only an issue is put back at its cost')
  if (checkDecimal(issueCost, 'costAmount') !== null || toDec(issueCost).lt(0)) {
    throw new RangeError(`Not an issue's cost: "${issueCost}"`)
  }
  return { kind: 'restock', qty: plain(qty) as Quantity, value: issueCost }
}
