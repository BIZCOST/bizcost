import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { plain, toDec } from '../numbers/decimal'
import type { CostAmount, Quantity } from '../numbers/kinds'
import { roundForDisplay } from '../numbers/rounding'
import { EMPTY_WAC_STATE, replayWac, type WacMovement, type WacState, type WacStep } from './wac'

// Supplier returns and credit notes in the WAC engine (D-120), and their reversals. The owner's
// example: 50 L at AED 6, then 100 L at AED 7 → 6.666666666667 per L. Quantities here are in the
// unit the numbers are easiest to read in; the engine does not care which unit is the base.

const q = (value: string) => value as Quantity
const c = (value: string) => value as CostAmount
const pick = ({ qty, value, avgCost }: WacState) => ({ qty, value, avgCost })
const receipt = (id: string, qty: string, value: string): WacMovement => ({
  type: 'receipt',
  id,
  qty: q(qty),
  value: c(value),
})
const back = (id: string, receiptId: string, qty: string): WacMovement => ({
  type: 'return',
  id,
  receiptId,
  qty: q(qty),
})
const credit = (id: string, receiptId: string, amount: string): WacMovement => ({
  type: 'credit',
  id,
  receiptId,
  amount: c(amount),
})
const issue = (qty: string): WacMovement => ({ type: 'issue', qty: q(qty) })
const last = (movements: readonly WacMovement[]) => {
  const { steps } = replayWac(movements)
  return steps[steps.length - 1]!
}
const flow = ({ valueIn, valueOut, adjustment }: WacStep) => ({ valueIn, valueOut, adjustment })

const OWNER = [receipt('a', '50', '300'), receipt('b', '100', '700')]

