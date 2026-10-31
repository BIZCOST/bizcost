import { describe, expect, it } from 'vitest'
import type { CostAmount, Quantity, UnitCost } from '../numbers/kinds'
import { openingOf } from '../stock/count'
import { lateOffset } from '../stock/late'
import { costOfQty } from './recipe'
import {
  EMPTY_WAC_STATE,
  replayWac,
  wacCount,
  wacIssue,
  wacOpen,
  wacReceive,
  wacRestock,
  type WacMovement,
  type WacState,
} from './wac'

// Stock counts in the cost engine (M4 Step 1; D-339 Q2–Q5). Litres as the base unit for reading;
// the API keeps milk in ml, which changes no figure here.

const q = (value: string) => value as Quantity
const v = (value: string) => value as CostAmount
const pick = (state: WacState) => ({ qty: state.qty, value: state.value, avgCost: state.avgCost })

describe('the café’s October, milk at AED 6.00 a litre (M4 definition of done)', () => {
  // Before the first count, purchases only (D-219): 300 L for 1,800 in the 90 days to 30 Sep.
  const before = wacReceive(EMPTY_WAC_STATE, { qty: q('300'), value: v('1800') }).state
  const average = { value: '1800', qty: '300' }

  it('starts the stock at the first count, at that day’s 90-day average, so a latte costs the same', () => {
    const opening = openingOf(q('40'), average)
    expect(opening).toEqual({ qty: '40', value: '240', avgCost: '6' })
    const { state, change } = wacOpen(before, opening)
    expect(pick(state)).toEqual({ qty: '40', value: '240', avgCost: '6' })
    expect(change).toBe('-1560')
    // 200 ml of milk the day before (the 90-day average) and the day after (the stock average).
    expect(costOfQty('0.2', average)).toBe('1.2')
    expect(costOfQty('0.2', { value: state.value, qty: state.qty })).toBe('1.2')
  })

  it('takes October’s sales and waste out, and the 31 Oct count finds 80 L unexplained (AED 480)', () => {
    let state = wacOpen(before, openingOf(q('40'), average)).state
    state = wacReceive(state, { qty: q('600'), value: v('3600') }).state
    let sold = 0
    // 2,500 lattes × 200 ml, posted as 25 days of 20 L.
    for (let day = 0; day < 25; day += 1) {
      const issue = wacIssue(state, q('20'))
      sold += Number(issue.cost)
      state = issue.state
    }
    expect(sold).toBe(3000)
    const waste = wacIssue(state, q('10'))
    expect(waste.cost).toBe('60')
    state = waste.state
    expect(pick(state)).toEqual({ qty: '130', value: '780', avgCost: '6' })
    const count = wacCount(state, q('-80'))
    expect(count.value).toBe('-480')
    expect(pick(count.state)).toEqual({ qty: '50', value: '300', avgCost: '6' })
  })

  it('keeps the count’s stock when 31 Oct’s sales are imported after it (Q5)', () => {
    let state = wacOpen(before, openingOf(q('40'), average)).state
    state = wacReceive(state, { qty: q('600'), value: v('3600') }).state
    state = wacIssue(state, q('480')).state
    state = wacIssue(state, q('10')).state
    // Counted 50 L while the book said 150: 100 L less (AED 600).
    const count = wacCount(state, q('-100'))
    expect(count.value).toBe('-600')
    state = count.state
    // 1 Nov: 31 Oct's 100 lattes come in, and the count absorbs them.
    const late = wacIssue(state, q('20'))
    expect(late.cost).toBe('120')
    const offset = lateOffset(q('-20'), late.cost)
    expect(offset).toEqual({ kind: 'restock', qty: '20', value: '120' })
    if (offset.kind !== 'restock') throw new Error('an issue is put back')
    const after = wacRestock(late.state, offset)
    expect(pick(after.state)).toEqual({ qty: '50', value: '300', avgCost: '6' })
    // The count's difference with its offset is now −80 L, AED −480.
    expect(Number(count.value) + Number(offset.value)).toBe(-480)
  })
})

