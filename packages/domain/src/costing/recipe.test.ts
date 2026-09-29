import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { plain, toDec } from '../numbers/decimal'
import type { Quantity } from '../numbers/kinds'
import { roundForDisplay } from '../numbers/rounding'
import { toBase } from '../units/convert'
import type { MaterialUnits } from '../units/materials'
import { costRatio } from './cost-ratio'
import { costOfQty, costPerUnit, rollUpRecipe, unitCostOf, type CostBasis } from './recipe'

// The recipe roll-up of M2 Step 4 (D-115): Σ base quantity × average, each line an exact product
// divided once and rounded once to 12 decimals, never to the currency; "no price yet" is null, never 0.

describe('costOfQty (one division, one rounding, 12 decimals)', () => {
  it('the owner’s carton: 1 carton = 12 × 1 L for AED 72, so 200 ml costs AED 1.20', () => {
    expect(costOfQty('200', { value: '72', qty: '12000' })).toBe('1.2')
  })

  it('the owner’s average: 50 L at 6 and 100 L at 7, so 1 L costs 6.666666666667, shown 6.67', () => {
    const cost = costOfQty('1000', { value: '1000', qty: '150000' })
    expect(cost).toBe('6.666666666667')
    expect(roundForDisplay(cost!, 2)).toBe('6.67')
  })

  it('divides once: not the per-base-unit average rounded first and multiplied', () => {
    // Condensed milk: 24 tins of 397 g for AED 108; 25 ml at 1 l = 1300 g is 32.5 g.
    const basis = { value: '108', qty: '9528' }
    expect(costOfQty('32.5', basis)).toBe('0.36838790932')
    const perGram = costRatio(['108'], ['9528'])!
    expect(plain(toDec(perGram).times('32.5'))).toBe('0.368387909305')
  })

  it('null without a quantity to divide by; refuses negative input', () => {
    expect(costOfQty('5', { value: '0', qty: '0' })).toBeNull()
    expect(costOfQty('0', { value: '10', qty: '4' })).toBe('0')
    expect(() => costOfQty('-1', { value: '10', qty: '4' })).toThrow(RangeError)
    expect(() => costOfQty('1', { value: '-10', qty: '4' })).toThrow(RangeError)
  })
})

describe('rollUpRecipe', () => {
  it('the Spanish Latte: each line and the total, unrounded, shown 3.43', () => {
    const beans: MaterialUnits = {
      dimension: 'mass',
      packs: [{ id: 'bag', qty: '1', of: 'kg' }],
    }
    const condensed: MaterialUnits = {
      dimension: 'mass',
      packs: [
        { id: 'tin', qty: '397', of: 'g' },
        { id: 'carton', qty: '24', of: { pack: 'tin' } },
      ],
      crossFactors: [{ unit: 'l', qty: '1300', of: 'g' }],
    }
    const milk: MaterialUnits = {
      dimension: 'volume',
      packs: [
        { id: 'bottle', qty: '1', of: 'l' },
        { id: 'carton', qty: '12', of: { pack: 'bottle' } },
      ],
    }
    const lines = [
      // 2 bags at 60 and 1 bag at 75: 195 for 3000 g.
      { baseQty: toBase('18' as Quantity, 'g', beans), basis: { value: '195', qty: '3000' } },
      // 1 carton of 12 × 1 L for 72.
      { baseQty: toBase('200' as Quantity, 'ml', milk), basis: { value: '72', qty: '12000' } },
      // 1 carton of 24 × 397 g for 108; 25 ml through 1 l = 1300 g.
      {
        baseQty: toBase('25' as Quantity, 'ml', condensed),
        basis: { value: '108', qty: '9528' },
      },
      // Cups: 2 sleeves of 50 for 25 each; lids: 100 for 15; straws: 500 for 20.
      { baseQty: '1', basis: { value: '50', qty: '100' } },
      { baseQty: '1', basis: { value: '15', qty: '100' } },
      { baseQty: '1', basis: { value: '20', qty: '500' } },
    ]
    expect(lines[2]?.baseQty).toBe('32.5')
    const cost = rollUpRecipe(lines)
    expect(cost.lines).toEqual(['1.17', '1.2', '0.36838790932', '0.5', '0.15', '0.04'])
    expect(cost.total).toBe('3.42838790932')
    expect(roundForDisplay(cost.total!, 2)).toBe('3.43')
    expect(cost).toMatchObject({ perUnit: '3.42838790932', unpriced: 0, complete: true })
  })

  it('a material never bought has no cost, never 0, and the total is incomplete', () => {
    const cost = rollUpRecipe([
      { baseQty: '200', basis: { value: '72', qty: '12000' } },
      { baseQty: '1', basis: null },
    ])
    expect(cost.lines).toEqual(['1.2', null])
    expect(cost).toMatchObject({ total: '1.2', perUnit: '1.2', unpriced: 1, complete: false })
    expect(rollUpRecipe([{ baseQty: '1', basis: null }])).toEqual({
      lines: [null],
      total: null,
      perUnit: null,
      tooLarge: false,
      unpriced: 1,
      complete: false,
    })
  })

  it('an empty recipe has no total and is not complete', () => {
    expect(rollUpRecipe([])).toEqual({
      lines: [],
      total: null,
      perUnit: null,
      tooLarge: false,
      unpriced: 0,
      complete: false,
    })
  })
})