describe('supplier returns (D-120 rule 2)', () => {
  it('a full return right after its purchase restores the previous average exactly', () => {
    const step = last([...OWNER, back('x', 'b', '100')])
    expect(flow(step)).toEqual({ valueIn: '0', valueOut: '700', adjustment: '0' })
    expect(pick(step.state)).toEqual({ qty: '50', value: '300', avgCost: '6' })
  })

  it('a full return of the only purchase leaves the material as never bought', () => {
    const step = last([receipt('a', '10', '72'), back('x', 'a', '10')])
    expect(pick(step.state)).toEqual(pick(EMPTY_WAC_STATE))
  })

  it('a part: out at the price paid for it, and the average moves back', () => {
    const step = last([...OWNER, back('x', 'b', '20')])
    expect(flow(step)).toEqual({ valueIn: '0', valueOut: '140', adjustment: '0' })
    // (1000 − 140) ÷ (150 − 20)
    expect(pick(step.state)).toEqual({ qty: '130', value: '860', avgCost: '6.615384615385' })
  })

  it('parts that add up to the whole take exactly what was paid', () => {
    const { steps, state, receipts } = replayWac([
      receipt('a', '3', '10'),
      back('x', 'a', '1'),
      back('y', 'a', '1'),
      back('z', 'a', '1'),
    ])
    expect(steps.slice(1).map((s) => s.valueOut)).toEqual([
      '3.333333333333',
      '3.333333333334', // what is left × 1 ÷ 2
      '3.333333333333', // the last one takes what is left
    ])
    // Nothing else was posted since the receipt: all of it back is as if it never came in.
    expect(pick(state)).toEqual(pick(EMPTY_WAC_STATE))
    expect(receipts.get('a')).toMatchObject({ returnedQty: '3', remainingValue: '0' })
  })

  it('takes discounts, VAT in cost and delivery with the goods: the line value it was given', () => {
    // A line of 12 cartons whose cost (after its discounts, with VAT and its delivery share) is 75.6.
    const step = last([receipt('a', '12', '75.6'), receipt('b', '12', '72'), back('x', 'a', '3')])
    expect(step.valueOut).toBe('18.9')
    expect(pick(step.state)).toEqual({ qty: '21', value: '128.7', avgCost: '6.128571428571' })
  })

  it('after part of the stock was used (from Phase 3): the average stays when nothing is left', () => {
    const step = last([
      receipt('a', '100', '1000'),
      receipt('b', '100', '2000'),
      issue('150'), // 150 × 15
      back('x', 'b', '50'), // the 50 left go back at 20 each
    ])
    expect(pick(step.state)).toEqual({ qty: '0', value: '0', avgCost: '15' })
    // The 150 used were 100 at 10 and 50 at 20: 250 less than they were charged.
    expect(flow(step)).toEqual({ valueIn: '0', valueOut: '1000', adjustment: '-250' })
  })

  it('never leaves a negative value on positive stock', () => {
    const step = last([
      receipt('a', '10', '10'),
      receipt('b', '10', '1000'),
      issue('15'), // 15 × 50.5 = 757.5; 5 left worth 252.5
      back('x', 'b', '4'), // 4 × 100 = 400 out
    ])
    expect(pick(step.state)).toEqual({ qty: '1', value: '0', avgCost: '0' })
    expect(step.adjustment).toBe('-147.5')
  })

  it('beyond the stock on hand: the average stays and the stock goes negative', () => {
    const step = last([receipt('a', '10', '100'), issue('8'), back('x', 'a', '5')])
    expect(pick(step.state)).toEqual({ qty: '-3', value: '-30', avgCost: '10' })
    expect(flow(step)).toEqual({ valueIn: '0', valueOut: '50', adjustment: '0' })
  })

  it('refuses more than is left of the receipt, or a receipt that is not there', () => {
    expect(() => replayWac([...OWNER, back('x', 'b', '100.000001')])).toThrow(/more than is left/)
    expect(() => replayWac([...OWNER, back('x', 'b', '60'), back('y', 'b', '41')])).toThrow(
      /more than is left/,
    )
    expect(() => replayWac([...OWNER, back('x', 'c', '1')])).toThrow(/not in this ledger/)
    expect(() => replayWac([...OWNER, back('x', 'b', '0')])).toThrow(RangeError)
    expect(() => replayWac([...OWNER, back('a', 'b', '1')])).toThrow(/Duplicate/)
  })

  it('keeps the value it was posted with when the ledger is replayed', () => {
    const posted = replayWac([...OWNER, back('x', 'b', '30')])
    const stored = posted.steps[2]!.valueOut
    const again = replayWac([
      ...OWNER,
      { type: 'return', id: 'x', receiptId: 'b', qty: q('30'), value: stored },
    ])
    expect(pick(again.state)).toEqual(pick(posted.state))
  })
})

describe('credit notes (D-120 rule 3)', () => {
  it('lowers the value of the credited goods on hand: the whole credit in M2 (nothing used)', () => {
    const step = last([...OWNER, credit('k', 'b', '100')])
    expect(flow(step)).toEqual({ valueIn: '0', valueOut: '100', adjustment: '0' })
    expect(pick(step.state)).toEqual({ qty: '150', value: '900', avgCost: '6' })
  })

  it('after part of the goods was used: the used part is one correction, past costs stay', () => {
    const step = last([receipt('a', '100', '1000'), issue('40'), credit('k', 'a', '100')])
    // 60 of the 100 are on hand: 60 off the stock, 40 for the goods already used.
    expect(flow(step)).toEqual({ valueIn: '0', valueOut: '100', adjustment: '-40' })
    expect(pick(step.state)).toEqual({ qty: '60', value: '540', avgCost: '9' })
  })

  it('takes every receipt’s goods in proportion when usage came between receipts', () => {
    // 100 of a, usage of 50 (a keeps 50), 100 of b, usage of 75 of the 150 (a keeps 25).
    const step = last([
      receipt('a', '100', '1000'),
      issue('50'),
      receipt('b', '100', '1000'),
      issue('75'),
      credit('k', 'a', '200'),
    ])
    // s = 25 ÷ 100: 50 off the stock, 150 for goods already used.
    expect(flow(step)).toEqual({ valueIn: '0', valueOut: '200', adjustment: '-150' })
    expect(pick(step.state)).toEqual({ qty: '75', value: '700', avgCost: '9.333333333333' })
  })

  it('after a partial return: the credit is on what is left of the line', () => {
    const { state, steps, receipts } = replayWac([
      receipt('a', '10', '100'),
      back('x', 'a', '4'),
      credit('k', 'a', '30'),
    ])
    expect(steps[1]!.valueOut).toBe('40')
    expect(flow(steps[2]!)).toEqual({ valueIn: '0', valueOut: '30', adjustment: '0' })
    expect(pick(state)).toEqual({ qty: '6', value: '30', avgCost: '5' })
    expect(receipts.get('a')).toMatchObject({ credited: '30', remainingValue: '30' })
  })

  it('then a return of what is left takes the credited price', () => {
    const step = last([...OWNER, credit('k', 'b', '100'), back('x', 'b', '100')])
    expect(step.valueOut).toBe('600')
    expect(pick(step.state)).toEqual({ qty: '50', value: '300', avgCost: '6' })
  })

  it('refuses more than the receipt’s goods still carry, and a zero credit', () => {
    expect(() => replayWac([...OWNER, credit('k', 'b', '700.01')])).toThrow(/still carry/)
    expect(() =>
      replayWac([...OWNER, back('x', 'b', '50'), credit('k', 'b', '350.000000000001')]),
    ).toThrow(/still carry/)
    expect(() => replayWac([...OWNER, credit('k', 'b', '0')])).toThrow(RangeError)
  })
})

