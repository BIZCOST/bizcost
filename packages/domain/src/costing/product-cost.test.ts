import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { VAT_CATEGORIES, type VatCategory } from '../catalog/keys'
import { toDec } from '../numbers/decimal'
import type { RunningCostsPart } from './cost-share'
import {
  costCompleteFor,
  hoursAndMinutes,
  INCOMPLETE_REASONS,
  missesOnlyOptionalMaterials,
  ownerTimeCost,
  priceBeforeVat,
  productCost,
  saleVatRate,
  type MaterialsPart,
  type OwnerTimePart,
  type ProductCostInput,
  type SalePrice,
} from './product-cost'

// A product's cost for one unit sold and its margin (M2 Step 6; D-119, D-121, D-178, D-202): the
// owner's examples as golden tests (the Spanish Latte in a café with a team, the home baker's cake
// slice with her own time, the owner's AED 400 service), every state of each line, and fast-check
// properties: the total is the exact sum of its parts, the margin and the total make the price before
// VAT exactly, a missing part never counts as 0 and always says why, and the share awaiting sales is
// never a reason the cost is incomplete while it keeps the total "before running costs".

const SALE: SalePrice = {
  price: '18',
  priceIncludesVat: false,
  vatCategory: 'standard',
  vatRegistered: true,
}
const PRICED = (perUnit: string): MaterialsPart => ({
  state: 'on',
  perUnit,
  lineCount: 6,
  unpricedLines: 0,
  tooLarge: false,
})
const NO_LINES: MaterialsPart = {
  state: 'on',
  perUnit: null,
  lineCount: 0,
  unpricedLines: 0,
  tooLarge: false,
}
const TEAM: OwnerTimePart = { state: 'team' }
/** M2: running costs are on, and there are no sales yet (Phase 3). */
const AWAITING: RunningCostsPart = { state: 'on', costs: '20000', sales: null }
/** Phase 3: the owner's example, costs of 20 000 and sales of 80 000 in the month (25 %). */
const SOLD: RunningCostsPart = { state: 'on', costs: '20000', sales: '80000' }

