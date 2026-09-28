import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { plain, toDec } from '../numbers/decimal'
import type { Money, Percent, Quantity } from '../numbers/kinds'
import { computePurchase, type PurchaseLineInput } from './purchase'
import { splitByWeights, sumDecimals } from './split'

// Costing adversary (M2 Step 3 review): the document discount, the delivery on the same invoice and
// a credit note entered as one amount were split "by line net with the remainder on the largest
// line", every share rounded half away from zero on its own. When many shares rounded UP, the
// remainder was negative and several minor units large, and it pushed the largest line's share below
// zero: a surcharge on that line, a negative delivery share, and with free goods a negative receipt
// value that the WAC engine and the ledger refuse (the draft could never be posted).
//
// These tests state what a split must never do. D-142 (largest remainder) makes them pass.

const material = (qty: string, unitPrice: string): PurchaseLineInput => ({
  kind: 'material',
  qty: qty as Quantity,
  unitPrice: unitPrice as Money,
  vatRate: '0' as Percent,
})
const delivery = (amount: string): PurchaseLineInput => ({
  kind: 'delivery',
  amount: amount as Money,
  vatRate: '0' as Percent,
})

describe('splitting one amount over lines never gives a line a negative share', () => {
  it('AED 1.50 over 20 equal lines: every share is 0.07 or 0.08, none below zero', () => {
    const shares = splitByWeights('1.50', Array<string>(20).fill('10.00'), 2)
    expect(sumDecimals(shares)).toBe('1.5')
    // Current code: the first (largest, tied) line gets 0.08 − 0.10 = −0.02.
    for (const share of shares) expect(toDec(share).lt(0), `share ${share}`).toBe(false)
    // No share is more than one minor unit away from its exact share (1.50 ÷ 20 = 0.075).
    for (const share of shares) {
      expect(toDec(share).minus('0.075').abs().lte('0.01'), `share ${share}`).toBe(true)
    }
  })

  it('AED 0.02 over 4 equal lines: no line gets −0.01', () => {
    const shares = splitByWeights('0.02', ['1.00', '1.00', '1.00', '1.00'], 2)
    expect(
      shares.some((s) => toDec(s).lt(0)),
      shares.join(', '),
    ).toBe(false)
  })
})

describe('a document discount never raises a line above its own net', () => {
  it('20 lines of AED 10.00 with AED 1.50 off the whole purchase', () => {
    const purchase = computePurchase(
      {
        lines: Array.from({ length: 20 }, () => material('1', '10')),
        discount: { amount: '1.50' as Money },
        vatInCost: true,
      },
      'AED',
    )
    expect(purchase.documentDiscount).toBe('1.50')
    for (const [index, line] of purchase.lines.entries()) {
      // Current code: line 1 gets a document discount of −0.02, so its taxable amount and its cost
      // are 10.02, more than the 10.00 it was bought for.
      expect(
        toDec(line.documentDiscount).lt(0),
        `line ${index + 1}: ${line.documentDiscount}`,
      ).toBe(false)
      expect(toDec(line.cost).gt(line.net), `line ${index + 1}: cost ${line.cost}`).toBe(false)
    }
  })

  it('a document discount below the lines’ net is always accepted (20 × AED 10.00, AED 199.89 off)', () => {
    const input = {
      lines: Array.from({ length: 20 }, () => material('1', '10')),
      discount: { amount: '199.89' as Money },
      vatInCost: true,
    }
    // purchaseError accepts it (199.89 < 200.00), but each share 9.9945 rounds down to 9.99 and the
    // remainder +0.09 lands on line 1: 10.08 off a line of 10.00. Current code: computePurchase then
    // throws (taxable below zero) and the API refuses the draft as VALIDATION "cannot be computed".
    expect(() => computePurchase(input, 'AED')).not.toThrow()
  })
})

describe('delivery never makes what a line’s goods cost negative', () => {
  it('free goods (100 % off the whole purchase) with AED 1.50 delivery over 20 lines', () => {
    const purchase = computePurchase(
      {
        lines: [...Array.from({ length: 20 }, () => material('1', '10')), delivery('1.50')],
        discount: { percent: '100' as Percent },
        vatInCost: true,
      },
      'AED',
    )
    expect(purchase.cost).toBe('1.50')
    for (const [index, line] of purchase.lines.entries()) {
      // Current code: line 1's delivery share is −0.02, so its cost (the receipt's value) is −0.02:
      // wacReceive and the stock_movements check both refuse it, and the purchase never posts.
      expect(toDec(line.cost).lt(0), `line ${index + 1}: cost ${line.cost}`).toBe(false)
    }
  })

  it('four free sample lines with AED 0.02 delivery', () => {
    const purchase = computePurchase(
      {
        lines: [
          material('1', '0'),
          material('1', '0'),
          material('1', '0'),
          material('1', '0'),
          delivery('0.02'),
        ],
        vatInCost: true,
      },
      'AED',
    )
    const costs = purchase.lines.filter((l) => l.kind === 'material').map((l) => l.cost)
    expect(
      costs.some((c) => toDec(c).lt(0)),
      costs.join(', '),
    ).toBe(false)
  })
})

describe('property: largest remainder (D-142)', () => {
  // Weights in minor units of `digits` decimals (money amounts, as a document carries them), and an
  // amount from zero up to their sum.
  const caseArb = fc
    .record({
      digits: fc.constantFrom(0, 2, 3),
      minors: fc.array(fc.integer({ min: 0, max: 5_000_000 }), { minLength: 1, maxLength: 30 }),
      per: fc.integer({ min: 0, max: 1000 }),
    })
    .map(({ digits, minors, per }) => {
      const scale = toDec('10').pow(digits)
      const weights = minors.map((m) => plain(toDec(String(m)).div(scale)))
      const total = minors.reduce((acc, m) => acc + m, 0)
      const amount = plain(toDec(String(Math.floor((total * per) / 1000))).div(scale))
      return { digits, weights, amount, unit: toDec('1').div(scale) }
    })

  it('shares add up to the amount, stay between 0 and their weight, within one minor unit of exact', () => {
    fc.assert(
      fc.property(caseArb, ({ digits, weights, amount, unit }) => {
        const shares = splitByWeights(amount, weights, digits)
        expect(shares).toHaveLength(weights.length)
        expect(plain(toDec(sumDecimals(shares)))).toBe(plain(toDec(amount)))
        const sum = toDec(sumDecimals(weights))
        shares.forEach((share, i) => {
          const s = toDec(share)
          expect(s.lt(0), `share ${share}`).toBe(false)
          if (!sum.gt(0)) return
          expect(s.gt(toDec(weights[i]!)), `share ${share} > weight ${weights[i]}`).toBe(false)
          const exact = toDec(amount).times(toDec(weights[i]!)).div(sum)
          expect(s.minus(exact).abs().lt(unit), `share ${share} vs ${plain(exact)}`).toBe(true)
        })
      }),
    )
  })
})
