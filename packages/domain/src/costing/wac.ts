import type Decimal from 'decimal.js'
import { exactProduct, max, min, plain, roundHalfUp, toDec } from '../numbers/decimal'
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
// - supplier return (D-120 rule 2): takes goods of one receipt out at the price paid for them: what
//   the receipt still carries (its value less earlier returns and credits) × returned ÷ what is left
//   of it; the last return of a receipt takes exactly what is left. The average moves back:
//   (value − returned value) ÷ (quantity − returned quantity), never below zero. When that leaves
//   zero or less on hand (goods already used), the average stays and the rest is the adjustment. A
//   return of all that is left of a receipt with nothing else posted for the material since (other
//   than that receipt's own returns and credits) restores the state from before the receipt exactly,
//   at any stock level ("a full return right after its purchase", D-120). So does a return that
//   leaves every receipt of a run fully returned, the run being the movements since the last one that
//   was neither a receipt nor a return or credit of a receipt of the run (an issue, or a return or
//   credit of an older receipt): the state is the one from before the run. A purchase with two lines
//   of the material, or two purchases with nothing else in between, all sent back: as if never bought
//   (D-208);
// - credit note (D-120 rule 3): lowers the value of the credited goods still on hand. The receipt's
//   goods on hand are tracked as the usage takes every unit on hand in proportion (each issue keeps
//   1 − used ÷ on hand before of every receipt's goods, at least 0), and its own returns take its
//   goods out; the share still on hand is s = those goods ÷ (bought − returned). The stock value falls
//   by credit × s (never below zero), the average becomes value ÷ quantity, and the rest is the
//   adjustment (negative: usage was charged too much). In M2 nothing uses stock, so s = 1;
// - reversal of a receipt, return or credit (D-036, D-109, D-120): the state becomes exactly what it
//   would be had it never been posted, i.e. the ledger replayed without it (and without anything
//   reversed earlier). Costs already charged in between are never changed: what they were charged
//   too much or too little is the reversal's `adjustment`. So a reversal right after its movement
//   restores the previous state, at any stock level. A receipt is reversed only after its returns and
//   credits are, and a return or credit only while no later return of its receipt stands (that
//   return's value came from what the goods carried after it, D-142).
// Values keep 12 decimals (numeric(28,12)), rounded half away from zero; never to the currency.
// Conservation is exact: value = start + Σ in − Σ out − Σ adjustments. Inputs are checked against
// their columns at run time (a RangeError, never a silent rounding by Postgres).
//
// Receipts and issues update the state directly (the cost row); returns, credits and reversals
// replay the material's ledger. A replay never starts over: a reversal takes the book back to just
// before its target (each movement keeps what undoes it) and applies the movements after it again.
// So a ledger costs about what its movements do, plus, for each reversal, the movements still
// standing after its target: next to nothing for a correction posted soon after its purchase, and
// about L movements for one posted L movements later (D-208; wac.scale-adversary.test.ts). Negative
// stock follows the costing-policy proposal
// (DECISIONS.md P-001, D-109, D-114): a different owner answer changes only this file and its tests.

const ZERO = toDec('0')
const ONE = toDec('1')

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

/** One stock movement of a material, in posting order. Ids are unique across the ledger. */
export type WacMovement =
  | ({ readonly type: 'receipt'; readonly id: string } & WacReceipt)
  | { readonly type: 'issue'; readonly qty: Quantity }
  /**
   * Goods of `receiptId` sent back. `value` is what the ledger stored when it was posted; without
   * it, the engine works it out (D-120 rule 2) and reports it as the step's `valueOut`.
   */
  | {
      readonly type: 'return'
      readonly id: string
      readonly receiptId: string
      readonly qty: Quantity
      readonly value?: Money | CostAmount
    }
  /**
   * A credit note on `receiptId`'s goods: `amount` is what it takes off their cost (the credit with
   * its VAT when VAT is part of the cost). At most what the receipt still carries.
   */
  | {
      readonly type: 'credit'
      readonly id: string
      readonly receiptId: string
      readonly amount: Money | CostAmount
    }
  | { readonly type: 'receipt_reversal'; readonly receiptId: string }
  | { readonly type: 'return_reversal'; readonly returnId: string }
  | { readonly type: 'credit_reversal'; readonly creditId: string }