describe('the owner’s examples', () => {
  it('the Spanish Latte in M2: its materials, and running costs worked out once sales are recorded', () => {
    const cost = productCost({
      materials: PRICED('3.002034632035'),
      runningCosts: AWAITING,
      ownerTime: TEAM,
      sale: SALE,
    })
    expect(cost).toEqual({
      materials: '3.002034632035',
      runningCosts: { state: 'awaiting_sales', rate: null, share: null },
      ownerTime: { state: 'team', amount: null },
      total: '3.002034632035',
      // Before running costs: never final, and nothing the owner can add for it (D-202).
      beforeRunningCosts: true,
      tooLarge: false,
      reasons: [],
      complete: true,
      priceBeforeVat: '18',
      margin: '14.997965367965',
      marginPercent: '83.322029822028',
    })
  })

  it('once sales are recorded: costs 20 000 ÷ sales 80 000 = 25 %, so the AED 18 latte carries 4.50', () => {
    const cost = productCost({
      materials: PRICED('3.002034632035'),
      runningCosts: SOLD,
      ownerTime: TEAM,
      sale: { ...SALE, vatRegistered: false },
    })
    expect(cost).toEqual({
      materials: '3.002034632035',
      runningCosts: { state: 'applied', rate: '0.25', share: '4.5' },
      ownerTime: { state: 'team', amount: null },
      total: '7.502034632035',
      beforeRunningCosts: false,
      tooLarge: false,
      reasons: [],
      complete: true,
      priceBeforeVat: '18',
      margin: '10.497965367965',
      marginPercent: '58.322029822028',
    })
    // With its VAT in the price of a VAT-registered business: the share is of 17.142857142857.
    expect(
      productCost({
        materials: PRICED('3.002034632035'),
        runningCosts: SOLD,
        ownerTime: TEAM,
        sale: { ...SALE, priceIncludesVat: true },
      }).runningCosts,
    ).toEqual({ state: 'applied', rate: '0.25', share: '4.285714285714' })
  })

  it('a AED 400 service carries 100, with or without materials', () => {
    for (const materials of [NO_LINES, PRICED('35'), { state: 'off' } as const]) {
      const cost = productCost({
        materials,
        runningCosts: SOLD,
        ownerTime: { state: 'solo', minutes: '60', hourlyRate: '120' },
        sale: { ...SALE, price: '400', vatRegistered: false },
      })
      expect(cost.runningCosts, JSON.stringify(materials)).toEqual({
        state: 'applied',
        rate: '0.25',
        share: '100',
      })
    }
  })

  it('the home baker’s cake slice: 1.075 of materials and 10 minutes at 45, before running costs', () => {
    const cost = productCost({
      materials: { state: 'on', perUnit: '1.075', lineCount: 4, unpricedLines: 0, tooLarge: false },
      runningCosts: { state: 'on', costs: '550', sales: null },
      ownerTime: { state: 'solo', minutes: '10', hourlyRate: '45' },
      sale: { price: '15', priceIncludesVat: false, vatCategory: 'standard', vatRegistered: false },
    })
    expect(cost).toEqual({
      materials: '1.075',
      runningCosts: { state: 'awaiting_sales', rate: null, share: null },
      ownerTime: { state: 'applied', amount: '7.5' },
      total: '8.575',
      beforeRunningCosts: true,
      tooLarge: false,
      reasons: [],
      complete: true,
      priceBeforeVat: '15',
      margin: '6.425',
      marginPercent: '42.833333333333',
    })
  })

  it('a price with VAT in it loses the VAT only for a VAT-registered business', () => {
    const withVat = { ...SALE, priceIncludesVat: true }
    expect(priceBeforeVat(withVat)).toBe('17.142857142857')
    expect(priceBeforeVat({ ...withVat, vatRegistered: false })).toBe('18')
    expect(priceBeforeVat({ ...withVat, vatCategory: 'zero_rated' })).toBe('18')
    expect(priceBeforeVat({ ...withVat, vatCategory: 'exempt' })).toBe('18')
    expect(priceBeforeVat({ ...withVat, price: '21' })).toBe('20')
    expect(priceBeforeVat({ ...withVat, price: null })).toBeNull()
    expect(saleVatRate('standard')).toBe('5')
    expect(saleVatRate('zero_rated')).toBe('0')
    // The margin % is taken from the exact price before VAT: (21 × 100 − 5 × 105) ÷ 21 = 75.
    const cost = productCost({
      materials: PRICED('5'),
      runningCosts: { state: 'off' },
      ownerTime: TEAM,
      sale: { ...withVat, price: '21' },
    })
    expect(cost).toMatchObject({ priceBeforeVat: '20', margin: '15', marginPercent: '75' })
  })

  it('the owner’s time, divided once', () => {
    expect(ownerTimeCost('10', '45')).toBe('7.5')
    expect(ownerTimeCost('7', '50')).toBe('5.833333333333')
  })
})

