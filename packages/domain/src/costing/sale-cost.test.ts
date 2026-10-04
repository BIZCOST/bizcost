import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { toDec } from '../numbers/decimal'
import type { OwnerTimePart } from './product-cost'
import {
  averageAsOf,
  fillSaleLineCost,
  saleLineCost,
  type PostedPurchaseLine,
  type SaleItemMaterials,
  type SaleLineCost,
} from './sale-cost'

// The cost of what was sold (M3 Step 1, D-222; Q5 of D-218): what one unit uses (the recipe ÷ its
// yield, or an item bought ready to sell), each material at the D-115 average as of the sale's day
// from the purchases posted when it is finalized, "no price yet" (null, never 0) filled once, the
// owner's time without a team, a refund as the mirror of its sale. The owner's Spanish Latte is the
// golden test; the properties: a refund mirrors its sale, and a cost once set never changes.

const SALE_DAY = '2026-10-03'
let seq = 0
/** A posted purchase line: `qty` base units for `value`, on `day`, its own purchase unless said. */
const bought = (
  day: string,
  qty: string,
  value: string,
  purchaseId?: string,
): PostedPurchaseLine => {
  seq += 1
  return { purchaseId: purchaseId ?? `p${seq}`, businessDate: day, seq: String(seq), qty, value }
}
const team: OwnerTimePart = { state: 'team' }

// What the café paid on 1 Oct (D-146's real purchases): 2 bags of beans (2,000 g) for 130, a carton of
// milk (12,000 ml) for 72, a box of 24 cans of condensed milk (9,240 ml) for 95, 100 cups for 25, 100
// lids for 9 and 200 straws for 7.
const cafePurchases = () =>
  new Map<string, PostedPurchaseLine[]>([
    ['beans', [bought('2026-10-01', '2000', '130')]],
    ['milk', [bought('2026-10-01', '12000', '72')]],
    ['condensed', [bought('2026-10-01', '9240', '95')]],
    ['cup', [bought('2026-10-01', '100', '25')]],
    ['lid', [bought('2026-10-01', '100', '9')]],
    ['straw', [bought('2026-10-01', '200', '7')]],
  ])
const latte: SaleItemMaterials = {
  basis: 'recipe',
  yieldQty: '1',
  lines: [
    { materialId: 'beans', baseQty: '18' },
    { materialId: 'milk', baseQty: '200' },
    { materialId: 'condensed', baseQty: '25' },
    { materialId: 'cup', baseQty: '1' },
    { materialId: 'lid', baseQty: '1' },
    { materialId: 'straw', baseQty: '1' },
  ],
}

describe('the Spanish Latte sold on 3 Oct', () => {
  it('its materials: 3.002034632035 a cup, each at the average of its purchases', () => {
    const cost = saleLineCost({
      qty: '1',
      day: SALE_DAY,
      materials: latte,
      purchases: cafePurchases(),
      ownerTime: team,
    })
    expect(cost.cost).toBe('3.002034632035')
    expect(cost.basis).toBe('recipe')
    expect(cost.time).toEqual({ state: 'team' })
    expect(
      cost.materials.map((m) => [m.materialId, m.baseQty, m.unitCost, m.cost, m.basis]),
    ).toEqual([
      ['beans', '18', '0.065', '1.17', 'purchases_90_days'],
      ['milk', '200', '0.006', '1.2', 'purchases_90_days'],
      // 25 × 95 ÷ 9 240, divided once.
      ['condensed', '25', '0.010281385281', '0.257034632035', 'purchases_90_days'],
      ['cup', '1', '0.25', '0.25', 'purchases_90_days'],
      ['lid', '1', '0.09', '0.09', 'purchases_90_days'],
      ['straw', '1', '0.035', '0.035', 'purchases_90_days'],
    ])
  })

  it('keeps 3.002034632035 when a milk purchase dated 5 Oct is also posted: its day is 3 Oct', () => {
    const purchases = cafePurchases()
    purchases.get('milk')!.push(bought('2026-10-05', '12000', '96'))
    const cost = saleLineCost({
      qty: '1',
      day: SALE_DAY,
      materials: latte,
      purchases,
      ownerTime: team,
    })
    expect(cost.cost).toBe('3.002034632035')
  })

  it('40 lattes cost 40 × the cup’s materials, each material divided once', () => {
    const cost = saleLineCost({
      qty: '40',
      day: SALE_DAY,
      materials: latte,
      purchases: cafePurchases(),
      ownerTime: team,
    })
    // 1 000 × 95 ÷ 9 240 = 10.281385281385 (once, not 40 × 0.257034632035 = 10.2813852814).
    expect(cost.materials[2]?.cost).toBe('10.281385281385')
    expect(cost.cost).toBe('120.081385281385')
  })
})

