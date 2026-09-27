import Decimal from 'decimal.js'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { toDec } from '../numbers/decimal'
import type { CostAmount, Money, Quantity, UnitCost } from '../numbers/kinds'
import { roundDocument, roundForDisplay } from '../numbers/rounding'
import { costPerBaseUnit, fromBase, recipeLineCost, toBase, unitFactor } from './convert'
import { validateMaterialUnits, type MaterialUnits, type PackDefinition } from './materials'

const q = (value: string) => value as Quantity
const money = (value: string) => value as Money

const WATER: MaterialUnits = {
  dimension: 'volume',
  packs: [
    { id: 'carton', qty: '12', of: { pack: 'bottle' } },
    { id: 'bottle', qty: '1', of: 'l' },
  ],
}
const CUPS: MaterialUnits = {
  dimension: 'count',
  packs: [
    { id: 'box', qty: '20', of: { pack: 'pack' } },
    { id: 'pack', qty: '50', of: { pack: 'cup' } },
    { id: 'cup', qty: '1', of: 'piece' },
  ],
}
const OIL: MaterialUnits = {
  dimension: 'mass',
  packs: [{ id: 'bottle', qty: '1.5', of: 'l' }],
  crossFactors: [{ unit: 'l', qty: '0.92', of: 'kg' }],
}
const carton = { pack: 'carton' }

describe('the owner example: a carton of 12 × 1 L bottles for AED 72', () => {
  it('costs AED 0.006 per ml, and 200 ml costs AED 1.20', () => {
    expect(unitFactor(carton, WATER)).toBe('12000')
    const perMl = costPerBaseUnit(money('72'), q('1'), carton, WATER)
    expect(perMl).toBe('0.006')
    const cost = recipeLineCost(q('200'), 'ml', perMl, WATER)
    expect(cost).toBe('1.2')
    expect(roundForDisplay(cost, 2)).toBe('1.20')
    expect(roundDocument(cost, 'AED')).toBe('1.20')
  })

  it('gives the same cost per ml whatever unit the purchase is in', () => {
    expect(costPerBaseUnit(money('360'), q('5'), carton, WATER)).toBe('0.006')
    expect(costPerBaseUnit(money('6'), q('1'), { pack: 'bottle' }, WATER)).toBe('0.006')
    expect(costPerBaseUnit(money('0.006'), q('1'), 'ml', WATER)).toBe('0.006')
    expect(recipeLineCost(q('0.2'), 'l', '0.006' as UnitCost, WATER)).toBe('1.2')
  })
})

describe('conversions', () => {
  it('follow pack chains both ways', () => {
    expect(toBase(q('1.5'), carton, WATER)).toBe('18000')
    expect(fromBase(q('18000'), carton, WATER)).toBe('1.5')
    expect(unitFactor({ pack: 'box' }, CUPS)).toBe('1000')
    expect(costPerBaseUnit(money('150'), q('1'), { pack: 'box' }, CUPS)).toBe('0.15')
    expect(fromBase(q('1'), carton, WATER)).toBe('0.000083') // 1/12000, to 6 decimals
  })

  it('use the exact standard factors', () => {
    const mass: MaterialUnits = { dimension: 'mass' }
    expect(toBase(q('1.5'), 'kg', mass)).toBe('1500')
    expect(toBase(q('250'), 'mg', mass)).toBe('0.25')
    expect(fromBase(q('1500'), 'kg', mass)).toBe('1.5')
    expect(toBase(q('2.5'), 'm', { dimension: 'length' })).toBe('2500')
    expect(toBase(q('3'), 'cm', { dimension: 'length' })).toBe('30')
    expect(toBase(q('1.25'), 'm2', { dimension: 'area' })).toBe('12500')
    expect(toBase(q('50'), 'mm2', { dimension: 'area' })).toBe('0.5')
    expect(toBase(q('1.5'), 'h', { dimension: 'time' })).toBe('5400')
  })

  it('multiply a long chain exactly (past 64 digits) and round once', () => {
    // Five 13-digit factors and a 7-digit quantity: a 72-digit product, rounded to 6 decimals.
    const factor = '1.123456789012'
    const nested: MaterialUnits = {
      dimension: 'mass',
      packs: ['a', 'b', 'c', 'd', 'e'].map((id, i, ids) => ({
        id,
        qty: factor,
        of: i < ids.length - 1 ? { pack: ids[i + 1]! } : ('kg' as const),
      })),
    }
    const qty = '1.123456'
    const Big = Decimal.clone({ precision: 1000, toExpNeg: -9e15, toExpPos: 9e15 })
    let exact = new Big(qty).times(1000)
    for (let i = 0; i < 5; i++) exact = exact.times(factor)
    expect(toBase(q(qty), { pack: 'a' }, nested)).toBe(
      exact.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toString(),
    )
  })

  it('costs machine time per second, exact enough to show', () => {
    const time: MaterialUnits = { dimension: 'time' }
    const perSecond = costPerBaseUnit(money('12'), q('1'), 'h', time)
    expect(perSecond).toBe('0.003333333333')
    const ninetyMinutes = recipeLineCost(q('90'), 'min', perSecond, time)
    expect(ninetyMinutes).toBe('17.9999999982')
    expect(roundForDisplay(ninetyMinutes, 2)).toBe('18.00')
  })

  it('cross dimensions only through an explicit factor', () => {
    expect(toBase(q('200'), 'ml', OIL)).toBe('184')
    expect(toBase(q('1'), { pack: 'bottle' }, OIL)).toBe('1380')
    expect(toBase(q('2'), 'kg', OIL)).toBe('2000')
    const patties: MaterialUnits = {
      dimension: 'mass',
      crossFactors: [{ unit: 'piece', qty: '150', of: 'g' }],
    }
    expect(toBase(q('2'), 'piece', patties)).toBe('300')
    expect(() => toBase(q('1'), 'piece', OIL)).toThrow(RangeError)
    expect(() => toBase(q('1'), 'kg', WATER)).toThrow(RangeError)
    const broken: MaterialUnits = {
      dimension: 'mass',
      crossFactors: [
        { unit: 'lb' as 'kg', qty: '453.59237', of: 'g' },
        { unit: 'l', qty: '920', of: 'gram' as 'g' },
      ],
    }
    expect(() => toBase(q('1'), 'l', broken)).toThrow(RangeError)
  })

  it('throw on packs they cannot resolve', () => {
    expect(() => toBase(q('1'), { pack: 'crate' }, WATER)).toThrow(/Unknown pack/)
    const loop: MaterialUnits = {
      dimension: 'count',
      packs: [
        { id: 'a', qty: '2', of: { pack: 'b' } },
        { id: 'b', qty: '2', of: { pack: 'a' } },
      ],
    }
    expect(() => toBase(q('1'), { pack: 'a' }, loop)).toThrow(/loop/)
    const twice: MaterialUnits = {
      dimension: 'count',
      packs: [
        { id: 'a', qty: '2', of: 'piece' },
        { id: 'a', qty: '3', of: 'piece' },
      ],
    }
    expect(() => toBase(q('1'), { pack: 'a' }, twice)).toThrow(/Duplicate/)
    expect(() => toBase(q('1'), 'lb' as 'kg', { dimension: 'mass' })).toThrow(/Unknown unit/)
    const zero: MaterialUnits = { dimension: 'count', packs: [{ id: 'a', qty: '0', of: 'piece' }] }
    expect(() => toBase(q('1'), { pack: 'a' }, zero)).toThrow(RangeError)
  })

  it('refuse a cost from no quantity or a negative price', () => {
    expect(() => costPerBaseUnit(money('72'), q('0'), carton, WATER)).toThrow(RangeError)
    expect(() => costPerBaseUnit(money('-72'), q('1'), carton, WATER)).toThrow(RangeError)
    expect(costPerBaseUnit('0' as CostAmount, q('1'), carton, WATER)).toBe('0')
  })
})

