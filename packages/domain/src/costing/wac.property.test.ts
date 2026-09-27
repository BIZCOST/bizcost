import type Decimal from 'decimal.js'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { max, min, plain, roundHalfUp, toDec } from '../numbers/decimal'
import { COST_SCALE, type CostAmount, type Quantity } from '../numbers/kinds'
import {
  replayWac,
  wacIssue,
  wacReceive,
  wacReverseReceipt,
  type WacMovement,
  type WacState,
} from './wac'

// Quantities are multiples of 0.001 (so any stock on hand is at least 0.001), receipt values have up
// to 4 decimals (document amounts) and are sometimes 0 (free goods). Rounding to 12 decimals on each
// step can move an average by at most steps × 0.5e-12 / 0.001; TOLERANCE is far above that for these
// sequence lengths.
const TOLERANCE = toDec('0.0000001')
const ZERO = toDec('0')

const qtyArb = fc
  .tuple(fc.integer({ min: 0, max: 1000 }), fc.integer({ min: 0, max: 999 }))
  .filter(([whole, thousandths]) => whole + thousandths > 0)
  .map(([whole, thousandths]) => `${whole}.${String(thousandths).padStart(3, '0')}` as Quantity)
const valueArb = fc.oneof(
  { weight: 1, arbitrary: fc.constant('0' as CostAmount) },
  {
    weight: 6,
    arbitrary: fc
      .tuple(fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 9999 }))
      .map(([whole, frac]) => `${whole}.${String(frac).padStart(4, '0')}` as CostAmount),
  },
)
const receiptArb = fc.record({ qty: qtyArb, value: valueArb })

type Step =
  | { kind: 'receipt'; qty: Quantity; value: CostAmount }
  | { kind: 'issue'; qty: Quantity }
  | { kind: 'reverse'; pick: number }

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: receiptArb.map((r) => ({ kind: 'receipt' as const, ...r })) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('issue' as const), qty: qtyArb }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('reverse' as const), pick: fc.nat() }) },
)

/** Movements from steps: a reversal takes back one earlier receipt that is not yet reversed. */
function toMovements(steps: readonly Step[]): WacMovement[] {
  const open: string[] = []
  const movements: WacMovement[] = []
  steps.forEach((step, i) => {
    if (step.kind === 'receipt') {
      const id = `r${i}`
      open.push(id)
      movements.push({ type: 'receipt', id, qty: step.qty, value: step.value })
    } else if (step.kind === 'issue') {
      movements.push({ type: 'issue', qty: step.qty })
    } else if (open.length > 0) {
      const [receiptId] = open.splice(step.pick % open.length, 1)
      movements.push({ type: 'receipt_reversal', receiptId: receiptId! })
    }
  })
  return movements
}

/** The same ledger without the reversed receipts and without the reversals. */
function standingOnly(movements: readonly WacMovement[]): WacMovement[] {
  const reversed = new Set(
    movements.flatMap((m) => (m.type === 'receipt_reversal' ? [m.receiptId] : [])),
  )
  return movements.filter(
    (m) => m.type === 'issue' || (m.type === 'receipt' && !reversed.has(m.id)),
  )
}

const receiptsOnly = (receipts: readonly { qty: Quantity; value: CostAmount }[]): WacMovement[] =>
  receipts.map((r, i) => ({ type: 'receipt', id: `r${i}`, ...r }))
const movementsArb = fc.array(stepArb, { maxLength: 40 }).map(toMovements)
const within = (value: Decimal, low: Decimal, high: Decimal) =>
  value.gte(low.minus(TOLERANCE)) && value.lte(high.plus(TOLERANCE))
const unitCostOf = (r: { qty: string; value: string }) => toDec(r.value).dividedBy(toDec(r.qty))
const pick = ({ qty, value, avgCost }: WacState) => ({ qty, value, avgCost })