/** What one movement did to the value: value after = value before + in − out − adjustment. */
export interface WacStep {
  readonly state: WacState
  readonly valueIn: CostAmount
  readonly valueOut: CostAmount
  readonly adjustment: CostAmount
}

/** Where a receipt stands after the ledger: what is left of it and what its goods still carry. */
export interface WacReceiptStanding {
  /** Base quantity received. */
  readonly qty: Quantity
  /** Its value (what was paid). */
  readonly value: CostAmount
  /** Base quantity returned (returns that still stand). */
  readonly returnedQty: Quantity
  /** Value taken out by those returns. */
  readonly returnedValue: CostAmount
  /** Σ credit amounts that still stand. */
  readonly credited: CostAmount
  /** What its goods still carry: value − returned value − credited. */
  readonly remainingValue: CostAmount
}

export interface WacReplay {
  readonly state: WacState
  readonly steps: WacStep[]
  /** Every receipt that still stands (not reversed), by id. */
  readonly receipts: ReadonlyMap<string, WacReceiptStanding>
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
 * receipt is not in the ledger, is already reversed, or still has returns or credits, so a ledger
 * that starts from a saved state must start before every receipt it reverses.
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
 * what each movement did. Ids of receipts, returns and credits are unique; a return or credit names a
 * receipt earlier in `movements` that still stands, and a reversal names a receipt, return or credit
 * earlier in `movements` that is not reversed yet (a receipt only once its returns and credits are; a
 * return or credit only while no later return of its receipt stands). Throws RangeError otherwise,
 * and when a return or credit is more than what is left of its receipt.
 */
export function replayWac(
  movements: readonly WacMovement[],
  initial: WacState = EMPTY_WAC_STATE,
): WacReplay {
  const book = new Book(initial)
  // The movements that still stand, as applied (a return with the value it was given), and what
  // undoes each of them (the same index).
  const standing: Applied[] = []
  const undos: Undo[] = []
  const kinds = new Map<string, 'receipt' | 'return' | 'credit'>()
  const reversed = new Set<string>()
  const steps: WacStep[] = []

  for (const movement of movements) {
    if (movement.type === 'receipt' || movement.type === 'return' || movement.type === 'credit') {
      const id = movement.id
      if (kinds.has(id)) throw new RangeError(`Duplicate movement "${id}"`)
      kinds.set(id, movement.type)
      const { step, applied, undo } = book.apply(movement)
      standing.push(applied)
      undos.push(undo)
      steps.push(step)
      continue
    }
    if (movement.type === 'issue') {
      const { step, applied, undo } = book.apply(movement)
      standing.push(applied)
      undos.push(undo)
      steps.push(step)
      continue
    }

    const [kind, targetId] =
      movement.type === 'receipt_reversal'
        ? (['receipt', movement.receiptId] as const)
        : movement.type === 'return_reversal'
          ? (['return', movement.returnId] as const)
          : (['credit', movement.creditId] as const)
    if (kinds.get(targetId) !== kind) {
      const what = kind === 'receipt' ? 'Receipt' : kind === 'return' ? 'Return' : 'Credit'
      throw new RangeError(`${what} "${targetId}" is not in this ledger`)
    }
    if (reversed.has(targetId)) throw new RangeError(`"${targetId}" is already reversed`)
    if (kind === 'receipt' && book.hasOpenAdjustments(targetId)) {
      throw new RangeError(`Receipt "${targetId}" still has returns or credits: reverse them first`)
    }
    // Searched from the end: a reversal is mostly of something posted shortly before.
    let index = standing.length - 1
    while (index >= 0) {
      const m = standing[index]!.movement
      if (m.type !== 'issue' && m.id === targetId) break
      index -= 1
    }
    const target = standing[index]!
    // A later return of the same receipt was valued by what its goods carried after this one; it
    // would keep that value once this one is gone. So it is reversed first (D-142).
    if (target.movement.type === 'return' || target.movement.type === 'credit') {
      const { receiptId } = target.movement
      const later = standing
        .slice(index + 1)
        .some((a) => a.movement.type === 'return' && a.movement.receiptId === receiptId)
      if (later) {
        throw new RangeError(`"${targetId}" has a later return of its receipt: reverse that first`)
      }
    }
    reversed.add(targetId)
    const before = book.state
    // Back to just before the target (each movement undone, the last first), then the movements after
    // it again, without it: the ledger replayed without the target.
    for (let i = standing.length - 1; i >= index; i -= 1) undos[i]!()
    standing.splice(index, 1)
    undos.length = index
    for (let i = index; i < standing.length; i += 1) {
      undos.push(book.apply(standing[i]!.movement).undo)
    }
    const after = book.state
    // The target's own effect, taken back: a receipt's value goes out, a return's or credit's in.
    const valueIn = kind === 'receipt' ? ZERO : toDec(target.value)
    const valueOut = kind === 'receipt' ? toDec(target.value) : ZERO
    steps.push({
      state: after,
      valueIn: amount(valueIn),
      valueOut: amount(valueOut),
      adjustment: amount(
        toDec(before.value).plus(valueIn).minus(valueOut).minus(toDec(after.value)),
      ),
    })
  }
  return { state: book.state, steps, receipts: book.standings() }
}

/** A movement as the book applied it (a return with its value), and the value it moved. */
interface Applied {
  readonly movement: Exclude<
    WacMovement,
    { type: 'receipt_reversal' } | { type: 'return_reversal' } | { type: 'credit_reversal' }
  >
  /** Receipt: its value; return: the value taken out; credit: its amount; issue: its cost. */
  readonly value: string
}

/** Takes the book back to just before the movement it was made for (the book being right after it). */
type Undo = () => void

/** What the book knows of a receipt that still stands. */
interface Track {
  readonly qty: Decimal
  readonly value: Decimal
  returnedQty: Decimal
  returnedValue: Decimal
  credited: Decimal
  /** Its goods still on hand (usage takes every receipt's goods in proportion). */
  onHand: Decimal
  /** The state before the receipt. */
  readonly before: WacState
  /**
   * The book's movement count as of the last movement that left it untouched: nothing but its own
   * returns and credits was posted for the material since it while this equals the count.
   */
  mark: number
  /** The run it came in (see Book.run). */
  readonly run: number
  /** Its returns and credits that still stand. */
  readonly open: Set<string>
}

/** The scalars of the book, as saved by every movement's undo. */
interface Scalars {
  readonly state: WacState
  readonly count: number
  readonly run: number
  readonly runStart: WacState
  readonly runOpen: number
}

/**
 * One material's cost state and its receipts, movement by movement (no reversals: replayWac undoes
 * movements to reverse one). Every apply returns what undoes it exactly.
 */
class Book {
  state: WacState
  private readonly tracks = new Map<string, Track>()
  /** Movements applied. */
  private count = 0
  /**
   * The run: the movements since the last one that was neither a receipt nor a return or credit of a
   * receipt of the run. `runStart` is the state before it, `runOpen` its receipts not fully returned.
   */
  private run = 0
  private runStart: WacState
  private runOpen = 0

