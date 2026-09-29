import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { PRODUCT_TYPES, VAT_CATEGORIES, type ProductType, type VatCategory } from '../catalog/keys'
import { toDec } from '../numbers/decimal'
import {
  hoursAndMinutes,
  INCOMPLETE_REASONS,
  monthlyPurchases,
  monthlyPurchasesAverage,
  ownerTimeCost,
  priceBeforeVat,
  productCost,
  purchaseMonths,
  runningCostRate,
  runningCostShare,
  saleVatRate,
  type MaterialsPart,
  type OwnerTimePart,
  type ProductCostInput,
  type RunningCostsPart,
  type SalePrice,
} from './product-cost'

// A product's cost for one unit sold and its margin (M2 Step 6; D-116, D-119, D-121, D-178): the
// owner's examples as golden tests (the Spanish Latte in a café with a team, the home baker's cake
// slice with her own time), every state of each line, and fast-check properties: the total is the
// exact sum of its parts, the margin and the total make the price before VAT exactly, a missing part
// never counts as 0 and always says why, the running-cost share is the materials × running costs ÷
// purchases divided once, and the months of purchases follow the calendar.

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
const TEAM: OwnerTimePart = { state: 'team' }

describe('the owner’s examples', () => {
  it('the Spanish Latte: 3.002034632035 of materials, running costs 15 000 ÷ 30 000 a month', () => {
    const cost = productCost({
      materials: PRICED('3.002034632035'),
      runningCosts: {
        state: 'on',
        entered: true,
        monthlyRunningCosts: '15000',
        monthlyPurchases: '30000',
      },
      ownerTime: TEAM,
      sale: SALE,
    })
    expect(cost).toEqual({
      materials: '3.002034632035',
      // Each dirham of materials carries 0.50 of running costs: 3.002034632035 × 15 000 ÷ 30 000
      // = 1.5010173160175, rounded once.
      runningCosts: { state: 'applied', rate: '0.5', share: '1.501017316018' },
      ownerTime: { state: 'team', amount: null },
      total: '4.503051948053',
      tooLarge: false,
      reasons: [],
      complete: true,
      priceBeforeVat: '18',
      margin: '13.496948051947',
      // (1 800 − 450.3051948053) ÷ 18.
      marginPercent: '74.983044733039',
    })
  })

  it('the home baker’s cake slice: 1.075 of materials, 550 ÷ 2 000 of running costs, 10 minutes at 45', () => {
    const cost = productCost({
      materials: { state: 'on', perUnit: '1.075', lineCount: 4, unpricedLines: 0, tooLarge: false },
      runningCosts: {
        state: 'on',
        entered: true,
        monthlyRunningCosts: '550',
        monthlyPurchases: '2000',
      },
      ownerTime: { state: 'solo', minutes: '10', hourlyRate: '45' },
      sale: { price: '15', priceIncludesVat: false, vatCategory: 'standard', vatRegistered: false },
    })
    expect(cost).toEqual({
      materials: '1.075',
      runningCosts: { state: 'applied', rate: '0.275', share: '0.295625' },
      ownerTime: { state: 'applied', amount: '7.5' },
      total: '8.870625',
      tooLarge: false,
      reasons: [],
      complete: true,
      priceBeforeVat: '15',
      margin: '6.129375',
      marginPercent: '40.8625',
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

  it('the parts, divided once each', () => {
    expect(runningCostRate('15000', '30000')).toBe('0.5')
    expect(runningCostRate('1000', '3000')).toBe('0.333333333333')
    expect(runningCostRate('1000', '0')).toBeNull()
    // 4 × 1 000 ÷ 3 000, not 4 × 0.333333333333.
    expect(runningCostShare('4', '1000', '3000')).toBe('1.333333333333')
    expect(runningCostShare('4', '15000', '30000')).toBe('2')
    expect(ownerTimeCost('10', '45')).toBe('7.5')
    expect(ownerTimeCost('7', '50')).toBe('5.833333333333')
    expect(monthlyPurchasesAverage('9000')).toBe('3000')
    expect(monthlyPurchasesAverage('100')).toBe('33.333333333333')
  })
})

describe('each line’s states, never 0 for what is missing', () => {
  const ON: RunningCostsPart = {
    state: 'on',
    entered: true,
    monthlyRunningCosts: '15000',
    monthlyPurchases: '30000',
  }
  const base = (over: Partial<ProductCostInput>): ProductCostInput => ({
    materials: PRICED('4'),
    runningCosts: ON,
    ownerTime: TEAM,
    sale: SALE,
    ...over,
  })

  it('running costs: off, not entered, none, not set, no materials, no recipe, waiting, applied', () => {
    expect(productCost(base({ runningCosts: { state: 'off' } }))).toMatchObject({
      runningCosts: { state: 'off', rate: null, share: null },
      total: '4',
      complete: true,
    })
    // None ever entered (the state right after Smart Setup): not entered yet, never 0 (D-186).
    expect(
      productCost(
        base({
          runningCosts: {
            state: 'on',
            entered: false,
            monthlyRunningCosts: '0',
            monthlyPurchases: '30000',
          },
        }),
      ),
    ).toMatchObject({
      runningCosts: { state: 'not_entered', rate: null, share: null },
      total: '4',
      reasons: ['running_costs_not_entered'],
      complete: false,
      margin: '14',
    })
    // Entered, and none paid now (they ended, or start later): a share of 0, complete.
    expect(
      productCost(
        base({
          runningCosts: {
            state: 'on',
            entered: true,
            monthlyRunningCosts: '0',
            monthlyPurchases: null,
          },
        }),
      ),
    ).toMatchObject({
      runningCosts: { state: 'none', rate: '0', share: '0' },
      total: '4',
      complete: true,
    })
    // Neither an estimate nor 3 full months of purchases: not set yet, never 0.
    expect(
      productCost(
        base({
          runningCosts: {
            state: 'on',
            entered: true,
            monthlyRunningCosts: '15000',
            monthlyPurchases: null,
          },
        }),
      ),
    ).toMatchObject({
      runningCosts: { state: 'not_set', rate: null, share: null },
      total: '4',
      reasons: ['running_costs_not_set'],
      complete: false,
      margin: '14',
    })
    // A service with no materials: with this method it carries none (a known limit until Phase 5).
    const NO_LINES: MaterialsPart = {
      state: 'on',
      perUnit: null,
      lineCount: 0,
      unpricedLines: 0,
      tooLarge: false,
    }
    const service = productCost(
      base({
        type: 'service',
        materials: NO_LINES,
        ownerTime: { state: 'solo', minutes: '60', hourlyRate: '100' },
      }),
    )
    expect(service).toMatchObject({
      materials: null,
      runningCosts: { state: 'no_materials', rate: '0.5', share: null },
      ownerTime: { state: 'applied', amount: '100' },
      total: '100',
      reasons: ['no_recipe', 'running_costs_need_materials'],
      complete: false,
    })
    // A product without its recipe yet: its share waits for the recipe; "no recipe" says it all
    // (never "it uses no materials" beside it).
    expect(productCost(base({ materials: NO_LINES }))).toMatchObject({
      runningCosts: { state: 'no_recipe', rate: '0.5', share: null },
      total: null,
      reasons: ['no_recipe'],
      complete: false,
    })
    // …and while the running costs are not set, it says both.
    expect(
      productCost(
        base({
          materials: NO_LINES,
          runningCosts: { ...ON, monthlyPurchases: null },
        }),
      ),
    ).toMatchObject({
      runningCosts: { state: 'not_set' },
      reasons: ['no_recipe', 'running_costs_not_set'],
    })
    // Materials off (a services business): no materials line and no recipe to ask for.
    expect(productCost(base({ materials: { state: 'off' } }))).toMatchObject({
      materials: null,
      runningCosts: { state: 'no_materials' },
      total: null,
      reasons: ['running_costs_need_materials'],
      margin: null,
      marginPercent: null,
    })
    // Every material unpriced: the share waits for their prices.
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
      runningCosts: { state: 'waiting', rate: '0.5', share: null },
      total: null,
      reasons: ['unpriced_materials'],
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
    ).toMatchObject({ ownerTime: { state: 'none', amount: null }, total: '6', complete: true })
    expect(
      productCost(base({ ownerTime: { state: 'solo', minutes: '10', hourlyRate: null } })),
    ).toMatchObject({
      ownerTime: { state: 'rate_not_set', amount: null },
      total: '6',
      reasons: ['hourly_rate_not_set'],
      complete: false,
    })
  })

  it('nothing counted: no total and no margin, never 0', () => {
    const cost = productCost({
      materials: { state: 'off' },
      runningCosts: {
        state: 'on',
        entered: true,
        monthlyRunningCosts: '0',
        monthlyPurchases: null,
      },
      ownerTime: TEAM,
      sale: SALE,
    })
    expect(cost).toMatchObject({
      total: null,
      reasons: ['nothing_counted'],
      complete: false,
      margin: null,
      marginPercent: null,
      priceBeforeVat: '18',
    })
  })

  it('no price: no margin; a price of 0: a margin and no percent', () => {
    expect(productCost(base({ sale: { ...SALE, price: null } }))).toMatchObject({
      total: '6',
      priceBeforeVat: null,
      margin: null,
      marginPercent: null,
    })
    expect(productCost(base({ sale: { ...SALE, price: '0' } }))).toMatchObject({
      margin: '-6',
      marginPercent: null,
    })
    // A loss is a negative margin.
    expect(productCost(base({ sale: { ...SALE, price: '5' } }))).toMatchObject({
      margin: '-1',
      marginPercent: '-20',
    })
  })

  it('too large to work out: nothing is totalled', () => {
    const huge = productCost(
      base({
        materials: { state: 'on', perUnit: null, lineCount: 1, unpricedLines: 0, tooLarge: true },
      }),
    )
    expect(huge).toMatchObject({ total: null, tooLarge: true, complete: false, margin: null })
    // A share that does not fit (a tiny estimate).
    const share = productCost(
      base({
        materials: PRICED('9999999999999999'),
        runningCosts: {
          state: 'on',
          entered: true,
          monthlyRunningCosts: '15000',
          monthlyPurchases: '0.01',
        },
      }),
    )
    expect(share).toMatchObject({
      runningCosts: { state: 'applied', share: null },
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
    expect(() => ownerTimeCost('-1', '45')).toThrow(RangeError)
    expect(() => runningCostRate('-1', '10')).toThrow(RangeError)
    expect(() => monthlyPurchasesAverage('-3')).toThrow(RangeError)
  })
})

describe('which months of purchases count (D-116)', () => {
  it('the last 3 full months before today’s, once 3 full months have passed after the first purchase', () => {
    expect(purchaseMonths('2026-09-29', '2026-05-20', 3)).toEqual({
      from: '2026-06-01',
      to: '2026-08-31',
      countsFrom: '2026-09-01',
      monthsBought: 3,
      ready: true,
    })
    expect(purchaseMonths('2026-09-29', '2026-06-01', 3)).toEqual({
      from: '2026-06-01',
      to: '2026-08-31',
      countsFrom: '2026-10-01',
      monthsBought: 3,
      ready: false,
    })
    expect(purchaseMonths('2026-09-29', null, 0)).toMatchObject({ countsFrom: null, ready: false })
    // Across a year, and a leap February.
    expect(purchaseMonths('2027-01-01', '2026-09-30', 3)).toEqual({
      from: '2026-10-01',
      to: '2026-12-31',
      countsFrom: '2027-01-01',
      monthsBought: 3,
      ready: true,
    })
    expect(purchaseMonths('2028-03-15', null, 0)).toMatchObject({
      from: '2027-12-01',
      to: '2028-02-29',
    })
    expect(() => purchaseMonths('2026-9-1', null, 0)).toThrow(RangeError)
    for (const count of [-1, 4, 1.5]) {
      expect(() => purchaseMonths('2026-09-29', null, count)).toThrow(RangeError)
    }
  })

  it('only when each of the 3 months holds a purchase: old invoices typed in on day one do not count (D-186)', () => {
    // First purchase dated in May (an old invoice), one in July, nothing in June or August: the 3
    // months would be months of almost nothing, so the estimate stays.
    expect(purchaseMonths('2026-09-30', '2026-05-10', 1)).toMatchObject({
      countsFrom: '2026-09-01',
      monthsBought: 1,
      ready: false,
    })
    expect(purchaseMonths('2026-09-30', '2026-05-10', 2).ready).toBe(false)
    expect(purchaseMonths('2026-09-30', '2026-05-10', 3).ready).toBe(true)
  })

  it('the average once it counts and is more than zero, else the estimate, else none', () => {
    const ready = { ready: true }
    const waiting = { ready: false }
    expect(monthlyPurchases({ months: ready, monthsTotal: '9000', estimate: '30000' })).toEqual({
      source: 'last_3_months',
      monthly: '3000',
      average: '3000',
    })
    expect(monthlyPurchases({ months: waiting, monthsTotal: '9000', estimate: '30000' })).toEqual({
      source: 'estimate',
      monthly: '30000',
      average: null,
    })
    // Nothing bought in those months: the estimate, if any.
    expect(monthlyPurchases({ months: ready, monthsTotal: '0', estimate: '30000.50' })).toEqual({
      source: 'estimate',
      monthly: '30000.5',
      average: '0',
    })
    expect(monthlyPurchases({ months: waiting, monthsTotal: '0', estimate: null })).toEqual({
      source: null,
      monthly: null,
      average: null,
    })
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
    arbitrary: fc
      .record({
        state: fc.constant('on' as const),
        entered: fc.boolean(),
        monthlyRunningCosts: decimalArb(100_000, 12),
        monthlyPurchases: fc.option(positiveArb(1_000_000, 4), { nil: null }),
      })
      // Running costs paid now were entered.
      .map((part) => (toDec(part.monthlyRunningCosts).gt(0) ? { ...part, entered: true } : part)),
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
  type: fc.constantFrom<ProductType>(...PRODUCT_TYPES),
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
        // A share is worked out only with materials and purchases to divide by.
        if (cost.runningCosts.state === 'applied') {
          expect(cost.materials).not.toBeNull()
          expect(
            input.runningCosts.state === 'on' && input.runningCosts.monthlyPurchases,
          ).toBeTruthy()
        }
        // Complete exactly when nothing is missing, and something is counted.
        expect(cost.complete).toBe(cost.reasons.length === 0 && !cost.tooLarge)
        if (cost.complete) expect(cost.total).not.toBeNull()
        expect([...cost.reasons]).toEqual(
          INCOMPLETE_REASONS.filter((r) => cost.reasons.includes(r)),
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
        if (
          runningCosts.state === 'on' &&
          toDec(runningCosts.monthlyRunningCosts).gt(0) &&
          runningCosts.monthlyPurchases === null &&
          materials.state === 'on' &&
          materials.lineCount > 0
        ) {
          expect(cost.reasons).toContain('running_costs_not_set')
          expect(cost.runningCosts.share).toBeNull()
        }
        // Never entered: said, never 0 (D-186).
        if (runningCosts.state === 'on' && !runningCosts.entered) {
          expect(cost.reasons).toContain('running_costs_not_entered')
          expect(cost.runningCosts.share).toBeNull()
        }
        // A product without its recipe waits for it: never "it uses no materials" beside it.
        if ((input.type ?? 'product') === 'product' && cost.reasons.includes('no_recipe')) {
          expect(cost.reasons).not.toContain('running_costs_need_materials')
        }
      }),
    )
  })

  it('the share is materials × running ÷ purchases, divided once (within half a unit of the 12th decimal)', () => {
    fc.assert(
      fc.property(
        decimalArb(10_000, 12),
        decimalArb(100_000, 12),
        positiveArb(1_000_000, 4),
        (materials, running, purchases) => {
          const share = runningCostShare(materials, running, purchases)!
          const exact = toDec(materials).times(toDec(running)).dividedBy(toDec(purchases))
          expect(toDec(share).minus(exact).abs().lte(toDec('0.0000000000005'))).toBe(true)
          // More materials never carry less.
          const more = runningCostShare(toDec(materials).plus(1).toString(), running, purchases)!
          expect(toDec(more).gte(toDec(share))).toBe(true)
        },
      ),
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

  it('the months: 3 whole months that end before today’s month; they count 4 months after the first purchase’s, each holding a purchase', () => {
    const dayArb = fc
      .date({
        min: new Date('2020-01-01T00:00:00Z'),
        max: new Date('2035-12-31T00:00:00Z'),
        noInvalidDate: true,
      })
      .map((date) => date.toISOString().slice(0, 10))
    fc.assert(
      fc.property(dayArb, fc.option(dayArb, { nil: null }), (today, first) => {
        // Each of the 3 months holding a purchase: the first purchase's day decides alone.
        const months = purchaseMonths(today, first, 3)
        // Any month without one keeps the estimate.
        expect(purchaseMonths(today, first, 2).ready).toBe(false)
        expect(months.from.endsWith('-01')).toBe(true)
        expect(months.to < today.slice(0, 7)).toBe(true)
        const next = new Date(`${months.to}T00:00:00Z`)
        next.setUTCDate(next.getUTCDate() + 1)
        // The day after the last one is the first day of today's month.
        expect(next.toISOString().slice(0, 10)).toBe(`${today.slice(0, 7)}-01`)
        const monthIndex = (day: string) =>
          Number.parseInt(day.slice(0, 4), 10) * 12 + Number.parseInt(day.slice(5, 7), 10)
        expect(monthIndex(today) - monthIndex(months.from)).toBe(3)
        if (first === null) {
          expect(months.ready).toBe(false)
        } else {
          expect(months.ready).toBe(monthIndex(today) - monthIndex(first) >= 4)
          // Once ready, every month counted is after the first purchase's month.
          if (months.ready) expect(monthIndex(months.from) > monthIndex(first)).toBe(true)
        }
      }),
    )
  })
})