describe('each line’s states, never 0 for what is missing', () => {
  const base = (over: Partial<ProductCostInput>): ProductCostInput => ({
    materials: PRICED('4'),
    runningCosts: AWAITING,
    ownerTime: TEAM,
    sale: SALE,
    ...over,
  })

  it('running costs: off, no price, awaiting sales, none, applied', () => {
    // Neither Running Costs nor Expenses on: nothing to share, and the total is final.
    expect(productCost(base({ runningCosts: { state: 'off' } }))).toMatchObject({
      runningCosts: { state: 'off', rate: null, share: null },
      total: '4',
      beforeRunningCosts: false,
      complete: true,
    })
    // No price: no share can be worked out by it, and it says so ("add its price"), awaiting sales
    // or not.
    for (const runningCosts of [AWAITING, SOLD]) {
      expect(productCost(base({ runningCosts, sale: { ...SALE, price: null } }))).toMatchObject({
        runningCosts: { state: 'no_price', rate: null, share: null },
        total: '4',
        beforeRunningCosts: true,
        reasons: ['no_price'],
        complete: false,
        margin: null,
      })
    }
    // Awaiting sales (M2): not a reason, whatever the month's costs; the total is before them.
    for (const costs of ['20000', '0', '-150']) {
      expect(
        productCost(base({ runningCosts: { state: 'on', costs, sales: null } })),
      ).toMatchObject({
        runningCosts: { state: 'awaiting_sales', rate: null, share: null },
        total: '4',
        beforeRunningCosts: true,
        reasons: [],
        complete: true,
        margin: '14',
      })
    }
    // Sales that come to nothing or less: nothing to divide by, still awaiting sales.
    for (const sales of ['0', '-10']) {
      expect(
        productCost(base({ runningCosts: { state: 'on', costs: '20000', sales } })).runningCosts,
      ).toEqual({ state: 'awaiting_sales', rate: null, share: null })
    }
    // Costs of zero or less (a reversal counted in a later month): nothing to share, 0 and final.
    for (const costs of ['0', '-150']) {
      expect(
        productCost(base({ runningCosts: { state: 'on', costs, sales: '80000' } })),
      ).toMatchObject({
        runningCosts: { state: 'none', rate: '0', share: '0' },
        total: '4',
        beforeRunningCosts: false,
        complete: true,
      })
    }
    // Applied: 18 × 20 000 ÷ 80 000.
    expect(
      productCost(base({ runningCosts: SOLD, sale: { ...SALE, vatRegistered: false } })),
    ).toMatchObject({
      runningCosts: { state: 'applied', rate: '0.25', share: '4.5' },
      total: '8.5',
      beforeRunningCosts: false,
      complete: true,
      margin: '9.5',
    })
    // A price of 0 carries nothing, and is not "no price".
    expect(
      productCost(base({ runningCosts: SOLD, sale: { ...SALE, price: '0' } })).runningCosts,
    ).toEqual({ state: 'applied', rate: '0.25', share: '0' })
  })

  it('the share never depends on what goes into it: a product without a recipe keeps its own reason', () => {
    expect(productCost(base({ materials: NO_LINES }))).toMatchObject({
      runningCosts: { state: 'awaiting_sales' },
      total: null,
      reasons: ['no_recipe'],
      complete: false,
    })
    expect(
      productCost(
        base({
          materials: {
            state: 'on',
            perUnit: null,
            lineCount: 2,
            unpricedLines: 2,
            tooLarge: false,
          },
        }),
      ),
    ).toMatchObject({
      runningCosts: { state: 'awaiting_sales' },
      total: null,
      reasons: ['unpriced_materials'],
    })
    // Once sales are in, even a product without a priced recipe carries its share.
    expect(productCost(base({ materials: NO_LINES, runningCosts: SOLD }))).toMatchObject({
      runningCosts: { state: 'applied', share: '4.5' },
      total: '4.5',
      reasons: ['no_recipe'],
      complete: false,
    })
  })

  it('the owner’s time: with a team, no minutes, no hourly rate yet, applied', () => {
    expect(productCost(base({ ownerTime: TEAM })).ownerTime).toEqual({
      state: 'team',
      amount: null,
    })
    expect(
      productCost(base({ ownerTime: { state: 'solo', minutes: null, hourlyRate: '45' } })),
    ).toMatchObject({ ownerTime: { state: 'none', amount: null }, total: '4', complete: true })
    expect(
      productCost(base({ ownerTime: { state: 'solo', minutes: '10', hourlyRate: null } })),
    ).toMatchObject({
      ownerTime: { state: 'rate_not_set', amount: null },
      total: '4',
      reasons: ['hourly_rate_not_set'],
      complete: false,
    })
  })

  it('a service without materials misses only what is optional (D-186, D-200, D-203)', () => {
    const mine: OwnerTimePart = { state: 'solo', minutes: '60', hourlyRate: '100' }
    const service = (over: Partial<ProductCostInput>) =>
      productCost(base({ ownerTime: mine, ...over }))
    // Its time counts; its share of running costs waits for sales like every product's.
    const waiting = service({ materials: NO_LINES })
    expect(waiting).toMatchObject({
      materials: null,
      runningCosts: { state: 'awaiting_sales' },
      total: '100',
      reasons: ['no_recipe'],
      complete: false,
    })
    expect(missesOnlyOptionalMaterials('service', waiting)).toBe(true)
    // Shown complete: its materials are only a hint (D-203).
    expect(costCompleteFor('service', waiting)).toBe(true)
    expect(costCompleteFor('product', waiting)).toBe(false)
    expect(
      missesOnlyOptionalMaterials('service', service({ materials: NO_LINES, runningCosts: SOLD })),
    ).toBe(true)
    // With a team, its only line is its share awaiting sales: nothing is missing either (D-203).
    const team = service({ materials: NO_LINES, ownerTime: TEAM })
    expect(team).toMatchObject({ total: null, reasons: ['no_recipe'], beforeRunningCosts: true })
    expect(missesOnlyOptionalMaterials('service', team)).toBe(true)
    expect(costCompleteFor('service', team)).toBe(true)
    // A product without its recipe waits for it; nothing counted at all (nothing shared either), a
    // price missing, or the hourly rate missing: it waits too.
    expect(missesOnlyOptionalMaterials('product', waiting)).toBe(false)
    expect(
      missesOnlyOptionalMaterials(
        'service',
        service({ materials: NO_LINES, ownerTime: TEAM, runningCosts: { state: 'off' } }),
      ),
    ).toBe(false)
    expect(
      missesOnlyOptionalMaterials(
        'service',
        service({ materials: NO_LINES, sale: { ...SALE, price: null } }),
      ),
    ).toBe(false)
    expect(
      missesOnlyOptionalMaterials(
        'service',
        service({ materials: NO_LINES, ownerTime: { ...mine, hourlyRate: null } }),
      ),
    ).toBe(false)
    // With materials, or Materials off (nothing to ask for): complete, nothing to wait for.
    expect(missesOnlyOptionalMaterials('service', service({ materials: PRICED('4') }))).toBe(false)
    const off = service({ materials: { state: 'off' } })
    expect(off).toMatchObject({ reasons: [], complete: true })
    expect(missesOnlyOptionalMaterials('service', off)).toBe(false)
  })

  it('nothing counted: no total and no margin, never 0', () => {
    const cost = productCost({
      materials: { state: 'off' },
      runningCosts: { state: 'off' },
      ownerTime: TEAM,
      sale: SALE,
    })
    expect(cost).toMatchObject({
      total: null,
      beforeRunningCosts: false,
      reasons: ['nothing_counted'],
      complete: false,
      margin: null,
      marginPercent: null,
      priceBeforeVat: '18',
    })
    // Its share awaiting sales is the line that will count (D-203): nothing to add, before running
    // costs, still no total and no margin.
    expect(
      productCost({
        materials: { state: 'off' },
        runningCosts: AWAITING,
        ownerTime: TEAM,
        sale: SALE,
      }),
    ).toMatchObject({
      total: null,
      beforeRunningCosts: true,
      reasons: [],
      complete: true,
      margin: null,
      marginPercent: null,
    })
  })

  it('no price: no margin; a price of 0: a margin and no percent', () => {
    expect(productCost(base({ sale: { ...SALE, price: null } }))).toMatchObject({
      total: '4',
      priceBeforeVat: null,
      margin: null,
      marginPercent: null,
    })
    expect(productCost(base({ sale: { ...SALE, price: '0' } }))).toMatchObject({
      margin: '-4',
      marginPercent: null,
    })
    // A loss is a negative margin (and only grows once running costs are added).
    expect(productCost(base({ sale: { ...SALE, price: '2' } }))).toMatchObject({
      margin: '-2',
      marginPercent: '-100',
      beforeRunningCosts: true,
    })
  })

  it('too large to work out: nothing is totalled', () => {
    const huge = productCost(
      base({
        materials: { state: 'on', perUnit: null, lineCount: 1, unpricedLines: 0, tooLarge: true },
      }),
    )
    expect(huge).toMatchObject({ total: null, tooLarge: true, complete: false, margin: null })
    // A share that does not fit (a huge price over tiny sales).
    const share = productCost(
      base({
        sale: { ...SALE, price: '9999999999999999' },
        runningCosts: { state: 'on', costs: '9999999999999999', sales: '0.01' },
      }),
    )
    expect(share).toMatchObject({
      runningCosts: { state: 'applied', rate: null, share: null },
      total: null,
      tooLarge: true,
      complete: false,
      margin: null,
    })
    // The owner's time at the widest columns' limits.
    const time = productCost(
      base({
        ownerTime: {
          state: 'solo',
          minutes: '999999999999999999.999999',
          hourlyRate: '9999999999999999.9999',
        },
      }),
    )
    expect(time).toMatchObject({
      ownerTime: { state: 'applied', amount: null },
      total: null,
      tooLarge: true,
      complete: false,
    })
  })

  it('a long time as hours and minutes, exact', () => {
    expect(hoursAndMinutes('75')).toEqual({ hours: '1', minutes: '15' })
    expect(hoursAndMinutes('600')).toEqual({ hours: '10', minutes: '0' })
    expect(hoursAndMinutes('12.5')).toEqual({ hours: '0', minutes: '12.5' })
    expect(hoursAndMinutes('90.25')).toEqual({ hours: '1', minutes: '30.25' })
    expect(() => hoursAndMinutes('-1')).toThrow(RangeError)
  })

  it('refuses negative inputs', () => {
    expect(() => productCost(base({ materials: PRICED('-1') }))).toThrow(RangeError)
    expect(() => priceBeforeVat({ ...SALE, price: '-1' })).toThrow(RangeError)
    expect(() => productCost(base({ sale: { ...SALE, price: '-1' } }))).toThrow(RangeError)
    expect(() => ownerTimeCost('-1', '45')).toThrow(RangeError)
  })
})

