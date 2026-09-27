import type Decimal from 'decimal.js'
import { max, min, plain, roundHalfUp, toDec } from '../numbers/decimal'
import {
  checkDecimal,
  COST_SCALE,
  type CostAmount,
  type DecimalKind,
  type Money,
  type Quantity,
  type UnitCost,
} from '../numbers/kinds'

// Weighted-average cost (D-006: ONE average per material per business, not per location) over one
// material's stock movements in posting order. Quantities are in the material's base unit; a
// transfer between locations moves no business-wide quantity, so it is not a movement here.
//
// The state keeps the stock's value, not only its average (as a moving-average price does):
// - receipt: brings exactly what was paid into stock (its `value`, P-001 item 8). At positive stock
//   the average becomes value ÷ quantity. At zero or negative stock the receipt's own cost
//   (value ÷ qty) becomes the average, and the quantity still missing is revalued at it: the
//   difference is the receipt's `adjustment` (positive: past usage cost more than was charged);
// - issue (usage, sale, waste; from Phase 3): costs qty × average and leaves the average alone. The
//   last unit on hand takes exactly the value left, so zero stock always has zero value. Beyond the
//   stock on hand it reports `shortfall` and costs the average (0, `unitCost` null, before any
//   receipt);
// - receipt reversal (a posted purchase corrected, D-036): the state becomes exactly what it would be
//   had the receipt never been posted, i.e. the ledger replayed without it (and without any receipt
//   reversed earlier). Costs already charged in between are never changed: what they were charged
//   too much or too little is the reversal's `adjustment`. So a reversal right after its receipt
//   restores the previous state, at any stock level, and the average is always an average of
//   receipts that still stand.
// Values keep 12 decimals (numeric(28,12)), rounded half away from zero; never to the currency.
// Conservation is exact: value = start + Σ in − Σ out − Σ adjustments. Inputs are checked against
// their columns at run time (a RangeError, never a silent rounding by Postgres).
//
// Receipts and issues update the state directly (the cost row); a reversal replays the material's
// ledger (reversals are rare). Negative stock and the reversal rule follow the costing-policy
// proposal (DECISIONS.md P-001, D-109): a different owner answer changes only this file and its tests.

const ZERO = toDec('0')

export interface WacState {
  /** Stock on hand in base units; negative when more was used than received. */
  readonly qty: Quantity
  /** Value of the stock at cost: 0 at zero stock, never negative at positive stock. */
  readonly value: CostAmount
  /** Weighted-average cost per base unit; null before the first receipt that still stands. */
  readonly avgCost: UnitCost | null
}

/** A material with no movements yet. */
export const EMPTY_WAC_STATE: WacState = {
  qty: '0' as Quantity,
  value: '0' as CostAmount,
  avgCost: null,
}

/** Stock received: a base quantity and exactly what it cost. */
export interface WacReceipt {
  /** More than zero; numeric(24,6). */
  readonly qty: Quantity
  /** What the goods cost in total (the purchase line's cost); not negative (0 for free goods). */
  readonly value: Money | CostAmount
}

export interface WacReceiptResult {
  readonly state: WacState
  /** The receipt's value (what was paid). */
  readonly value: CostAmount
  /** Revaluation of negative stock at this receipt's cost (0 at zero or positive stock). */
  readonly adjustment: CostAmount
}

export interface WacIssueResult {
  readonly state: WacState
  /** Cost of the issued quantity. */
  readonly cost: CostAmount
  /** The average it was costed at; null before any receipt (then `cost` is 0). */
  readonly unitCost: UnitCost | null
  /** The part issued beyond the stock on hand (0 when there was enough). */
  readonly shortfall: Quantity
}

export interface WacReversalResult {
  readonly state: WacState
  /** The reversed receipt's value, taken out. */
  readonly value: CostAmount
  /** What usage since the receipt was charged too little (positive) or too much (negative). */
  readonly adjustment: CostAmount
}

/** One stock movement of a material, in posting order. */
export type WacMovement =
  | ({ readonly type: 'receipt'; readonly id: string } & WacReceipt)
  | { readonly type: 'issue'; readonly qty: Quantity }
  | { readonly type: 'receipt_reversal'; readonly receiptId: string }

/** What one movement did to the value: value after = value before + in − out − adjustment. */
export interface WacStep {
  readonly state: WacState
  readonly valueIn: CostAmount
  readonly valueOut: CostAmount
  readonly adjustment: CostAmount
}

/** Adds received stock; see the rules at the top. */
export function wacReceive(state: WacState, receipt: WacReceipt): WacReceiptResult {
  const q = positive(receipt.qty, 'quantity')
  const paid = notNegative(receipt.value, 'costAmount')
  const qty0 = toDec(state.qty)
  const value0 = toDec(state.value)
  const qty1 = qty0.plus(q)

  // Stock was empty or negative: what is now on hand (or still missing) is valued at this cost.
  if (!qty0.gt(0)) {
    const value1 = round(qty1.times(paid).dividedBy(q))
    return {
      state: stateOf(qty1, value1, round(paid.dividedBy(q))),
      value: amount(paid),
      adjustment: amount(value0.plus(paid).minus(value1)),
    }
  }
  const value1 = value0.plus(paid)
  return {
    state: stateOf(qty1, value1, round(value1.dividedBy(qty1))),
    value: amount(paid),
    adjustment: amount(ZERO),
  }
}