describe('reversals of returns and credit notes: as if never posted', () => {
  it('a return reversed right after it restores the state', () => {
    const before = replayWac(OWNER).state
    const step = last([...OWNER, back('x', 'b', '20'), { type: 'return_reversal', returnId: 'x' }])
    expect(flow(step)).toEqual({ valueIn: '140', valueOut: '0', adjustment: '0' })
    expect(pick(step.state)).toEqual(pick(before))
  })

  it('a credit reversed right after it restores the state', () => {
    const step = last([
      ...OWNER,
      credit('k', 'b', '100'),
      { type: 'credit_reversal', creditId: 'k' },
    ])
    expect(flow(step)).toEqual({ valueIn: '100', valueOut: '0', adjustment: '0' })
    expect(pick(step.state)).toEqual({ qty: '150', value: '1000', avgCost: '6.666666666667' })
  })

  it('a purchase is reversed only after its returns and credits are', () => {
    const ledger: WacMovement[] = [...OWNER, back('x', 'b', '20'), credit('k', 'b', '10')]
    expect(() => replayWac([...ledger, { type: 'receipt_reversal', receiptId: 'b' }])).toThrow(
      /reverse them first/,
    )
    const { state } = replayWac([
      ...ledger,
      { type: 'return_reversal', returnId: 'x' },
      { type: 'credit_reversal', creditId: 'k' },
      { type: 'receipt_reversal', receiptId: 'b' },
    ])
    // The owner's example: reversing the second purchase gives exactly 6.
    expect(pick(state)).toEqual({ qty: '50', value: '300', avgCost: '6' })
    expect(roundForDisplay(state.avgCost!, 2)).toBe('6.00')
  })

  it('a return or credit is reversed only while no later return of its receipt stands (D-142)', () => {
    // The later return was valued at what the goods carried after the credit (AED 6 per L of b's 7).
    const ledger: WacMovement[] = [...OWNER, credit('k', 'b', '100'), back('x', 'b', '50')]
    expect(() => replayWac([...ledger, { type: 'credit_reversal', creditId: 'k' }])).toThrow(
      /later return/,
    )
    expect(() =>
      replayWac([
        ...OWNER,
        back('w', 'b', '10'),
        credit('k', 'b', '50'),
        back('x', 'b', '10'),
        { type: 'return_reversal', returnId: 'w' },
      ]),
    ).toThrow(/later return/)
    // Once the later return is reversed, the credit goes too: as if neither was ever posted.
    const { state } = replayWac([
      ...ledger,
      { type: 'return_reversal', returnId: 'x' },
      { type: 'credit_reversal', creditId: 'k' },
    ])
    expect(pick(state)).toEqual(pick(replayWac(OWNER).state))
    // A later credit, or a return of another receipt, does not stand in the way.
    expect(() =>
      replayWac([
        ...OWNER,
        back('x', 'b', '10'),
        credit('k', 'b', '50'),
        back('y', 'a', '10'),
        { type: 'return_reversal', returnId: 'x' },
      ]),
    ).not.toThrow()
  })

  it('refuses a reversal of something that is not there or already reversed', () => {
    expect(() => replayWac([...OWNER, { type: 'return_reversal', returnId: 'a' }])).toThrow(
      /not in this ledger/,
    )
    expect(() =>
      replayWac([
        ...OWNER,
        credit('k', 'b', '1'),
        { type: 'credit_reversal', creditId: 'k' },
        { type: 'credit_reversal', creditId: 'k' },
      ]),
    ).toThrow(/already reversed/)
    expect(() =>
      replayWac([...OWNER, { type: 'receipt_reversal', receiptId: 'b' }, credit('k', 'b', '1')]),
    ).toThrow(/not in this ledger or is reversed/)
  })
})