// ---------------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------------

/** A decimal string with up to `places` decimals, from 0 to `max`. */
const decimalArb = (max: number, places: number) =>
  fc
    .tuple(fc.integer({ min: 0, max }), fc.integer({ min: 0, max: 10 ** places - 1 }))
    .map(([whole, frac]) =>
      places === 0 ? String(whole) : `${whole}.${String(frac).padStart(places, '0')}`,
    )
const positiveArb = (max: number, places: number) =>
  decimalArb(max, places).filter((value) => toDec(value).gt(0))
/** A decimal that may be below zero (a month's costs after a reversal, refunds beyond sales). */
const signedArb = (max: number, places: number) =>
  fc
    .tuple(fc.boolean(), decimalArb(max, places))
    .map(([negative, value]) => (negative && value !== '0' ? `-${value}` : value))

const materialsArb: fc.Arbitrary<MaterialsPart> = fc.oneof(
  { weight: 1, arbitrary: fc.constant({ state: 'off' } as const) },
  {
    weight: 6,
    arbitrary: fc
      .record({
        lineCount: fc.integer({ min: 0, max: 8 }),
        unpricedLines: fc.integer({ min: 0, max: 8 }),
        perUnit: decimalArb(10_000, 12),
      })
      .map(({ lineCount, unpricedLines, perUnit }): MaterialsPart => {
        const unpriced = Math.min(unpricedLines, lineCount)
        return {
          state: 'on',
          lineCount,
          unpricedLines: unpriced,
          // No lines, or every line unpriced: no cost.
          perUnit: lineCount === 0 || unpriced === lineCount ? null : perUnit,
          tooLarge: false,
        }
      }),
  },
)
const runningArb: fc.Arbitrary<RunningCostsPart> = fc.oneof(
  { weight: 1, arbitrary: fc.constant({ state: 'off' } as const) },
  {
    weight: 6,
    arbitrary: fc.record({
      state: fc.constant('on' as const),
      costs: signedArb(100_000, 4),
      // Null: no sales yet (every M2 business).
      sales: fc.option(signedArb(1_000_000, 4), { nil: null }),
    }),
  },
)
const ownerArb: fc.Arbitrary<OwnerTimePart> = fc.oneof(
  { weight: 1, arbitrary: fc.constant({ state: 'team' } as const) },
  {
    weight: 3,
    arbitrary: fc.record({
      state: fc.constant('solo' as const),
      minutes: fc.option(positiveArb(600, 6), { nil: null }),
      hourlyRate: fc.option(positiveArb(1_000, 4), { nil: null }),
    }),
  },
)
const saleArb: fc.Arbitrary<SalePrice> = fc.record({
  price: fc.option(decimalArb(100_000, 4), { nil: null }),
  priceIncludesVat: fc.boolean(),
  vatCategory: fc.constantFrom<VatCategory>(...VAT_CATEGORIES),
  vatRegistered: fc.boolean(),
})
const inputArb: fc.Arbitrary<ProductCostInput> = fc.record({
  materials: materialsArb,
  runningCosts: runningArb,
  ownerTime: ownerArb,
  sale: saleArb,
})