/** Takes stock out at the current average (usage, sale, waste). The average does not change. */
export function wacIssue(state: WacState, qty: Quantity): WacIssueResult {
  const q = positive(qty, 'quantity')
  const qty0 = toDec(state.qty)
  const value0 = toDec(state.value)
  const avg = state.avgCost === null ? ZERO : toDec(state.avgCost)
  const onHand = max(qty0, ZERO)
  const fromStock = min(q, onHand)
  const shortfall = q.minus(fromStock)

  // The last unit on hand takes the value left; otherwise qty × average, never more than the value.
  const stockCost = fromStock.isZero()
    ? ZERO
    : fromStock.eq(onHand)
      ? value0
      : min(round(fromStock.times(avg)), value0)
  const issued = stockCost.plus(round(shortfall.times(avg)))
  return {
    state: { ...state, qty: plain(qty0.minus(q)) as Quantity, value: amount(value0.minus(issued)) },
    cost: amount(issued),
    unitCost: state.avgCost,
    shortfall: plain(shortfall) as Quantity,
  }
}

/**
 * Reverses the receipt `receiptId` of `ledger` (every movement of the material posted so far, from
 * `initial`): the state becomes the ledger replayed without that receipt. Throws RangeError when the
 * receipt is not in the ledger or is already reversed, so a ledger that starts from a saved state
 * must start before every receipt it reverses.
 */
export function wacReverseReceipt(
  ledger: readonly WacMovement[],
  receiptId: string,
  initial: WacState = EMPTY_WAC_STATE,
): WacReversalResult {
  const { steps } = replayWac([...ledger, { type: 'receipt_reversal', receiptId }], initial)
  const last = steps[steps.length - 1]!
  return { state: last.state, value: last.valueOut, adjustment: last.adjustment }
}

/**
 * Replays movements in posting order: rebuilds a material's cost state from its ledger and gives
 * what each movement did. Receipt ids must be unique; a reversal names a receipt earlier in
 * `movements` that is not reversed yet (see wacReverseReceipt).
 */
export function replayWac(
  movements: readonly WacMovement[],
  initial: WacState = EMPTY_WAC_STATE,
): { state: WacState; steps: WacStep[] } {
  const receipts = new Map<string, WacReceipt>()
  const reversed = new Set<string>()
  const steps: WacStep[] = []
  let state = initial
  for (const [index, movement] of movements.entries()) {
    let step: WacStep
    if (movement.type === 'receipt') {
      if (receipts.has(movement.id)) throw new RangeError(`Duplicate receipt "${movement.id}"`)
      receipts.set(movement.id, movement)
      const r = wacReceive(state, movement)
      step = { state: r.state, valueIn: r.value, valueOut: amount(ZERO), adjustment: r.adjustment }
    } else if (movement.type === 'issue') {
      const r = wacIssue(state, movement.qty)
      step = { state: r.state, valueIn: amount(ZERO), valueOut: r.cost, adjustment: amount(ZERO) }
    } else {
      const receipt = receipts.get(movement.receiptId)
      if (!receipt) throw new RangeError(`Receipt "${movement.receiptId}" is not in this ledger`)
      if (reversed.has(movement.receiptId)) {
        throw new RangeError(`Receipt "${movement.receiptId}" is already reversed`)
      }
      reversed.add(movement.receiptId)
      const after = standing(movements.slice(0, index), reversed, initial)
      const out = toDec(receipt.value)
      step = {
        state: after,
        valueIn: amount(ZERO),
        valueOut: amount(out),
        adjustment: amount(toDec(state.value).minus(out).minus(toDec(after.value))),
      }
    }
    steps.push(step)
    state = step.state
  }
  return { state, steps }
}

/** The state from `initial` over the receipts that still stand and every issue. */
function standing(
  movements: readonly WacMovement[],
  reversed: ReadonlySet<string>,
  initial: WacState,
): WacState {
  let state = initial
  for (const movement of movements) {
    if (movement.type === 'receipt' && !reversed.has(movement.id)) {
      state = wacReceive(state, movement).state
    } else if (movement.type === 'issue') {
      state = wacIssue(state, movement.qty).state
    }
  }
  return state
}

function round(value: Decimal): Decimal {
  return roundHalfUp(value, COST_SCALE)
}

function amount(value: Decimal): CostAmount {
  return plain(value) as CostAmount
}

function stateOf(qty: Decimal, value: Decimal, avg: Decimal): WacState {
  return {
    qty: plain(qty) as Quantity,
    value: amount(value),
    avgCost: plain(avg) as UnitCost,
  }
}

/** A value that fits its column (a RangeError otherwise, never a silent rounding by Postgres). */
function checked(value: string, kind: DecimalKind): Decimal {
  const error = checkDecimal(value, kind)
  if (error) throw new RangeError(`Not a valid ${kind} (${error}): "${value}"`)
  return toDec(value)
}

function positive(value: string, kind: DecimalKind): Decimal {
  const decimal = checked(value, kind)
  if (!decimal.gt(0)) throw new RangeError(`The quantity must be more than zero: "${value}"`)
  return decimal
}

function notNegative(value: string, kind: DecimalKind): Decimal {
  const decimal = checked(value, kind)
  if (decimal.lt(0)) throw new RangeError(`A cost must not be negative: "${value}"`)
  return decimal
}