// ---------------------------------------------------------------------------------------------------
// Properties over random ledgers of receipts, usage, returns, credits and reversals
// ---------------------------------------------------------------------------------------------------

const qtyArb = fc
  .tuple(fc.integer({ min: 0, max: 500 }), fc.integer({ min: 0, max: 999 }))
  .filter(([whole, thousandths]) => whole + thousandths > 0)
  .map(([whole, thousandths]) => `${whole}.${String(thousandths).padStart(3, '0')}`)
const valueArb = fc
  .tuple(fc.integer({ min: 0, max: 50_000 }), fc.integer({ min: 0, max: 99 }))
  .map(([whole, cents]) => `${whole}.${String(cents).padStart(2, '0')}`)

type Op =
  | { kind: 'receipt'; qty: string; value: string }
  | { kind: 'issue'; qty: string }
  | { kind: 'return'; pick: number; share: number }
  | { kind: 'credit'; pick: number; share: number }
  | { kind: 'reverse'; pick: number }

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({ kind: fc.constant('receipt' as const), qty: qtyArb, value: valueArb }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('issue' as const), qty: qtyArb }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('return' as const),
      pick: fc.nat(),
      share: fc.integer({ min: 1, max: 100 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('credit' as const),
      pick: fc.nat(),
      share: fc.integer({ min: 1, max: 100 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('reverse' as const), pick: fc.nat() }) },
)

/**
 * A valid ledger from random operations: returns and credits take a share (%) of what is left of a
 * standing receipt, and a reversal takes back the newest standing return or credit, or a receipt
 * without any.
 */
function toLedger(ops: readonly Op[]): WacMovement[] {
  const movements: WacMovement[] = []
  const reversedIds = new Set<string>()
  ops.forEach((op, i) => {
    if (op.kind === 'receipt') {
      movements.push(receipt(`r${i}`, op.qty, op.value))
      return
    }
    if (op.kind === 'issue') {
      movements.push(issue(op.qty))
      return
    }
    const { receipts } = replayWac(movements)
    const standing = [...receipts.entries()]
    if (op.kind === 'reverse') {
      const open = movements.flatMap((m) =>
        (m.type === 'return' || m.type === 'credit') && !reversedIds.has(m.id) ? [m] : [],
      )
      const target = open.at(-1)
      if (target) {
        reversedIds.add(target.id)
        movements.push(
          target.type === 'return'
            ? { type: 'return_reversal', returnId: target.id }
            : { type: 'credit_reversal', creditId: target.id },
        )
      } else if (standing.length > 0) {
        const [id] = standing[op.pick % standing.length]!
        movements.push({ type: 'receipt_reversal', receiptId: id })
      }
      return
    }
    if (standing.length === 0) return
    const [id, info] = standing[op.pick % standing.length]!
    if (op.kind === 'return') {
      const left = toDec(info.qty).minus(toDec(info.returnedQty))
      const qty = left.times(op.share).dividedBy(100).toDecimalPlaces(6, 1)
      if (qty.gt(0)) movements.push(back(`t${i}`, id, plain(qty)))
    } else {
      const carried = toDec(info.remainingValue)
      const amount = carried.times(op.share).dividedBy(100).toDecimalPlaces(12, 1)
      if (amount.gt(0)) movements.push(credit(`k${i}`, id, plain(amount)))
    }
  })
  return movements
}