  constructor(initial: WacState) {
    this.state = initial
    this.runStart = initial
  }

  hasOpenAdjustments(receiptId: string): boolean {
    return (this.tracks.get(receiptId)?.open.size ?? 0) > 0
  }

  standings(): ReadonlyMap<string, WacReceiptStanding> {
    const out = new Map<string, WacReceiptStanding>()
    for (const [id, t] of this.tracks) {
      out.set(id, {
        qty: plain(t.qty) as Quantity,
        value: amount(t.value),
        returnedQty: plain(t.returnedQty) as Quantity,
        returnedValue: amount(t.returnedValue),
        credited: amount(t.credited),
        remainingValue: amount(t.value.minus(t.returnedValue).minus(t.credited)),
      })
    }
    return out
  }

  apply(movement: Applied['movement']): { step: WacStep; applied: Applied; undo: Undo } {
    switch (movement.type) {
      case 'receipt':
        return this.receive(movement)
      case 'issue':
        return this.issue(movement)
      case 'return':
        return this.sendBack(movement)
      case 'credit':
        return this.credit(movement)
    }
  }

  private scalars(): Scalars {
    return {
      state: this.state,
      count: this.count,
      run: this.run,
      runStart: this.runStart,
      runOpen: this.runOpen,
    }
  }

