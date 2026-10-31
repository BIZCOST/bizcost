import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { roundHalfUp, toDec } from '../numbers/decimal'
import { COST_SCALE, type CostAmount, type Quantity, type UnitCost } from '../numbers/kinds'
import { replayWac, type WacMovement, type WacState } from './wac'

// Properties of the cost engine with stock counts (M4 Step 1; D-339 Q2–Q5), mixed with M2's supplier
// returns and credit notes: conservation, the value rules, a count that never moves the average,
// reversals of any kind as "never posted".

const qtyArb = fc
  .tuple(fc.integer({ min: 0, max: 500 }), fc.integer({ min: 0, max: 999 }))
  .filter(([whole, thousandths]) => whole + thousandths > 0)
  .map(([whole, thousandths]) => `${whole}.${String(thousandths).padStart(3, '0')}`)
const valueArb = fc
  .tuple(fc.integer({ min: 0, max: 50_000 }), fc.integer({ min: 0, max: 9999 }))
  .map(([whole, frac]) => `${whole}.${String(frac).padStart(4, '0')}`)
const avgArb = fc.option(
  fc
    .tuple(fc.integer({ min: 0, max: 200 }), fc.integer({ min: 1, max: 999_999 }))
    .map(([whole, frac]) => `${whole}.${String(frac).padStart(6, '0')}` as UnitCost),
  { nil: null, freq: 4 },
)
const shareArb = fc.integer({ min: 1, max: 100 })

type Step =
  | { kind: 'receipt'; qty: string; value: string }
  | { kind: 'issue'; qty: string }
  | { kind: 'count'; qty: string; loss: boolean }
  | { kind: 'restock'; qty: string; value: string }
  | { kind: 'opening'; qty: string | null; avg: UnitCost | null }
  | { kind: 'return'; pick: number; share: number }
  | { kind: 'credit'; pick: number; share: number }
  | { kind: 'reverse'; pick: number }

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({ kind: fc.constant('receipt' as const), qty: qtyArb, value: valueArb }),
  },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('issue' as const), qty: qtyArb }) },
  {
    weight: 3,
    arbitrary: fc.record({ kind: fc.constant('count' as const), qty: qtyArb, loss: fc.boolean() }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('restock' as const), qty: qtyArb, value: valueArb }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('opening' as const),
      qty: fc.option(qtyArb, { nil: null, freq: 5 }),
      avg: avgArb,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('return' as const), pick: fc.nat(), share: shareArb }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant('credit' as const), pick: fc.nat(), share: shareArb }),
  },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('reverse' as const), pick: fc.nat() }) },
)

type Reversible = 'receipt' | 'issue' | 'count' | 'restock' | 'opening' | 'return' | 'credit'

function openingValue(qty: string, avg: UnitCost | null): CostAmount {
  return (
    avg === null ? '0' : roundHalfUp(toDec(qty).times(toDec(avg)), COST_SCALE).toString()
  ) as CostAmount
}

function reversalOf(kind: Reversible, id: string): WacMovement {
  switch (kind) {
    case 'receipt':
      return { type: 'receipt_reversal', receiptId: id }
    case 'issue':
      return { type: 'issue_reversal', issueId: id }
    case 'count':
      return { type: 'count_reversal', countId: id }
    case 'restock':
      return { type: 'restock_reversal', restockId: id }
    case 'opening':
      return { type: 'opening_reversal', openingId: id }
    case 'return':
      return { type: 'return_reversal', returnId: id }
    case 'credit':
      return { type: 'credit_reversal', creditId: id }
  }
}

function targetOf(m: WacMovement): string | null {
  switch (m.type) {
    case 'receipt_reversal':
      return m.receiptId
    case 'issue_reversal':
      return m.issueId
    case 'count_reversal':
      return m.countId
    case 'restock_reversal':
      return m.restockId
    case 'opening_reversal':
      return m.openingId
    case 'return_reversal':
      return m.returnId
    case 'credit_reversal':
      return m.creditId
    default:
      return null
  }
}