describe('rollUpRecipe properties', () => {
  const qtyArb = fc
    .tuple(fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 999_999 }))
    .filter(([whole, frac]) => whole + frac > 0)
    .map(([whole, frac]) => `${whole}.${String(frac).padStart(6, '0')}`)
  const basisArb: fc.Arbitrary<CostBasis | null> = fc.option(
    fc.record({
      value: fc
        .tuple(fc.integer({ min: 0, max: 10_000_000 }), fc.integer({ min: 0, max: 9999 }))
        .map(([whole, frac]) => `${whole}.${String(frac).padStart(4, '0')}`),
      qty: qtyArb,
    }),
    { freq: 5 },
  )
  const linesArb = fc.array(fc.record({ baseQty: qtyArb, basis: basisArb }), { maxLength: 20 })

  it('the total is the exact sum of the priced lines, each line costRatio of its sums', () => {
    fc.assert(
      fc.property(linesArb, (lines) => {
        const cost = rollUpRecipe(lines)
        const expected = lines.map((line) =>
          line.basis ? costRatio([line.baseQty, line.basis.value], [line.basis.qty]) : null,
        )
        expect(cost.lines).toEqual(expected)
        const priced = expected.filter((c): c is NonNullable<typeof c> => c !== null)
        expect(cost.total).toBe(
          priced.length === 0 ? null : plain(priced.reduce((s, c) => s.plus(c), toDec('0'))),
        )
        expect(cost.unpriced).toBe(expected.length - priced.length)
        expect(cost.complete).toBe(lines.length > 0 && priced.length === lines.length)
        // "No price yet" is never a 0 in the lines.
        lines.forEach((line, i) => {
          if (!line.basis) expect(cost.lines[i]).toBeNull()
        })
      }),
    )
  })

  it('a line costs its share of the purchases it is priced from: all of them costs their value', () => {
    fc.assert(
      fc.property(basisArb, (basis) => {
        if (!basis) return
        expect(toDec(costOfQty(basis.qty, basis)!).equals(toDec(basis.value))).toBe(true)
      }),
    )
  })
})