describe('the D-115 average as of the sale’s day', () => {
  it('the purchases dated in the 90 days ending that day', () => {
    const lines = [
      bought('2026-07-05', '10', '50'), // 90 days before 3 Oct: outside
      bought('2026-07-06', '10', '60'), // the first day of the window
      bought('2026-10-03', '10', '70'),
      bought('2026-10-04', '10', '500'), // after the day: never in it
    ]
    expect(averageAsOf(SALE_DAY, lines)).toEqual({
      basis: 'purchases_90_days',
      value: '130',
      qty: '20',
    })
  })

  it('else the last purchase on or before it, its lines together; else the first after it', () => {
    const last = [
      bought('2026-05-01', '10', '50'),
      bought('2026-06-01', '4', '20', 'june'),
      bought('2026-06-01', '6', '33', 'june'),
      bought('2026-12-01', '10', '900'),
    ]
    expect(averageAsOf(SALE_DAY, last)).toEqual({ basis: 'last_purchase', value: '53', qty: '10' })
    const later = [bought('2026-11-20', '10', '80'), bought('2026-10-20', '5', '30')]
    expect(averageAsOf(SALE_DAY, later)).toEqual({ basis: 'first_purchase', value: '30', qty: '5' })
    expect(averageAsOf(SALE_DAY, [])).toBeNull()
  })

  it('of two purchases on the same day, the one posted later; fully returned lines never count', () => {
    const lines = [
      { purchaseId: 'b', businessDate: '2026-05-01', seq: '10', qty: '1', value: '9' },
      { purchaseId: 'a', businessDate: '2026-05-01', seq: '9', qty: '1', value: '7' },
      { purchaseId: 'c', businessDate: '2026-05-02', seq: '11', qty: '0', value: '0' },
    ]
    expect(averageAsOf(SALE_DAY, lines)).toEqual({ basis: 'last_purchase', value: '9', qty: '1' })
  })
})

describe('what one unit uses', () => {
  it('a recipe that makes 12 slices: each slice uses a twelfth, rounded once to 6 decimals', () => {
    const cost = saleLineCost({
      qty: '1',
      day: SALE_DAY,
      materials: {
        basis: 'recipe',
        yieldQty: '12',
        lines: [{ materialId: 'flour', baseQty: '500' }],
      },
      purchases: new Map([['flour', [bought('2026-10-01', '1000', '5')]]]),
      ownerTime: team,
    })
    expect(cost.materials[0]).toMatchObject({ baseQty: '41.666667', cost: '0.208333335' })
  })

  it('an item bought ready to sell: its material’s base units in one unit (D-117)', () => {
    const cost = saleLineCost({
      qty: '3',
      day: SALE_DAY,
      materials: { basis: 'resale', materialId: 'can', baseQty: '1' },
      purchases: new Map([['can', [bought('2026-10-01', '24', '12')]]]),
      ownerTime: team,
    })
    expect(cost).toMatchObject({ basis: 'resale', cost: '1.5' })
  })

  it('nothing to cost: no materials, no line cost (never 0)', () => {
    for (const materials of [
      { basis: 'none' } as const,
      { basis: 'recipe', yieldQty: '1', lines: [] } as const,
    ]) {
      const cost = saleLineCost({
        qty: '1',
        day: SALE_DAY,
        materials,
        purchases: new Map(),
        ownerTime: team,
      })
      expect(cost).toEqual({ basis: 'none', materials: [], cost: null, time: { state: 'team' } })
    }
  })
})

