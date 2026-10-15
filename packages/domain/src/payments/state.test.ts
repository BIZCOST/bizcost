import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { compareDecimal } from '../numbers/decimal'
import { outstandingOf, overpaidOf } from '../purchasing/keys'
import { netPaid, paymentState } from './state'

// An order's or a sale's payment badge (M3 Step 5, Q16, Q17): built from outstandingOf / overpaidOf
// (D-160, D-162). The home baker's order #1001 (the definition of done) as goldens; properties for
// the rest.

describe('paymentState: the baker’s order #1001', () => {
  it('170 with a deposit of 50: "Deposit paid", still owed 120', () => {
    expect(paymentState('170', '0', '50')).toBe('deposit')
    expect(outstandingOf('170', '0', '50')).toBe('120')
  })

  it('paid in full: "Paid"; nothing paid: "Not paid"', () => {
    expect(paymentState('170', '0', '170')).toBe('paid')
    expect(paymentState('170', '0', '0')).toBe('unpaid')
  })

  it('refunded 20 by amount after it was paid: overpaid 20 until the money is given back', () => {
    expect(paymentState('170', '20', '170')).toBe('overpaid')
    expect(overpaidOf('170', '20', '170')).toBe('20')
    const paid = netPaid('170', '20')
    expect(paid).toBe('150')
    expect(paymentState('170', '20', paid)).toBe('paid')
    expect(outstandingOf('170', '20', paid)).toBe('0')
  })

  it('a cancelled order owes nothing: its deposit of 50 is money back to the customer', () => {
    expect(paymentState('0', '0', '50')).toBe('overpaid')
    expect(overpaidOf('0', '0', '50')).toBe('50')
    expect(paymentState('0', '0', netPaid('50', '50'))).toBe('paid')
  })
})

describe('paymentState: properties', () => {
  const amount = fc.integer({ min: 0, max: 10_000_000 }).map((cents) => {
    const text = String(cents).padStart(3, '0')
    return `${text.slice(0, -2)}.${text.slice(-2)}`
  })

  it('owed and overpaid: at most one is more than zero, and the state says which', () => {
    fc.assert(
      fc.property(amount, amount, amount, (total, credit, paid) => {
        const credited = compareDecimal(credit, total) > 0 ? total : credit
        const owed = outstandingOf(total, credited, paid)
        const over = overpaidOf(total, credited, paid)
        expect(compareDecimal(owed, '0') > 0 && compareDecimal(over, '0') > 0).toBe(false)
        const state = paymentState(total, credited, paid)
        if (compareDecimal(over, '0') > 0) expect(state).toBe('overpaid')
        else if (compareDecimal(owed, '0') === 0) expect(state).toBe('paid')
        else expect(state).toBe(compareDecimal(paid, '0') > 0 ? 'deposit' : 'unpaid')
      }),
      { numRuns: 500 },
    )
  })
})
