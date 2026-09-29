import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { subtractDecimals } from '../documents/split'
import { outstandingOf, overpaidOf } from './keys'

// What is still owed on a purchase and what was paid beyond it (the owner's requests of 2026-09-29,
// D-162): a return or credit note posted after the purchase was paid leaves it overpaid.

describe('outstandingOf and overpaidOf', () => {
  it.each([
    // total, returned, paid → outstanding, overpaid
    ['105', '0', '0', '105', '0'],
    ['105', '0', '40', '65', '0'],
    ['105', '0', '105', '0', '0'],
    ['105', '10.5', '0', '94.5', '0'],
    ['105', '10.5', '105', '0', '10.5'],
    ['252', '105', '201', '0', '54'],
    ['63', '21', '0', '42', '0'],
  ])('total %s, returned %s, paid %s → owed %s, overpaid %s', (t, r, p, owed, over) => {
    expect(outstandingOf(t, r, p)).toBe(owed)
    expect(overpaidOf(t, r, p)).toBe(over)
  })

  it('always add up: total − returned − paid = outstanding − overpaid, one of them zero', () => {
    const amount = fc
      .bigInt({ min: 0n, max: 10_000_000n })
      .map((minor) => subtractDecimals(`${minor / 100n}.${String(minor % 100n).padStart(2, '0')}`))
    fc.assert(
      fc.property(amount, amount, amount, (total, returned, paid) => {
        const owed = outstandingOf(total, returned, paid)
        const over = overpaidOf(total, returned, paid)
        expect(subtractDecimals(owed, over)).toBe(subtractDecimals(total, returned, paid))
        expect(owed === '0' || over === '0').toBe(true)
      }),
    )
  })
})