describe('no price yet, filled once (Q5)', () => {
  it('a sale before any purchase shows no price yet; the first purchase fills it once, then it never moves', () => {
    const sold = saleLineCost({
      qty: '1',
      day: SALE_DAY,
      materials: latte,
      purchases: new Map([...cafePurchases()].filter(([id]) => id !== 'straw')),
      ownerTime: team,
    })
    expect(sold.cost).toBeNull()
    expect(sold.materials[5]).toEqual({
      materialId: 'straw',
      baseQty: '1',
      unitCost: null,
      cost: null,
      basis: null,
    })
    // Nothing new: the same snapshot.
    expect(fillSaleLineCost(sold, { day: SALE_DAY, purchases: new Map(), hourlyRate: null })).toBe(
      sold,
    )
    // The first straws, bought on 20 Oct, price it (after its day: the first purchase).
    const filled = fillSaleLineCost(sold, {
      day: SALE_DAY,
      purchases: new Map([
        ['straw', [bought('2026-10-20', '200', '7')]],
        ['milk', [bought('2026-10-02', '1', '1000')]],
      ]),
      hourlyRate: null,
    })
    expect(filled.materials[5]).toMatchObject({ cost: '0.035', basis: 'first_purchase' })
    // Milk was priced at posting: a later purchase never changes it.
    expect(filled.materials[1]).toBe(sold.materials[1])
    expect(filled.cost).toBe('3.002034632035')
    const again = fillSaleLineCost(filled, {
      day: SALE_DAY,
      purchases: new Map([['straw', [bought('2026-10-02', '1', '99')]]]),
      hourlyRate: null,
    })
    expect(again).toBe(filled)
  })

  it('the owner’s time: minutes × qty × hourly rate ÷ 60; without a rate it waits, then fills once', () => {
    const solo = (hourlyRate: string | null): OwnerTimePart => ({
      state: 'solo',
      minutes: '60',
      hourlyRate,
    })
    const cake = { basis: 'none' } as const
    expect(
      saleLineCost({
        qty: '2',
        day: SALE_DAY,
        materials: cake,
        purchases: new Map(),
        ownerTime: solo('40'),
      }).time,
    ).toEqual({ state: 'applied', minutes: '120', hourlyRate: '40', cost: '80' })
    const waiting = saleLineCost({
      qty: '1',
      day: SALE_DAY,
      materials: cake,
      purchases: new Map(),
      ownerTime: solo(null),
    })
    expect(waiting.time).toEqual({ state: 'rate_not_set', minutes: '60' })
    const filled = fillSaleLineCost(waiting, {
      day: SALE_DAY,
      purchases: new Map(),
      hourlyRate: '40',
    })
    expect(filled.time).toEqual({ state: 'applied', minutes: '60', hourlyRate: '40', cost: '40' })
    expect(
      fillSaleLineCost(filled, { day: SALE_DAY, purchases: new Map(), hourlyRate: '90' }),
    ).toBe(filled)
    expect(
      saleLineCost({
        qty: '1',
        day: SALE_DAY,
        materials: cake,
        purchases: new Map(),
        ownerTime: { state: 'solo', minutes: null, hourlyRate: '40' },
      }).time,
    ).toEqual({ state: 'none' })
  })

  it('refuses a quantity of zero, a yield of zero and negative inputs', () => {
    const input = {
      qty: '1',
      day: SALE_DAY,
      materials: latte,
      purchases: cafePurchases(),
      ownerTime: team,
    }
    expect(() => saleLineCost({ ...input, qty: '0' })).toThrow(RangeError)
    expect(() => saleLineCost({ ...input, materials: { ...latte, yieldQty: '0' } })).toThrow(
      RangeError,
    )
    expect(() => saleLineCost({ ...input, day: '3 Oct' })).toThrow(RangeError)
    expect(() =>
      averageAsOf(SALE_DAY, [
        { purchaseId: 'x', businessDate: SALE_DAY, seq: '1', qty: '1', value: '-1' },
      ]),
    ).toThrow(RangeError)
  })
})

// ---------------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------------

const decimal = (max: number, places: number) =>
  fc
    .tuple(fc.integer({ min: 0, max }), fc.integer({ min: 0, max: 10 ** places - 1 }))
    .map(([whole, fraction]) =>
      places === 0 ? String(whole) : `${whole}.${String(fraction).padStart(places, '0')}`,
    )
const positive = (max: number, places: number) =>
  decimal(max, places).filter((value) => toDec(value).gt(0))
const MATERIALS = ['a', 'b', 'c', 'd']
const day = fc.integer({ min: 0, max: 400 }).map((offset) => {
  const date = new Date(Date.UTC(2026, 0, 1) + offset * 86_400_000)
  return date.toISOString().slice(0, 10)
})
const purchaseLine: fc.Arbitrary<PostedPurchaseLine> = fc.record({
  purchaseId: fc.constantFrom('p1', 'p2', 'p3', 'p4', 'p5'),
  businessDate: day,
  seq: fc.integer({ min: 1, max: 999 }).map(String),
  qty: decimal(500, 3),
  value: decimal(900, 4),
})
const purchases = fc
  .array(fc.tuple(fc.constantFrom(...MATERIALS), purchaseLine), { maxLength: 12 })
  .map((entries) => {
    const map = new Map<string, PostedPurchaseLine[]>()
    for (const [id, line] of entries) map.set(id, [...(map.get(id) ?? []), line])
    return map
  })