  private restore(saved: Scalars) {
    this.state = saved.state
    this.count = saved.count
    this.run = saved.run
    this.runStart = saved.runStart
    this.runOpen = saved.runOpen
  }

  private untouched(t: Track): boolean {
    return t.mark === this.count
  }

  /** A movement that is not part of the run: a new run starts after it. */
  private newRun(after: WacState) {
    this.run += 1
    this.runStart = after
    this.runOpen = 0
  }

  private track(receiptId: string): Track {
    const t = this.tracks.get(receiptId)
    if (!t) throw new RangeError(`Receipt "${receiptId}" is not in this ledger or is reversed`)
    return t
  }

  private receive(movement: Extract<Applied['movement'], { type: 'receipt' }>) {
    const saved = this.scalars()
    const before = this.state
    const r = wacReceive(before, movement)
    const qty0 = toDec(before.qty)
    const q = toDec(movement.qty)
    // Stock was empty or negative: nothing of earlier receipts is on hand, and part of this one may
    // have covered usage already.
    const emptied: [Track, Decimal][] = []
    if (!qty0.gt(0)) {
      for (const t of this.tracks.values()) {
        if (t.onHand.isZero()) continue
        emptied.push([t, t.onHand])
        t.onHand = ZERO
      }
    }
    // Every other receipt is touched by this one (its mark stays behind the count).
    this.count += 1
    this.tracks.set(movement.id, {
      qty: q,
      value: toDec(r.value),
      returnedQty: ZERO,
      returnedValue: ZERO,
      credited: ZERO,
      onHand: qty0.gt(0) ? q : max(ZERO, min(q, toDec(r.state.qty))),
      before,
      mark: this.count,
      run: this.run,
      open: new Set(),
    })
    this.runOpen += 1
    this.state = r.state
    return {
      step: { state: r.state, valueIn: r.value, valueOut: amount(ZERO), adjustment: r.adjustment },
      applied: { movement, value: r.value },
      undo: () => {
        this.tracks.delete(movement.id)
        for (const [t, onHand] of emptied) t.onHand = onHand
        this.restore(saved)
      },
    }
  }

  private issue(movement: Extract<Applied['movement'], { type: 'issue' }>) {
    const saved = this.scalars()
    const before = this.state
    const r = wacIssue(before, movement.qty)
    const qty0 = toDec(before.qty)
    const used = toDec(movement.qty)
    // Every unit on hand is taken in proportion: each receipt keeps 1 − used ÷ on hand of its goods.
    const kept = qty0.gt(0) ? max(ZERO, ONE.minus(used.dividedBy(qty0))) : ZERO
    const taken: [Track, Decimal][] = []
    for (const t of this.tracks.values()) {
      if (t.onHand.isZero()) continue
      taken.push([t, t.onHand])
      t.onHand = t.onHand.times(kept)
    }
    // Every receipt is touched, and the run ends.
    this.count += 1
    this.newRun(r.state)
    this.state = r.state
    return {
      step: { state: r.state, valueIn: amount(ZERO), valueOut: r.cost, adjustment: amount(ZERO) },
      applied: { movement, value: r.cost },
      undo: () => {
        for (const [t, onHand] of taken) t.onHand = onHand
        this.restore(saved)
      },
    }
  }

