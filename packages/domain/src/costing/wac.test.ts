import { describe, expect, it } from 'vitest'
import { plain, toDec } from '../numbers/decimal'
import type { CostAmount, Quantity } from '../numbers/kinds'
import { roundForDisplay } from '../numbers/rounding'
import {
  EMPTY_WAC_STATE,
  replayWac,
  wacIssue,
  wacReceive,
  wacReverseReceipt,
  type WacMovement,
  type WacReceipt,
  type WacState,
} from './wac'

const q = (value: string) => value as Quantity
/** `qty` base units bought at `unitCost` each: the receipt carries qty × unitCost as its value. */
const at = (qty: string, unitCost: string): WacReceipt => ({
  qty: q(qty),
  value: plain(toDec(qty).times(toDec(unitCost))) as CostAmount,
})
const receive = (state: WacState, qty: string, unitCost: string) =>
  wacReceive(state, at(qty, unitCost))
const pick = ({ qty, value, avgCost }: WacState) => ({ qty, value, avgCost })

/** A material's ledger, built movement by movement. */
function ledger() {
  const movements: WacMovement[] = []
  return {
    movements,
    receive(qty: string, unitCost: string) {
      const id = `r${movements.length}`
      movements.push({ type: 'receipt', id, ...at(qty, unitCost) })
      return id
    },
    issue(qty: string) {
      movements.push({ type: 'issue', qty: q(qty) })
    },
    /** Reverses a receipt: the reversal's result, and the movement joins the ledger. */
    reverse(receiptId: string) {
      const result = wacReverseReceipt(movements, receiptId)
      movements.push({ type: 'receipt_reversal', receiptId })
      return result
    },
    get state() {
      return replayWac(movements).state
    },
  }
}

/** 50 L at AED 6, then 100 L at AED 7 (the owner's spec §14). */
function ownerExample() {
  return receive(receive(EMPTY_WAC_STATE, '50', '6').state, '100', '7').state
}

describe('wacReceive', () => {
  it('matches the owner example: (50 × 6 + 100 × 7) / 150 = 6.666…', () => {
    const first = receive(EMPTY_WAC_STATE, '50', '6')
    expect(first).toEqual({
      state: { qty: '50', value: '300', avgCost: '6' },
      value: '300',
      adjustment: '0',
    })
    const state = ownerExample()
    expect(state).toEqual({ qty: '150', value: '1000', avgCost: '6.666666666667' })
    expect(roundForDisplay(state.avgCost!, 2)).toBe('6.67')
  })

  it('gives the same average in base units (ml)', () => {
    const ml = receive(receive(EMPTY_WAC_STATE, '50000', '0.006').state, '100000', '0.007')
    expect(pick(ml.state)).toEqual({ qty: '150000', value: '1000', avgCost: '0.006666666667' })
  })

  it('puts exactly what was paid into stock: 3 kg for AED 100 is worth 100', () => {
    const received = wacReceive(EMPTY_WAC_STATE, { qty: q('3000'), value: '100' as CostAmount })
    expect(pick(received.state)).toEqual({ qty: '3000', value: '100', avgCost: '0.033333333333' })
    expect(wacIssue(received.state, q('3000')).cost).toBe('100')
  })

  it('starts again from the receipt cost after the stock was used up', () => {
    const empty = wacIssue(ownerExample(), q('150')).state
    expect(pick(empty)).toEqual({ qty: '0', value: '0', avgCost: '6.666666666667' })
    expect(receive(empty, '10', '8').state).toEqual({ qty: '10', value: '80', avgCost: '8' })
  })

  it('accepts free goods and refuses bad or out-of-column input', () => {
    expect(pick(receive(EMPTY_WAC_STATE, '5', '0').state)).toEqual({
      qty: '5',
      value: '0',
      avgCost: '0',
    })
    const minusZero = { qty: q('5'), value: '-0.00' as CostAmount }
    expect(pick(wacReceive(EMPTY_WAC_STATE, minusZero).state)).toEqual({
      qty: '5',
      value: '0',
      avgCost: '0',
    })
    expect(() => receive(EMPTY_WAC_STATE, '0', '1')).toThrow(RangeError)
    expect(() => receive(EMPTY_WAC_STATE, '-1', '1')).toThrow(RangeError)
    expect(() => receive(EMPTY_WAC_STATE, '1', '-0.5')).toThrow(RangeError)
    expect(() => receive(EMPTY_WAC_STATE, '1e2', '1')).toThrow(RangeError)
    // numeric(24,6) and numeric(28,12): Postgres would round these silently.
    expect(() => receive(EMPTY_WAC_STATE, '0.0000001', '1')).toThrow(/too_many_decimals/)
    const long = { qty: q('1'), value: '0.0000000000001' as CostAmount }
    expect(() => wacReceive(EMPTY_WAC_STATE, long)).toThrow(/too_many_decimals/)
    expect(() => receive(EMPTY_WAC_STATE, '1'.repeat(19), '1')).toThrow(/too_large/)
  })
})