/** Random valid chains: each pack holds a whole number of an earlier pack or of a standard unit. */
const chainArb = fc
  .array(
    fc.record({
      qty: fc.integer({ min: 1, max: 500 }),
      parent: fc.nat(),
      unit: fc.constantFrom('ml' as const, 'l' as const),
    }),
    { minLength: 1, maxLength: 5 },
  )
  .map((specs) => {
    const packs: PackDefinition[] = specs.map((spec, i) => ({
      id: `p${i}`,
      qty: String(spec.qty),
      of: i > 0 && spec.parent % 2 === 0 ? { pack: `p${spec.parent % i}` } : spec.unit,
    }))
    return { dimension: 'volume', packs } satisfies MaterialUnits
  })
const qtyArb = fc
  .tuple(fc.integer({ min: 0, max: 10_000 }), fc.integer({ min: 0, max: 999 }))
  .map(([whole, thousandths]) => q(`${whole}.${String(thousandths).padStart(3, '0')}`))

describe('conversion properties', () => {
  it('valid generated chains resolve, and a pack is its qty times what it holds', () => {
    fc.assert(
      fc.property(chainArb, (units) => {
        expect(validateMaterialUnits(units)).toEqual([])
        for (const pack of units.packs) {
          const holds = toDec(unitFactor(pack.of, units))
          expect(toDec(unitFactor({ pack: pack.id }, units)).eq(holds.times(pack.qty))).toBe(true)
        }
      }),
    )
  })

  it('toBase is exact and additive, and fromBase undoes it (whole-number packs)', () => {
    fc.assert(
      fc.property(chainArb, qtyArb, qtyArb, fc.nat(), (units, a, b, pick) => {
        const unit = { pack: `p${pick % units.packs.length}` }
        const sum = q(toDec(a).plus(toDec(b)).toString())
        const [baseA, baseB] = [toBase(a, unit, units), toBase(b, unit, units)]
        expect(
          toDec(baseA)
            .plus(toDec(baseB))
            .eq(toDec(toBase(sum, unit, units))),
        ).toBe(true)
        expect(toDec(fromBase(baseA, unit, units)).eq(toDec(a))).toBe(true)
      }),
    )
  })

  it('cost per base unit times the base quantity gives the price back (property)', () => {
    fc.assert(
      fc.property(chainArb, qtyArb, qtyArb, fc.nat(), (units, price, qty, pick) => {
        if (toDec(qty).isZero()) return
        const unit = { pack: `p${pick % units.packs.length}` }
        const perBase = costPerBaseUnit(money(price), qty, unit, units)
        const back = recipeLineCost(qty, unit, perBase, units)
        const baseQty = toDec(toBase(qty, unit, units))
        // Only the cost per base unit is rounded (to 12 decimals): the error is at most half of
        // its last digit per base unit.
        const bound = baseQty.times('0.0000000000005').plus('0.0000000000005')
        expect(toDec(back).minus(toDec(price)).abs().lte(bound)).toBe(true)
      }),
    )
  })
})
