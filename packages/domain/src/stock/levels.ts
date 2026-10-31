import { toDec } from '../numbers/decimal'
import type { Quantity } from '../numbers/kinds'

// Where a material stands in a branch (M4 Step 1; the owner's answers Q4 and Q10 of D-339): below
// zero (more went out than the book has: a purchase may be missing, or it needs counting), low (below
// the level the business set for that branch: "Tell me when it's below…"), or fine. At the level
// itself it is not low yet.

export type StockLevelState = 'below_zero' | 'low' | 'ok'

/** The state of `onHand` (base units) against `lowLevel` (null: none set). */
export function stockLevel(onHand: Quantity, lowLevel: Quantity | null): StockLevelState {
  const qty = toDec(onHand)
  if (qty.lt(0)) return 'below_zero'
  if (lowLevel !== null && qty.lt(toDec(lowLevel))) return 'low'
  return 'ok'
}