const materials: fc.Arbitrary<SaleItemMaterials> = fc.oneof(
  fc.record({
    basis: fc.constant('recipe' as const),
    yieldQty: positive(12, 2),
    lines: fc.array(
      fc.record({ materialId: fc.constantFrom(...MATERIALS), baseQty: decimal(800, 3) }),
      { maxLength: 4 },
    ),
  }),
  fc.record({
    basis: fc.constant('resale' as const),
    materialId: fc.constantFrom(...MATERIALS),
    baseQty: positive(50, 2),
  }),
  fc.constant({ basis: 'none' as const }),
)
const ownerTime: fc.Arbitrary<OwnerTimePart> = fc.oneof(
  fc.constant({ state: 'team' as const }),
  fc.record({
    state: fc.constant('solo' as const),
    minutes: fc.option(decimal(120, 2), { nil: null }),
    hourlyRate: fc.option(decimal(300, 2), { nil: null }),
  }),
)

const negate = (value: string) => (toDec(value).isZero() ? value : `-${value}`)
/** A snapshot with every quantity and amount negated (what a refund of it must be). */
function negated(cost: SaleLineCost): SaleLineCost {
  return {
    basis: cost.basis,
    materials: cost.materials.map((m) => ({
      ...m,
      baseQty: negate(m.baseQty),
      cost: m.cost === null ? null : (negate(m.cost) as typeof m.cost),
    })),
    cost: cost.cost === null ? null : (negate(cost.cost) as typeof cost.cost),
    time:
      cost.time.state === 'applied'
        ? {
            ...cost.time,
            minutes: negate(cost.time.minutes),
            cost: negate(cost.time.cost) as typeof cost.time.cost,
          }
        : cost.time.state === 'rate_not_set'
          ? { ...cost.time, minutes: negate(cost.time.minutes) }
          : cost.time,
  }
}

describe('properties of the cost of what was sold', () => {
  it('a refund mirrors its sale: every quantity and cost negated', () => {
    fc.assert(
      fc.property(
        positive(30, 3),
        day,
        materials,
        purchases,
        ownerTime,
        (qty, at, uses, bought, time) => {
          const sold = saleLineCost({
            qty,
            day: at,
            materials: uses,
            purchases: bought,
            ownerTime: time,
          })
          const refund = saleLineCost({
            qty: `-${qty}`,
            day: at,
            materials: uses,
            purchases: bought,
            ownerTime: time,
          })
          expect(refund).toEqual(negated(sold))
        },
      ),
    )
  })

  it('a cost, once set, never changes; what was missing is filled as the purchases then price it', () => {
    fc.assert(
      fc.property(
        positive(30, 3),
        day,
        materials,
        purchases,
        purchases,
        ownerTime,
        fc.option(decimal(300, 2), { nil: null }),
        (qty, at, uses, atPosting, later, time, rate) => {
          const sold = saleLineCost({
            qty,
            day: at,
            materials: uses,
            purchases: atPosting,
            ownerTime: time,
          })
          const filled = fillSaleLineCost(sold, { day: at, purchases: later, hourlyRate: rate })
          const priced = saleLineCost({
            qty,
            day: at,
            materials: uses,
            purchases: later,
            ownerTime: time,
          })
          sold.materials.forEach((material, i) => {
            if (material.cost !== null) expect(filled.materials[i]).toEqual(material)
            else expect(filled.materials[i]).toEqual(priced.materials[i])
          })
          if (sold.cost !== null) expect(filled.cost).toBe(sold.cost)
          if (sold.time.state !== 'rate_not_set') expect(filled.time).toEqual(sold.time)
          else if (rate !== null)
            expect(filled.time).toMatchObject({ state: 'applied', hourlyRate: rate })
          // Filling again with anything changes nothing that is set.
          const again = fillSaleLineCost(filled, { day: at, purchases: atPosting, hourlyRate: '1' })
          filled.materials.forEach((material, i) => {
            if (material.cost !== null) expect(again.materials[i]).toBe(material)
          })
        },
      ),
    )
  })
})