describe('wacIssue', () => {
  it('costs usage at the average and leaves the average alone', () => {
    // The owner's spec §22: 10 L more than expected. Unrounded, it is AED 66.67 (not 66.70).
    const result = wacIssue(ownerExample(), q('10'))
    expect(result.cost).toBe('66.66666666667')
    expect(result.unitCost).toBe('6.666666666667')
    expect(result.shortfall).toBe('0')
    expect(pick(result.state)).toEqual({
      qty: '140',
      value: '933.33333333333',
      avgCost: '6.666666666667',
    })
    expect(roundForDisplay(result.cost, 2)).toBe('66.67')
  })

  it('charges the last unit exactly the value left', () => {
    const almost = wacIssue(ownerExample(), q('149.999999'))
    expect(almost.cost).toBe('999.999993333383')
    const last = wacIssue(almost.state, q('0.000001'))
    expect(last.cost).toBe('0.000006666617')
    expect(pick(last.state)).toEqual({ qty: '0', value: '0', avgCost: '6.666666666667' })
    expect(wacIssue(ownerExample(), q('150')).cost).toBe('1000')
  })

  it('refuses a quantity that is not more than zero or has more than 6 decimals', () => {
    expect(() => wacIssue(ownerExample(), q('0'))).toThrow(RangeError)
    expect(() => wacIssue(ownerExample(), q('-0'))).toThrow(RangeError)
    expect(() => wacIssue(ownerExample(), q('0.00000001'))).toThrow(/too_many_decimals/)
  })
})

describe('negative stock (proposed policy)', () => {
  it('costs usage before any receipt at 0 and revalues it at the first receipt', () => {
    const used = wacIssue(EMPTY_WAC_STATE, q('5'))
    expect(used).toEqual({
      state: { ...EMPTY_WAC_STATE, qty: '-5' },
      cost: '0',
      unitCost: null,
      shortfall: '5',
    })
    const bought = receive(used.state, '20', '4')
    expect(bought.adjustment).toBe('20') // the 5 used were worth 5 × 4
    expect(pick(bought.state)).toEqual({ qty: '15', value: '60', avgCost: '4' })
  })

  it('costs the shortfall at the average; the next receipt charges the difference', () => {
    const stocked = receive(EMPTY_WAC_STATE, '10', '5').state
    const used = wacIssue(stocked, q('12'))
    expect(used.cost).toBe('60')
    expect(used.shortfall).toBe('2')
    expect(pick(used.state)).toEqual({ qty: '-2', value: '-10', avgCost: '5' })

    const partial = receive(used.state, '1', '6')
    expect(partial.adjustment).toBe('2') // 2 × (6 − 5)
    expect(pick(partial.state)).toEqual({ qty: '-1', value: '-6', avgCost: '6' })

    const covered = receive(used.state, '2', '6')
    expect(covered.adjustment).toBe('2')
    expect(pick(covered.state)).toEqual({ qty: '0', value: '0', avgCost: '6' })

    const cheaper = receive(used.state, '10', '4.5')
    expect(cheaper.adjustment).toBe('-1') // usage was charged 1 too much
    expect(pick(cheaper.state)).toEqual({ qty: '8', value: '36', avgCost: '4.5' })
  })
})