  private sendBack(movement: Extract<Applied['movement'], { type: 'return' }>) {
    const t = this.track(movement.receiptId)
    const y = positive(movement.qty, 'quantity')
    const left = t.qty.minus(t.returnedQty)
    if (y.gt(left)) {
      throw new RangeError(`Return "${movement.id}" is more than is left of its receipt`)
    }
    const carried = t.value.minus(t.returnedValue).minus(t.credited)
    const all = y.eq(left)
    const v =
      movement.value !== undefined
        ? notNegative(movement.value, 'costAmount')
        : all
          ? carried
          : round(exactProduct([carried, y]).dividedBy(left))

    const saved = this.scalars()
    const was = { returnedQty: t.returnedQty, returnedValue: t.returnedValue, onHand: t.onHand }
    const wasMark = t.mark
    const before = this.state
    const qty0 = toDec(before.qty)
    const value0 = toDec(before.value)
    const untouched = this.untouched(t)
    const inRun = t.run === this.run
    let after: WacState
    if (all && untouched) {
      // A full return with nothing else posted since its receipt: as if it had never come in.
      after = t.before
    } else if (all && inRun && this.runOpen === 1) {
      // The last receipt of the run still on hand goes back whole: as if the run never came in.
      after = this.runStart
    } else {
      const qty1 = qty0.minus(y)
      if (qty1.gt(0)) {
        const value1 = max(ZERO, value0.minus(v))
        after = stateOf(qty1, value1, round(value1.dividedBy(qty1)))
      } else {
        // Nothing (or less than nothing) left on hand: the average stays.
        const avg = before.avgCost === null ? null : toDec(before.avgCost)
        after = {
          qty: plain(qty1) as Quantity,
          value: amount(avg === null ? ZERO : round(qty1.times(avg))),
          avgCost: before.avgCost,
        }
      }
    }
    t.returnedQty = t.returnedQty.plus(y)
    t.returnedValue = t.returnedValue.plus(v)
    t.onHand = max(ZERO, t.onHand.minus(y))
    t.open.add(movement.id)
    // Its own return touches every other receipt, not this one.
    this.count += 1
    if (untouched) t.mark = this.count
    if (!inRun) this.newRun(after)
    else if (all) this.runOpen -= 1
    this.state = after
    return {
      step: {
        state: after,
        valueIn: amount(ZERO),
        valueOut: amount(v),
        adjustment: amount(value0.minus(v).minus(toDec(after.value))),
      },
      applied: { movement: { ...movement, value: amount(v) }, value: plain(v) },
      undo: () => {
        t.returnedQty = was.returnedQty
        t.returnedValue = was.returnedValue
        t.onHand = was.onHand
        t.mark = wasMark
        t.open.delete(movement.id)
        this.restore(saved)
      },
    }
  }

  private credit(movement: Extract<Applied['movement'], { type: 'credit' }>) {
    const t = this.track(movement.receiptId)
    const credit = positive(movement.amount, 'costAmount')
    const carried = t.value.minus(t.returnedValue).minus(t.credited)
    if (credit.gt(carried)) {
      throw new RangeError(`Credit "${movement.id}" is more than its receipt's goods still carry`)
    }
    const left = t.qty.minus(t.returnedQty)
    // The share of the credited goods still on hand (between 0 and 1).
    const share = left.gt(0) ? min(ONE, max(ZERO, t.onHand.dividedBy(left))) : ZERO

    const saved = this.scalars()
    const wasCredited = t.credited
    const wasMark = t.mark
    const before = this.state
    const qty0 = toDec(before.qty)
    const value0 = toDec(before.value)
    const reduce = qty0.gt(0) ? min(round(credit.times(share)), max(ZERO, value0)) : ZERO
    const value1 = value0.minus(reduce)
    const after: WacState = reduce.isZero()
      ? before
      : stateOf(qty0, value1, round(value1.dividedBy(qty0)))
    const untouched = this.untouched(t)
    t.credited = t.credited.plus(credit)
    t.open.add(movement.id)
    // Its own credit touches every other receipt, not this one.
    this.count += 1
    if (untouched) t.mark = this.count
    if (t.run !== this.run) this.newRun(after)
    this.state = after
    return {
      step: {
        state: after,
        valueIn: amount(ZERO),
        valueOut: amount(credit),
        adjustment: amount(value0.minus(credit).minus(value1)),
      },
      applied: { movement, value: plain(credit) },
      undo: () => {
        t.credited = wasCredited
        t.mark = wasMark
        t.open.delete(movement.id)
        this.restore(saved)
      },
    }
  }
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