describe('weighted-average cost properties', () => {
  it('conserves value exactly: value = receipts − issues − adjustments', () => {
    fc.assert(
      fc.property(movementsArb, (movements) => {
        const { state, steps } = replayWac(movements)
        const net = steps.reduce(
          (acc, s) =>
            acc.plus(toDec(s.valueIn)).minus(toDec(s.valueOut)).minus(toDec(s.adjustment)),
          ZERO,
        )
        expect(toDec(state.value).eq(net)).toBe(true)
      }),
    )
  })

  it('keeps the value on the side of zero of the stock, next to qty × average', () => {
    fc.assert(
      fc.property(movementsArb, (movements) => {
        for (const { state, valueOut } of replayWac(movements).steps) {
          const qty = toDec(state.qty)
          const value = toDec(state.value)
          if (qty.isZero()) expect(state.value).toBe('0')
          if (qty.gt(0)) expect(value.lt(0)).toBe(false)
          if (qty.lt(0)) expect(value.gt(0)).toBe(false)
          expect(toDec(valueOut).lt(0)).toBe(false)
          const avg = toDec(state.avgCost ?? '0')
          expect(value.minus(qty.times(avg)).abs().lte(TOLERANCE)).toBe(true)
        }
      }),
    )
  })

  it('keeps the average within the costs of the receipts that still stand', () => {
    fc.assert(
      fc.property(movementsArb, (movements) => {
        const standing = new Map<string, Decimal>()
        const { steps } = replayWac(movements)
        steps.forEach(({ state }, i) => {
          const movement = movements[i]!
          if (movement.type === 'receipt') standing.set(movement.id, unitCostOf(movement))
          if (movement.type === 'receipt_reversal') standing.delete(movement.receiptId)
          expect(state.avgCost === null).toBe(standing.size === 0)
          if (state.avgCost === null) return
          const costs = [...standing.values()]
          const low = costs.reduce((a, b) => min(a, b))
          const high = costs.reduce((a, b) => max(a, b))
          expect(within(toDec(state.avgCost), low, high)).toBe(true)
        })
      }),
    )
  })

  it('ignores reversed receipts: the state is a replay of the receipts that still stand', () => {
    fc.assert(
      fc.property(movementsArb, (movements) => {
        expect(replayWac(movements).state).toEqual(replayWac(standingOnly(movements)).state)
      }),
    )
  })

  it('undoes a receipt reversed straight away, at any stock level', () => {
    fc.assert(
      fc.property(movementsArb, receiptArb, (movements, receipt) => {
        const before = replayWac(movements).state
        const withReceipt: WacMovement[] = [
          ...movements,
          { type: 'receipt', id: 'new', ...receipt },
        ]
        const received = replayWac(withReceipt).steps.at(-1)!
        const undone = wacReverseReceipt(withReceipt, 'new')
        expect(undone.state).toEqual(before)
        expect(toDec(undone.value).eq(toDec(receipt.value))).toBe(true)
        expect(toDec(undone.adjustment).eq(toDec(received.adjustment).negated())).toBe(true)
      }),
    )
  })

  it('costs an issue at the average, with the part beyond the stock as shortfall', () => {
    fc.assert(
      fc.property(movementsArb, qtyArb, (movements, qty) => {
        const before = replayWac(movements).state
        const result = wacIssue(before, qty)
        const onHand = max(toDec(before.qty), ZERO)
        expect(toDec(result.shortfall).eq(max(toDec(qty).minus(onHand), ZERO))).toBe(true)
        expect(result.unitCost).toBe(before.avgCost)
        expect(toDec(result.cost).lt(0)).toBe(false)
        const avg = toDec(before.avgCost ?? '0')
        expect(toDec(result.cost).minus(toDec(qty).times(avg)).abs().lte(TOLERANCE)).toBe(true)
      }),
    )
  })

  it('empties the stock at exactly its value, however the usage is split', () => {
    const splitArb = fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 8 })
    fc.assert(
      fc.property(
        fc.array(receiptArb, { minLength: 1, maxLength: 6 }),
        splitArb,
        (receipts, weights) => {
          const stock = replayWac(receiptsOnly(receipts)).state
          const thousandths = BigInt(plain(toDec(stock.qty).times(1000)))
          const total = weights.reduce((a, b) => a + b, 0)
          let left = thousandths
          const parts = weights.map((w, i) => {
            const part = i === weights.length - 1 ? left : (thousandths * BigInt(w)) / BigInt(total)
            left -= part
            return part
          })
          let state = stock
          let cost = ZERO
          for (const part of parts.filter((p) => p > 0n)) {
            const r = wacIssue(state, toDec(part.toString()).dividedBy(1000).toString() as Quantity)
            state = r.state
            cost = cost.plus(toDec(r.cost))
          }
          expect(pick(state)).toEqual({ qty: '0', value: '0', avgCost: stock.avgCost })
          expect(cost.eq(toDec(stock.value))).toBe(true)
        },
      ),
    )
  })

  it("matches the owner's formula after receipts only: WAC = Σ value ÷ Σ quantity", () => {
    fc.assert(
      fc.property(fc.array(receiptArb, { minLength: 1, maxLength: 12 }), (receipts) => {
        const { state } = replayWac(receiptsOnly(receipts))
        const value = receipts.reduce((acc, r) => acc.plus(toDec(r.value)), ZERO)
        const qty = receipts.reduce((acc, r) => acc.plus(toDec(r.qty)), ZERO)
        expect(toDec(state.value).eq(value)).toBe(true)
        expect(toDec(state.qty).eq(qty)).toBe(true)
        expect(toDec(state.avgCost!).eq(roundHalfUp(value.dividedBy(qty), COST_SCALE))).toBe(true)
      }),
    )
  })

  it('makes a receipt at zero or negative stock the new average', () => {
    fc.assert(
      fc.property(movementsArb, receiptArb, (movements, receipt) => {
        const before = replayWac(movements).state
        if (toDec(before.qty).gt(0)) return
        const after = wacReceive(before, receipt).state
        expect(toDec(after.avgCost!).eq(roundHalfUp(unitCostOf(receipt), COST_SCALE))).toBe(true)
      }),
    )
  })
})