describe('wacReverseReceipt (proposed policy: as if the receipt was never posted)', () => {
  it('brings the owner example back to exactly 6 (M2 definition of done)', () => {
    const book = ledger()
    book.receive('50', '6')
    const second = book.receive('100', '7')
    const undone = book.reverse(second)
    expect(undone.value).toBe('700')
    expect(undone.adjustment).toBe('0')
    expect(pick(undone.state)).toEqual({ qty: '50', value: '300', avgCost: '6' })
  })

  it('undoes a wrong receipt exactly when nothing was used', () => {
    const book = ledger()
    book.receive('100', '10')
    const wrong = book.receive('10', '700')
    expect(book.state.avgCost).toBe('72.727272727273')
    const undone = book.reverse(wrong)
    expect(undone.value).toBe('7000')
    expect(undone.adjustment).toBe('0')
    expect(pick(undone.state)).toEqual({ qty: '100', value: '1000', avgCost: '10' })
  })

  it('is exact with other receipts in between, when nothing was used', () => {
    const book = ledger()
    book.receive('100', '10')
    const cheap = book.receive('10', '1')
    book.receive('100', '20')
    expect(book.state.avgCost).toBe('14.333333333333')
    const undone = book.reverse(cheap)
    expect(undone.adjustment).toBe('0')
    expect(pick(undone.state)).toEqual({ qty: '200', value: '3000', avgCost: '15' })
  })

  it('credits usage that was charged the wrong receipt cost', () => {
    const book = ledger()
    book.receive('100', '10')
    const wrong = book.receive('10', '700')
    book.issue('90')
    expect(replayWac(book.movements).steps[2]!.valueOut).toBe('6545.45454545457')
    const undone = book.reverse(wrong)
    // The 90 used should have cost 10 each: 90 × (72.727272727273 − 10) was charged too much.
    expect(undone.adjustment).toBe('-5645.45454545457')
    expect(pick(undone.state)).toEqual({ qty: '10', value: '100', avgCost: '10' })
  })

  it('charges usage that got a cheap receipt; what is left keeps the real cost', () => {
    const book = ledger()
    book.receive('100', '10')
    const cheap = book.receive('10', '1')
    book.issue('99.5')
    const undone = book.reverse(cheap)
    expect(pick(undone.state)).toEqual({ qty: '0.5', value: '5', avgCost: '10' })
    expect(undone.adjustment).toBe('81.409090909109') // 99.5 × (10 − 9.181818181818)
  })

  it('treats goods of a reversed receipt that were used as never priced', () => {
    const book = ledger()
    const only = book.receive('10', '7')
    book.issue('10')
    const undone = book.reverse(only)
    // Without the receipt, the 10 used had no price: their 70 comes back, and the next real
    // purchase prices them. Net: 10 × (8 − 7).
    expect(undone.adjustment).toBe('-70')
    expect(pick(undone.state)).toEqual({ qty: '-10', value: '0', avgCost: null })
    const real = receive(undone.state, '10', '8')
    expect(real.adjustment).toBe('80')
    expect(pick(real.state)).toEqual({ qty: '0', value: '0', avgCost: '8' })
  })

  it('refuses a receipt that is not in the ledger or is already reversed', () => {
    const book = ledger()
    expect(() => book.reverse('r0')).toThrow(RangeError)
    const id = book.receive('1', '1')
    book.reverse(id)
    expect(() => book.reverse(id)).toThrow(/already reversed/)
    // A ledger that starts from a saved state cannot reverse a receipt from before it.
    expect(() => wacReverseReceipt([], id, book.state)).toThrow(/not in this ledger/)
    const twice: WacMovement[] = [
      { type: 'receipt', id: 'a', ...at('1', '1') },
      { type: 'receipt', id: 'a', ...at('1', '1') },
    ]
    expect(() => replayWac(twice)).toThrow(/Duplicate/)
  })
})

describe('replayWac', () => {
  it('applies movements in posting order and reports each value change', () => {
    const movements: WacMovement[] = [
      { type: 'receipt', id: 'a', ...at('50', '6') },
      { type: 'receipt', id: 'b', ...at('100', '7') },
      { type: 'issue', qty: q('10') },
      { type: 'receipt_reversal', receiptId: 'a' },
    ]
    const { state, steps } = replayWac(movements)
    expect(
      steps.map(({ valueIn, valueOut, adjustment }) => [valueIn, valueOut, adjustment]),
    ).toEqual([
      ['300', '0', '0'],
      ['700', '0', '0'],
      ['0', '66.66666666667', '0'],
      ['0', '300', '3.33333333333'], // the 10 used should have cost 7 each, not 6.67
    ])
    expect(pick(state)).toEqual({ qty: '90', value: '630', avgCost: '7' })
  })

  it('starts from a given state', () => {
    const { state } = replayWac([{ type: 'issue', qty: q('50') }], ownerExample())
    expect(pick(state)).toEqual({ qty: '100', value: '666.66666666665', avgCost: '6.666666666667' })
  })
})