// A recipe that makes several units (the owner's answer of 2026-09-29, D-178): the lines are what
// the whole recipe uses, and one unit sold costs the total ÷ the yield, divided once, 12 decimals.
describe('a recipe that makes several units (yield)', () => {
  it('a cake that makes 12 slices: one slice costs the cake ÷ 12', () => {
    // Flour 500 g of a 10 kg sack at AED 50; 4 eggs of a tray of 30 at AED 12; sugar 200 g of a 1 kg
    // bag at AED 4; butter 250 g of a 1 kg block at AED 32.
    const cake = rollUpRecipe(
      [
        { baseQty: '500', basis: { value: '50', qty: '10000' } },
        { baseQty: '4', basis: { value: '12', qty: '30' } },
        { baseQty: '200', basis: { value: '4', qty: '1000' } },
        { baseQty: '250', basis: { value: '32', qty: '1000' } },
      ],
      '12',
    )
    expect(cake.lines).toEqual(['2.5', '1.6', '0.8', '8'])
    expect(cake.total).toBe('12.9')
    expect(cake.perUnit).toBe('1.075')
    expect(roundForDisplay(cake.perUnit!, 2)).toBe('1.08')
    expect(cake).toMatchObject({ unpriced: 0, complete: true })
  })

  it('divides once and rounds once, to 12 decimals', () => {
    expect(costPerUnit('10', '3')).toBe('3.333333333333')
    expect(costPerUnit('20', '3')).toBe('6.666666666667')
    // Half a batch (a yield below one unit) doubles the cost of one unit.
    expect(costPerUnit('7.5', '0.5')).toBe('15')
    expect(costPerUnit('12.9', '12.000000')).toBe('1.075')
  })

  it('a yield of 1 is the total itself; no total, no cost per unit', () => {
    expect(costPerUnit('3.42838790932', '1')).toBe('3.42838790932')
    expect(costPerUnit(null, '12')).toBeNull()
    expect(rollUpRecipe([{ baseQty: '1', basis: null }], '12').perUnit).toBeNull()
    expect(rollUpRecipe([], '12')).toMatchObject({ total: null, perUnit: null })
  })

  it('an incomplete recipe divides what has a price, and says it is incomplete', () => {
    const cost = rollUpRecipe(
      [
        { baseQty: '200', basis: { value: '72', qty: '12000' } },
        { baseQty: '1', basis: null },
      ],
      '4',
    )
    expect(cost).toMatchObject({ total: '1.2', perUnit: '0.3', unpriced: 1, complete: false })
  })

  it('a cost per unit that does not fit a cost amount is not worked out: too large', () => {
    // 10^10 at a yield of 0.000001 is 10^16 a unit: one digit more than numeric(28,12) holds.
    const line = { baseQty: '1', basis: { value: '10000000000', qty: '1' } }
    expect(rollUpRecipe([line], '0.000001')).toMatchObject({
      total: '10000000000',
      perUnit: null,
      tooLarge: true,
      complete: true,
    })
    // The largest that fits is kept.
    expect(rollUpRecipe([line], '0.00001')).toMatchObject({
      perUnit: '1000000000000000',
      tooLarge: false,
    })
    expect(unitCostOf('9999999999999999.999999999999')).toEqual({
      perUnit: '9999999999999999.999999999999',
      tooLarge: false,
    })
    expect(unitCostOf('10000000000000000')).toEqual({ perUnit: null, tooLarge: true })
    expect(unitCostOf(null)).toEqual({ perUnit: null, tooLarge: false })
  })

  it('refuses a yield that is not more than zero', () => {
    expect(() => costPerUnit('1', '0')).toThrow(RangeError)
    expect(() => costPerUnit('1', '-2')).toThrow(RangeError)
    expect(() => rollUpRecipe([], '0')).toThrow(RangeError)
  })

  it('property: the cost per unit is the total ÷ the yield, to 12 decimals', () => {
    const yieldArb = fc
      .tuple(fc.integer({ min: 0, max: 10_000 }), fc.integer({ min: 0, max: 999_999 }))
      .filter(([whole, frac]) => whole + frac > 0)
      .map(([whole, frac]) => `${whole}.${String(frac).padStart(6, '0')}`)
    const totalArb = fc
      .tuple(fc.integer({ min: 0, max: 10_000_000 }), fc.integer({ min: 0, max: 999_999_999 }))
      .map(([whole, frac]) => `${whole}.${String(frac).padStart(9, '0')}`)
    fc.assert(
      fc.property(totalArb, yieldArb, (total, yieldQty) => {
        const perUnit = costPerUnit(total, yieldQty)!
        expect(perUnit).toBe(costRatio([total], [yieldQty]))
        // Never more than half of the 12th decimal away from the exact quotient, times the yield.
        const back = toDec(perUnit).times(yieldQty).minus(toDec(total)).abs()
        expect(back.lte(toDec(yieldQty).times('0.0000000000005'))).toBe(true)
      }),
    )
  })
})
