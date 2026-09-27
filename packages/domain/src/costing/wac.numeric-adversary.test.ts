import { describe, expect, it } from 'vitest'
import { plain, toDec } from '../numbers/decimal'
import type { CostAmount, Money, Quantity } from '../numbers/kinds'
import { costPerBaseUnit, toBase } from '../units/convert'
import {
  EMPTY_WAC_STATE,
  replayWac,
  wacIssue,
  wacReceive,
  wacReverseReceipt,
  type WacMovement,
  type WacState,
} from './wac'

// Numeric adversary (M2 Step 1 review), now a regression test: each test states a property the
// engine promises, with the input that broke it before the fix. The engine's API changed with the
// fix (a receipt carries what was paid; a reversal names its receipt in the ledger), so the inputs
// are written in the new form; every expected value is the review's.

const q = (value: string) => value as Quantity
/** `qty` bought at `unitCost` each (the receipt's value is qty × unitCost). */
const at = (qty: string, unitCost: string) => ({
  qty: q(qty),
  value: plain(toDec(qty).times(toDec(unitCost))) as CostAmount,
})
const pick = ({ qty, value, avgCost }: WacState) => ({ qty, value, avgCost })

/** A ledger as a list of steps: [qty, unitCost] receives, 'qty' issues, { undo: i } reverses step i. */
type Step = readonly [string, string] | string | { readonly undo: number }
function book(steps: readonly Step[]): WacMovement[] {
  return steps.map((step, i): WacMovement => {
    if (typeof step === 'string') return { type: 'issue', qty: q(step) }
    if ('undo' in step) return { type: 'receipt_reversal', receiptId: `m${step.undo}` }
    return { type: 'receipt', id: `m${i}`, ...at(step[0], step[1]) }
  })
}
const stateOf = (steps: readonly Step[]) => replayWac(book(steps)).state
const lastStep = (steps: readonly Step[]) => replayWac(book(steps)).steps.at(-1)!

describe('reversal after an undone receipt', () => {
  // An undone receipt is not in the stock, so its cost must not shape a later reversal. Before the
  // fix its cost stayed in the reversal bounds (maxCost) and lifted the average to 51.5.
  it('an undone typo (10 @ 1000) must not let a later reversal lift the average above 2', () => {
    const withTypo: Step[] = [['10', '1'], ['10', '2'], ['10', '1000'], { undo: 2 }]
    const withoutTypo: Step[] = [
      ['10', '1'],
      ['10', '2'],
    ]
    // The undo itself is exact: both ledgers have the same qty, value and average here...
    expect(pick(stateOf(withTypo))).toEqual(pick(stateOf(withoutTypo)))

    // ...and the same next movements give the same results (no path dependence).
    const run = (steps: Step[]) => lastStep([...steps, '9.9', { undo: 0 }])
    const expected = run(withoutTypo)
    expect(pick(expected.state)).toEqual({ qty: '0.1', value: '0.2', avgCost: '2' })
    expect(expected.adjustment).toBe('4.95')

    const actual = run(withTypo)
    expect(toDec(actual.state.avgCost!).lte(2)).toBe(true)
    expect(pick(actual.state)).toEqual(pick(expected.state))
    expect(actual.adjustment).toBe(expected.adjustment)
  })
})

describe('undoing a receipt nothing was taken from, at zero or negative stock', () => {
  // Before the fix the undo was exact only at positive stock.
  it('restores the average after a typo purchase at zero stock', () => {
    const emptied: Step[] = [['50', '6'], ['100', '7'], '150']
    const empty = stateOf(emptied)
    expect(pick(empty)).toEqual({ qty: '0', value: '0', avgCost: '6.666666666667' })

    const undone = lastStep([...emptied, ['10', '600'], { undo: 3 }])
    expect(pick(undone.state)).toEqual(pick(empty))
    expect(wacIssue(undone.state, q('1')).cost).toBe('6.666666666667')
  })

  it('reverses the revaluation a typo purchase posted at negative stock', () => {
    const short: Step[] = [['10', '4'], '15']
    const negative = stateOf(short)
    expect(pick(negative)).toEqual({ qty: '-5', value: '-20', avgCost: '4' })

    const typo = wacReceive(negative, at('10', '400'))
    expect(typo.adjustment).toBe('1980') // 5 used units revalued from 4 to 400
    const undone = wacReverseReceipt(book([...short, ['10', '400']]), 'm2')
    expect(undone.adjustment).toBe('-1980')
    expect(pick(undone.state)).toEqual(pick(negative))
  })
})

describe('free goods + reversal', () => {
  it('never leaves positive stock with a negative value, nor issues at a negative cost', () => {
    // 999,999 free units (cost 0) + 1 unit at 1; use 0.000001; undo the paid receipt.
    const undone = stateOf([['999999', '0'], ['1', '1'], '0.000001', { undo: 1 }])
    expect(toDec(undone.qty).gt(0)).toBe(true)
    expect(toDec(undone.value).isNeg()).toBe(false)
    expect(toDec(wacIssue(undone, q('1')).cost).isNeg()).toBe(false)
  })
})

describe('column scales (numeric(24,6) quantities, numeric(28,12) costs)', () => {
  it('does not produce a state that numeric(24,6) / numeric(28,12) would silently round', () => {
    // Before the fix: an unrounded 17-decimal cost became the average, and an 8-decimal issue left
    // qty '2.99999999'.
    const unscaledCost = () => wacReceive(EMPTY_WAC_STATE, at('3', '0.12345678901234567'))
    expect(unscaledCost).toThrow(RangeError)
    const unscaledQty = () =>
      wacIssue(wacReceive(EMPTY_WAC_STATE, at('3', '1')).state, q('0.00000001'))
    expect(unscaledQty).toThrow(RangeError)
  })
})

describe('purchase value vs stock value', () => {
  it('puts what was paid into stock: 3 kg bought for AED 100 is worth 100', () => {
    const mass = { dimension: 'mass' } as const
    const paid = '100' as Money
    // The cost per gram is for display (and the ledger row); the receipt carries what was paid.
    const perGram = costPerBaseUnit(paid, q('3'), 'kg', mass)
    expect(perGram).toBe('0.033333333333')
    const received = wacReceive(EMPTY_WAC_STATE, { qty: toBase(q('3'), 'kg', mass), value: paid })
    // Before the fix: '99.999999999' (qty × the ROUNDED unit cost).
    expect(received.value).toBe('100')
    expect(received.state.avgCost).toBe(perGram)
    expect(wacIssue(received.state, q('3000')).cost).toBe('100')
  })
})