/**
 * A valid ledger from steps. Returns and credits take a share of what is left of a standing receipt.
 * A reversal takes back any standing issue, count, restock or opening, a receipt with no return or
 * credit standing, or the newest standing return or credit (so no later return of its receipt
 * stands, D-142).
 */
function toMovements(steps: readonly Step[]): WacMovement[] {
  const open: { id: string; kind: Reversible; receiptId?: string }[] = []
  const out: WacMovement[] = []
  steps.forEach((step, i) => {
    const id = `m${i}`
    switch (step.kind) {
      case 'receipt':
        out.push({
          type: 'receipt',
          id,
          qty: step.qty as Quantity,
          value: step.value as CostAmount,
        })
        break
      case 'issue':
        out.push({ type: 'issue', id, qty: step.qty as Quantity })
        break
      case 'count':
        out.push({ type: 'count', id, qty: `${step.loss ? '-' : ''}${step.qty}` as Quantity })
        break
      case 'restock':
        out.push({
          type: 'restock',
          id,
          qty: step.qty as Quantity,
          value: step.value as CostAmount,
        })
        break
      case 'opening': {
        const qty = step.qty ?? '0'
        out.push({
          type: 'opening',
          id,
          qty: qty as Quantity,
          value: openingValue(qty, step.avg),
          avgCost: step.avg,
        })
        break
      }
      case 'return':
      case 'credit': {
        const standing = [...replayWac(out).receipts.entries()]
        if (standing.length === 0) return
        const [receiptId, info] = standing[step.pick % standing.length]!
        if (step.kind === 'return') {
          const left = toDec(info.qty).minus(toDec(info.returnedQty))
          const qty = left.times(step.share).dividedBy(100).toDecimalPlaces(6, 1)
          if (!qty.gt(0)) return
          out.push({ type: 'return', id, receiptId, qty: qty.toString() as Quantity })
        } else {
          const carried = toDec(info.remainingValue)
          const amount = carried.times(step.share).dividedBy(100).toDecimalPlaces(12, 1)
          if (!amount.gt(0)) return
          out.push({ type: 'credit', id, receiptId, amount: amount.toString() as CostAmount })
        }
        open.push({ id, kind: step.kind, receiptId })
        return
      }
      case 'reverse': {
        const adjustments = open.filter((o) => o.kind === 'return' || o.kind === 'credit')
        const newest = adjustments.at(-1)
        const choices = open.filter(
          (o) =>
            o === newest ||
            (o.kind !== 'return' &&
              o.kind !== 'credit' &&
              !(o.kind === 'receipt' && adjustments.some((x) => x.receiptId === o.id))),
        )
        if (choices.length === 0) return
        const target = choices[step.pick % choices.length]!
        open.splice(open.indexOf(target), 1)
        out.push(reversalOf(target.kind, target.id))
        return
      }
    }
    open.push({ id, kind: step.kind })
  })
  return out
}

const movementsArb = fc.array(stepArb, { maxLength: 40 }).map(toMovements)
const pick = (s: WacState) => ({ qty: s.qty, value: s.value, avgCost: s.avgCost })