describe('properties', () => {
  it('the total is the exact sum of the parts worked out; nothing missing counts as 0', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const cost = productCost(input)
        const parts = [
          cost.materials,
          cost.runningCosts.state === 'applied' ? cost.runningCosts.share : null,
          cost.ownerTime.amount,
        ].filter((value): value is NonNullable<typeof value> => value !== null)
        if (parts.length === 0) {
          expect(cost.total).toBeNull()
        } else {
          const sum = parts.reduce((acc, value) => acc.plus(toDec(value)), toDec('0'))
          expect(toDec(cost.total!).equals(sum)).toBe(true)
        }
        // A share is worked out only with a price and sales to divide by, and is never negative.
        if (cost.runningCosts.share !== null) {
          expect(input.sale.price).not.toBeNull()
          expect(input.runningCosts.state === 'on' && input.runningCosts.sales).toBeTruthy()
          expect(toDec(cost.runningCosts.share).gte(0)).toBe(true)
        }
        // Complete exactly when nothing that can be added is missing, and something is counted or
        // its share awaits sales (the line that will count, D-203).
        expect(cost.complete).toBe(cost.reasons.length === 0 && !cost.tooLarge)
        if (cost.complete && cost.total === null) {
          expect(cost.runningCosts.state).toBe('awaiting_sales')
        }
        expect([...cost.reasons]).toEqual(
          INCOMPLETE_REASONS.filter((r) => cost.reasons.includes(r)),
        )
      }),
    )
  })

  it('awaiting sales is never a reason, and the total then is before running costs', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const cost = productCost(input)
        const running = input.runningCosts
        const noSales =
          running.state === 'on' && (running.sales === null || !toDec(running.sales).gt(0))
        if (running.state === 'on' && input.sale.price !== null && noSales) {
          expect(cost.runningCosts.state).toBe('awaiting_sales')
          expect(cost.beforeRunningCosts).toBe(true)
          // The same product with running costs off: the same reasons, total and margin (nothing the
          // member can add, and never counted as 0 or anything else), except that nothing counted
          // is not missing while the share will count (D-203).
          const off = productCost({ ...input, runningCosts: { state: 'off' } })
          expect(cost.reasons).toEqual(off.reasons.filter((r) => r !== 'nothing_counted'))
          expect(cost.reasons).not.toContain('nothing_counted')
          expect(cost.total).toBe(off.total)
          expect(cost.margin).toBe(off.margin)
          expect(cost.complete).toBe(cost.reasons.length === 0 && !off.tooLarge)
        }
        // Before running costs exactly while the share applies and is not in the total.
        expect(cost.beforeRunningCosts).toBe(
          cost.runningCosts.state === 'no_price' || cost.runningCosts.state === 'awaiting_sales',
        )
      }),
    )
  })

  it('whatever is missing says why', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const cost = productCost(input)
        const { materials, runningCosts, ownerTime } = input
        if (materials.state === 'on' && materials.unpricedLines > 0) {
          expect(cost.reasons).toContain('unpriced_materials')
        }
        if (materials.state === 'on' && materials.lineCount === 0) {
          expect(cost.reasons).toContain('no_recipe')
        }
        if (
          ownerTime.state === 'solo' &&
          ownerTime.minutes !== null &&
          ownerTime.hourlyRate === null
        ) {
          expect(cost.reasons).toContain('hourly_rate_not_set')
          expect(cost.ownerTime.amount).toBeNull()
        }
        // Without a price, running costs cannot be shared by it: said, never 0.
        expect(cost.reasons.includes('no_price')).toBe(
          runningCosts.state === 'on' && input.sale.price === null,
        )
        if (cost.reasons.includes('no_price')) expect(cost.runningCosts.share).toBeNull()
      }),
    )
  })

  it('margin + total = the price before VAT, exactly; the margin % is margin ÷ price × 100', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const cost = productCost(input)
        if (cost.margin === null) return
        expect(
          toDec(cost.margin).plus(toDec(cost.total!)).equals(toDec(cost.priceBeforeVat!)),
        ).toBe(true)
        if (cost.marginPercent !== null) {
          // margin ÷ price before VAT × 100 = 100 − 100 × total ÷ price before VAT, which is rounded
          // in its 12th decimal: that moves the percent by up to 100 × total × 0.5e-12 ÷ price².
          const before = toDec(cost.priceBeforeVat!)
          const expected = toDec(cost.margin).times(100).dividedBy(before)
          const tolerance = toDec('0.00000000001').plus(
            toDec(cost.total!).plus(1).times('0.0000000001').dividedBy(before.times(before)),
          )
          expect(toDec(cost.marginPercent).minus(expected).abs().lte(tolerance)).toBe(true)
        }
      }),
    )
  })

  it('the price before VAT is never above the price, and equals it unless VAT is taken out', () => {
    fc.assert(
      fc.property(saleArb, (sale) => {
        const before = priceBeforeVat(sale)
        if (sale.price === null) {
          expect(before).toBeNull()
          return
        }
        expect(toDec(before!).lte(toDec(sale.price))).toBe(true)
        const stripped =
          sale.vatRegistered && sale.priceIncludesVat && sale.vatCategory === 'standard'
        if (!stripped) expect(toDec(before!).equals(toDec(sale.price))).toBe(true)
        else {
          // before × 1.05 is the price, within the 12th decimal's rounding.
          const back = toDec(before!).times('1.05')
          expect(back.minus(toDec(sale.price)).abs().lte(toDec('0.000000000001'))).toBe(true)
        }
      }),
    )
  })
})