const ledgerArb = fc.array(opArb, { maxLength: 30 }).map(toLedger)

describe('properties', () => {
  it('conservation: value = Σ in − Σ out − Σ adjustments', () => {
    fc.assert(
      fc.property(ledgerArb, (movements) => {
        const { state, steps } = replayWac(movements)
        const total = steps.reduce(
          (acc, s) =>
            acc.plus(toDec(s.valueIn)).minus(toDec(s.valueOut)).minus(toDec(s.adjustment)),
          toDec('0'),
        )
        expect(plain(total)).toBe(plain(toDec(state.value)))
      }),
    )
  })

  it('positive stock never has a negative value; zero stock has zero value', () => {
    fc.assert(
      fc.property(ledgerArb, (movements) => {
        for (const { state } of replayWac(movements).steps) {
          if (toDec(state.qty).gt(0)) expect(toDec(state.value).lt(0)).toBe(false)
          if (toDec(state.qty).isZero()) expect(toDec(state.value).isZero()).toBe(true)
        }
      }),
    )
  })

  it('a full return right after its receipt restores the state before it, at any stock level', () => {
    fc.assert(
      fc.property(ledgerArb, qtyArb, valueArb, (movements, qty, value) => {
        const before = replayWac(movements).state
        const after = replayWac([...movements, receipt('new', qty, value), back('out', 'new', qty)])
        expect(pick(after.state)).toEqual(pick(before))
      }),
    )
  })

  it('a return or credit reversed right after it restores the state and takes its correction back', () => {
    fc.assert(
      fc.property(
        ledgerArb,
        fc.integer({ min: 1, max: 100 }),
        fc.boolean(),
        (movements, share, isReturn) => {
          const { state: before, receipts } = replayWac(movements)
          const standing = [...receipts.entries()]
          fc.pre(standing.length > 0)
          const [id, info] = standing[0]!
          let move: WacMovement
          let undo: WacMovement
          if (isReturn) {
            const left = toDec(info.qty).minus(toDec(info.returnedQty))
            const qty = left.times(share).dividedBy(100).toDecimalPlaces(6, 1)
            fc.pre(qty.gt(0))
            move = back('p', id, plain(qty))
            undo = { type: 'return_reversal', returnId: 'p' }
          } else {
            const amount = toDec(info.remainingValue)
              .times(share)
              .dividedBy(100)
              .toDecimalPlaces(12, 1)
            fc.pre(amount.gt(0))
            move = credit('p', id, plain(amount))
            undo = { type: 'credit_reversal', creditId: 'p' }
          }
          const { steps } = replayWac([...movements, move, undo])
          const [done, undone] = steps.slice(-2) as [WacStep, WacStep]
          expect(pick(undone.state)).toEqual(pick(before))
          // What the movement booked as a correction is taken back with it.
          expect(plain(toDec(undone.adjustment).plus(toDec(done.adjustment)))).toBe('0')
        },
      ),
    )
  })

  it('without usage: returns and credits keep the stock equal to what its goods still carry', () => {
    fc.assert(
      fc.property(ledgerArb, (movements) => {
        const withoutUsage = movements.filter((m) => m.type !== 'issue')
        let replay
        try {
          replay = replayWac(withoutUsage)
        } catch {
          return // a credit or return sized against usage that is gone now
        }
        const { state, receipts } = replay
        const carried = [...receipts.values()].reduce(
          (acc, r) => acc.plus(toDec(r.remainingValue)),
          toDec('0'),
        )
        const left = [...receipts.values()].reduce(
          (acc, r) => acc.plus(toDec(r.qty)).minus(toDec(r.returnedQty)),
          toDec('0'),
        )
        expect(plain(toDec(state.qty))).toBe(plain(left))
        expect(plain(toDec(state.value))).toBe(plain(carried))
      }),
    )
  })
})