describe('cost engine with stock counts: properties', () => {
  it('conserves value exactly: value = Σ in − Σ out − Σ adjustments', () => {
    fc.assert(
      fc.property(movementsArb, (movements) => {
        const { state, steps } = replayWac(movements)
        let value = toDec('0')
        for (const step of steps) {
          value = value
            .plus(toDec(step.valueIn))
            .minus(toDec(step.valueOut))
            .minus(toDec(step.adjustment))
        }
        expect(value.eq(toDec(state.value))).toBe(true)
      }),
      { numRuns: 300 },
    )
  })

  it('keeps zero stock at zero value and positive stock never below zero, after every movement', () => {
    fc.assert(
      fc.property(movementsArb, (movements) => {
        for (const { state } of replayWac(movements).steps) {
          const qty = toDec(state.qty)
          const value = toDec(state.value)
          if (qty.isZero()) expect(value.isZero()).toBe(true)
          if (qty.gt(0)) expect(value.gte(0)).toBe(true)
        }
      }),
      { numRuns: 300 },
    )
  })

  it('never moves the average with a count difference or a restock', () => {
    fc.assert(
      fc.property(movementsArb, (movements) => {
        const { steps } = replayWac(movements)
        movements.forEach((m, i) => {
          if (m.type !== 'count' && m.type !== 'restock') return
          const before = i === 0 ? null : steps[i - 1]!.state.avgCost
          expect(steps[i]!.state.avgCost).toBe(before)
        })
      }),
      { numRuns: 300 },
    )
  })

  it('a ledger with reversals equals one pass over what still stands, step by step', () => {
    fc.assert(
      fc.property(movementsArb, (movements) => {
        const replay = replayWac(movements)
        // What stands after each movement, returns with the value they were given.
        const standing: WacMovement[] = []
        movements.forEach((m, i) => {
          const target = targetOf(m)
          if (target === null) {
            standing.push(m.type === 'return' ? { ...m, value: replay.steps[i]!.valueOut } : m)
            return
          }
          standing.splice(
            standing.findIndex((s) => 'id' in s && s.id === target),
            1,
          )
          expect(pick(replay.steps[i]!.state)).toEqual(pick(replayWac(standing).state))
        })
        const once = replayWac(standing)
        expect(pick(replay.state)).toEqual(pick(once.state))
        expect([...replay.receipts]).toEqual([...once.receipts])
      }),
      { numRuns: 300 },
    )
  })

  it('undoes a movement reversed straight away, whatever its kind and the stock', () => {
    const lastArb = fc.oneof(
      qtyArb.map((qty): WacMovement => ({ type: 'issue', id: 'x', qty: qty as Quantity })),
      fc.tuple(qtyArb, fc.boolean()).map(([qty, loss]): WacMovement => ({
        type: 'count',
        id: 'x',
        qty: `${loss ? '-' : ''}${qty}` as Quantity,
      })),
      fc.tuple(qtyArb, valueArb).map(([qty, value]): WacMovement => ({
        type: 'restock',
        id: 'x',
        qty: qty as Quantity,
        value: value as CostAmount,
      })),
      fc.tuple(qtyArb, valueArb).map(([qty, value]): WacMovement => ({
        type: 'receipt',
        id: 'x',
        qty: qty as Quantity,
        value: value as CostAmount,
      })),
      fc.tuple(fc.option(qtyArb, { nil: null }), avgArb).map(([qty, avg]): WacMovement => ({
        type: 'opening',
        id: 'x',
        qty: (qty ?? '0') as Quantity,
        value: openingValue(qty ?? '0', avg),
        avgCost: avg,
      })),
    )
    fc.assert(
      fc.property(movementsArb, lastArb, (movements, last) => {
        const before = replayWac(movements).state
        const undo = reversalOf(last.type as Reversible, 'x')
        expect(pick(replayWac([...movements, last, undo]).state)).toEqual(pick(before))
      }),
      { numRuns: 300 },
    )
  })

  it('makes the state after a first count exactly the count, whatever came before', () => {
    fc.assert(
      fc.property(movementsArb, qtyArb, avgArb, (movements, qty, avg) => {
        const value = openingValue(qty, avg)
        const opening: WacMovement = {
          type: 'opening',
          id: 'o',
          qty: qty as Quantity,
          value,
          avgCost: avg,
        }
        const state = replayWac([...movements, opening]).state
        expect(pick(state)).toEqual({
          qty: toDec(qty).toString(),
          value: toDec(value).toString(),
          avgCost: avg,
        })
      }),
      { numRuns: 200 },
    )
  })
})