describe('entries posted after a count, when the average has moved since (review of Step 1)', () => {
  // 31 Oct: 50 L counted at 6.00 (100 L less than the book).
  const counted = (() => {
    let state = wacOpen(EMPTY_WAC_STATE, openingOf(q('40'), { value: '240', qty: '40' })).state
    state = wacReceive(state, { qty: q('600'), value: v('3600') }).state
    state = wacIssue(state, q('490')).state
    return wacCount(state, q('-100')).state
  })()

  it('puts a late sale back at exactly its cost, so the stock now is what date order gives', () => {
    // 1 Nov: 100 L bought for 800 → 150 L, 1,100, 7.333333333333.
    const bought = wacReceive(counted, { qty: q('100'), value: v('800') }).state
    // 2 Nov: 31 Oct's 20 L of sales come in at today's average.
    const sale = wacIssue(bought, q('20'))
    expect(sale.cost).toBe('146.66666666666')
    const offset = lateOffset(q('-20'), sale.cost)
    if (offset.kind !== 'restock') throw new Error('an issue is put back')
    const after = wacRestock(sale.state, offset)
    expect(pick(after.state)).toEqual(pick(bought))
    // The last litres never sell at no cost: emptying the stock takes exactly its value.
    expect(wacIssue(after.state, q('150')).cost).toBe('1100')
  })

  it('takes a late purchase back out at the average it left, never at a price from before it', () => {
    // Opening 6 L at 6; the count finds 5 L (−1 L, −6).
    let state = wacOpen(EMPTY_WAC_STATE, {
      qty: q('6'),
      value: v('36'),
      avgCost: '6' as UnitCost,
    }).state
    state = wacCount(state, q('-1')).state
    // A purchase dated before the count comes in after it: 100 L for 400.
    state = wacReceive(state, { qty: q('100'), value: v('400') }).state
    const offset = lateOffset(q('100'))
    expect(offset).toEqual({ kind: 'count', qty: '-100' })
    const after = wacCount(state, offset.qty)
    // 105 L worth 430 at 4.095238095238: 100 L leave at that average.
    expect(after.value).toBe('-409.5238095238')
    expect(pick(after.state)).toEqual({
      qty: '5',
      value: '20.4761904762',
      avgCost: '4.095238095238',
    })
    // Everything paid (436) is the stock left and what the count found missing: no more.
    expect(6 + 409.5238095238 + 20.4761904762).toBeCloseTo(436, 9)
  })
})

describe('first counts', () => {
  it('counts stock without a price yet at no value, until the first purchase prices it', () => {
    const opened = wacOpen(EMPTY_WAC_STATE, openingOf(q('10'), null))
    expect(pick(opened.state)).toEqual({ qty: '10', value: '0', avgCost: null })
    const bought = wacReceive(opened.state, { qty: q('5'), value: v('50') })
    expect(pick(bought.state)).toEqual({ qty: '15', value: '150', avgCost: '10' })
    // 100 of value given to the 10 counted: value after = 0 + 50 − (−100).
    expect(bought.adjustment).toBe('-100')
  })

  it('costs an issue of unpriced counted stock at nothing ("no price yet")', () => {
    const opened = wacOpen(EMPTY_WAC_STATE, openingOf(q('10'), null)).state
    expect(wacIssue(opened, q('4'))).toMatchObject({ cost: '0', unitCost: null })
  })

  it('resets whatever the book said, and a count of nothing keeps the average', () => {
    const book = wacReceive(EMPTY_WAC_STATE, { qty: q('3'), value: v('100') }).state
    const opened = wacOpen(book, openingOf(q('0'), { value: '100', qty: '3' }))
    expect(pick(opened.state)).toEqual({ qty: '0', value: '0', avgCost: '33.333333333333' })
  })

  it('refuses what a count cannot be', () => {
    expect(() => wacOpen(EMPTY_WAC_STATE, { qty: q('-1'), value: v('0'), avgCost: null })).toThrow(
      RangeError,
    )
    expect(() => wacOpen(EMPTY_WAC_STATE, { qty: q('1'), value: v('5'), avgCost: null })).toThrow(
      RangeError,
    )
    expect(() =>
      wacOpen(EMPTY_WAC_STATE, { qty: q('0'), value: v('5'), avgCost: '5' as UnitCost }),
    ).toThrow(RangeError)
    // A negative average, or a value that is not the quantity × the average (review of Step 1).
    expect(() =>
      wacOpen(EMPTY_WAC_STATE, { qty: q('10'), value: v('0'), avgCost: '-5' as UnitCost }),
    ).toThrow(RangeError)
    expect(() =>
      wacOpen(EMPTY_WAC_STATE, { qty: q('10'), value: v('1000'), avgCost: '1' as UnitCost }),
    ).toThrow(RangeError)
    // openingOf's own rounding is accepted: 3 at 10 for 3 is 10, at 3.333333333333.
    expect(() =>
      wacOpen(EMPTY_WAC_STATE, openingOf(q('3'), { value: '10', qty: '3' })),
    ).not.toThrow()
  })
})

describe('count differences', () => {
  const stock = wacReceive(EMPTY_WAC_STATE, { qty: q('10'), value: v('100') }).state

  it('brings a gain in at the average and leaves the average alone', () => {
    const r = wacCount(stock, q('2.5'))
    expect(r).toMatchObject({ value: '25', adjustment: '0', unitCost: '10' })
    expect(pick(r.state)).toEqual({ qty: '12.5', value: '125', avgCost: '10' })
  })

  it('takes a loss out as an issue: all of it at exactly the value left, beyond it as shortfall', () => {
    expect(pick(wacCount(stock, q('-10')).state)).toEqual({ qty: '0', value: '0', avgCost: '10' })
    const beyond = wacCount(stock, q('-12'))
    expect(beyond).toMatchObject({ value: '-120', shortfall: '2' })
    expect(pick(beyond.state)).toEqual({ qty: '-2', value: '-20', avgCost: '10' })
  })

  it('refuses a difference of nothing', () => {
    expect(() => wacCount(stock, q('0'))).toThrow(RangeError)
  })
})

describe('restocks', () => {
  const stock = wacReceive(EMPTY_WAC_STATE, { qty: q('10'), value: v('100') }).state

  it('undoes an issue exactly, at any stock level, the average kept', () => {
    for (const qty of ['4', '10', '13']) {
      const issue = wacIssue(stock, q(qty))
      const back = wacRestock(issue.state, { qty: q(qty), value: issue.cost })
      expect(pick(back.state)).toEqual(pick(stock))
      expect(back.adjustment).toBe('0')
    }
  })

  it('keeps zero stock at zero value and positive stock never below it', () => {
    const short = wacIssue(stock, q('12')).state
    const back = wacRestock(short, { qty: q('2'), value: v('5') })
    expect(pick(back.state)).toEqual({ qty: '0', value: '0', avgCost: '10' })
    expect(back.adjustment).toBe('-15')
    expect(() => wacRestock(stock, { qty: q('0'), value: v('1') })).toThrow(RangeError)
    expect(() => wacRestock(stock, { qty: q('1'), value: v('-1') })).toThrow(RangeError)
  })

  it('is reversed like a receipt: its value goes back out', () => {
    const replay = replayWac([
      { type: 'receipt', id: 'r1', qty: q('10'), value: v('100') },
      { type: 'restock', id: 's1', qty: q('2'), value: v('18') },
      { type: 'restock_reversal', restockId: 's1' },
    ])
    expect(pick(replay.state)).toEqual(pick(stock))
    expect(replay.steps[2]).toMatchObject({ valueIn: '0', valueOut: '18', adjustment: '0' })
  })
})

describe('reversals of issues, counts and first counts (replays)', () => {
  const receipt: WacMovement = { type: 'receipt', id: 'r1', qty: q('10'), value: v('100') }

  it('undoes an issue: its cost comes back in', () => {
    const replay = replayWac([
      receipt,
      { type: 'issue', id: 'i1', qty: q('4') },
      { type: 'issue_reversal', issueId: 'i1' },
    ])
    expect(pick(replay.state)).toEqual({ qty: '10', value: '100', avgCost: '10' })
    expect(replay.steps[2]).toMatchObject({ valueIn: '40', valueOut: '0', adjustment: '0' })
  })

  it('undoes a count, and a first count back to the purchases-only book', () => {
    const counted = replayWac([
      receipt,
      { type: 'count', id: 'c1', qty: q('-3') },
      { type: 'count_reversal', countId: 'c1' },
    ])
    expect(pick(counted.state)).toEqual({ qty: '10', value: '100', avgCost: '10' })
    const opened = replayWac([
      receipt,
      { type: 'opening', id: 'o1', qty: q('4'), value: v('40'), avgCost: '10' as UnitCost },
      { type: 'opening_reversal', openingId: 'o1' },
    ])
    expect(pick(opened.state)).toEqual({ qty: '10', value: '100', avgCost: '10' })
    expect(opened.steps[2]).toMatchObject({ valueIn: '60', valueOut: '0', adjustment: '0' })
  })

  it('leaves the stock after a first count alone when a purchase before it is reversed', () => {
    const replay = replayWac([
      receipt,
      { type: 'opening', id: 'o1', qty: q('40'), value: v('240'), avgCost: '6' as UnitCost },
      { type: 'issue', id: 'i1', qty: q('20') },
      { type: 'receipt_reversal', receiptId: 'r1' },
    ])
    expect(pick(replay.state)).toEqual({ qty: '20', value: '120', avgCost: '6' })
    // Its value goes out and comes straight back: nothing after the count changes.
    expect(replay.steps[3]).toMatchObject({ valueOut: '100', adjustment: '-100' })
  })

  it('refuses reversing what is not there, an issue without an id, or twice', () => {
    expect(() =>
      replayWac([
        { type: 'issue', qty: q('1') },
        { type: 'issue_reversal', issueId: 'x' },
      ]),
    ).toThrow(RangeError)
    expect(() =>
      replayWac([
        receipt,
        { type: 'count', id: 'c1', qty: q('1') },
        { type: 'count_reversal', countId: 'c1' },
        { type: 'count_reversal', countId: 'c1' },
      ]),
    ).toThrow(RangeError)
    expect(() => replayWac([receipt, { type: 'issue_reversal', issueId: 'r1' }])).toThrow(
      RangeError,
    )
  })
})
