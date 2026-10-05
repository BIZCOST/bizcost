import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { paysCountInCosts } from '../expenses/keys'
import { plain, toDec } from '../numbers/decimal'
import type { CostAmount } from '../numbers/kinds'
import {
  costPool,
  type PoolExpense,
  type PoolMaterialPurchase,
  type PoolRunningCost,
} from './cost-share'
import { productCost, type SalePrice } from './product-cost'
import {
  businessRealProfit,
  channelFeeExpensesOf,
  channelFeesOf,
  costIncreasePercent,
  feesNotCarried,
  marginConcern,
  monthCostsSoFar,
  rateCostsOf,
  saleLineProfit,
  saleRate,
  soldLinesProfit,
  statementParts,
  sumRealProfit,
  weekOf,
  type ChannelFees,
  type FeeExpense,
  type SaleRate,
} from './real-profit'
import type { SaleLineCost, SaleTimeCost } from './sale-cost'

// Real profit switched on (M3 Step 3; Q8, Q13, Q14 of D-218): materials that no product uses counted
// with the month's running costs, expenses marked as a channel's fees or as delivery kept out of
// them, fees counted once, the report's sums (one division per month and channel), the week, and the
// Dashboard's thresholds.

const c = (value: string) => value as CostAmount
/** n units of 10^-places as a decimal string (-1205, 2 → "-12.05"). */
const scaled = (n: number, places: number) => {
  const size = Math.abs(n)
  const unit = 10 ** places
  const fraction = String(size % unit).padStart(places, '0')
  return `${n < 0 ? '-' : ''}${Math.floor(size / unit)}.${fraction}`
}
const MONTH = '2026-09'

const rent: PoolRunningCost = {
  id: 'rent',
  name: 'Workshop rent',
  categoryId: 'rent',
  amount: '20000',
  frequency: 'monthly',
  startsOn: '2026-01-01',
  endsOn: null,
}

const gypsum = (over: Partial<PoolMaterialPurchase> = {}): PoolMaterialPurchase => ({
  materialId: 'gypsum',
  cost: '4000',
  month: MONTH,
  reversedIn: null,
  ...over,
})

describe('materials no product uses (Q13 A)', () => {
  it('the fit-out company: (20,000 + gypsum 4,000) ÷ 80,000 = 30 % (definition of done)', () => {
    const pool = costPool(MONTH, [rent], [], [gypsum()])
    expect(pool.total).toBe('24000')
    expect(pool.materials).toEqual({
      amount: '4000',
      lines: [{ materialId: 'gypsum', amount: '4000', takenBack: null }],
    })
    const rate = saleRate({
      on: true,
      source: { basis: 'month', month: MONTH, from: null, to: null, shown: true },
      costs: pool.total,
      sales: '80000',
    })
    expect(rate).toMatchObject({ state: 'applied', rate: '0.3' })
  })

  it('by purchase month; a return takes off in its month; reversals as expenses', () => {
    // A credit note of 500 on it in October; the purchase reversed in September is as if never bought.
    const credit = gypsum({ cost: '-500', month: '2026-10' })
    expect(costPool('2026-10', [], [], [gypsum(), credit]).materials?.amount).toBe('-500')
    expect(costPool(MONTH, [], [], [gypsum({ reversedIn: MONTH })]).materials).toBeNull()
    // Reversed when September was closed: September keeps it, October takes it back.
    const late = gypsum({ reversedIn: '2026-10' })
    expect(costPool(MONTH, [], [], [late]).materials?.amount).toBe('4000')
    expect(costPool('2026-10', [], [], [late]).materials).toEqual({
      amount: '-4000',
      lines: [{ materialId: 'gypsum', amount: '-4000', takenBack: '4000' }],
    })
    expect(() => costPool(MONTH, [], [], [gypsum({ reversedIn: '2026-08' })])).toThrow(RangeError)
  })

  it('so far: spread over the month’s days; the whole month is the pool exactly', () => {
    const soFar = monthCostsSoFar(MONTH, '2026-09-01', '2026-09-15', [rent], [], [gypsum()])
    expect(soFar.materials).toEqual({
      amount: '2000',
      lines: [{ materialId: 'gypsum', amount: '2000' }],
    })
    expect(soFar.total).toBe('12000')
    const whole = monthCostsSoFar(MONTH, '2026-09-01', '2026-09-30', [rent], [], [gypsum()])
    expect(whole.total).toBe(costPool(MONTH, [rent], [], [gypsum()]).total)
    expect(
      rateCostsOf(
        { basis: 'month', month: MONTH, from: null, to: null, shown: true },
        [rent],
        [],
        [gypsum()],
      ),
    ).toBe('24000')
  })
})

describe('expenses for app fees or delivery never count in the month’s costs (Q8)', () => {
  const expense = (over: Partial<PoolExpense>): PoolExpense => ({
    categoryId: 'other',
    runningCostId: null,
    cost: '1800',
    month: MONTH,
    reversedIn: null,
    ...over,
  })

  it('a channel’s fees and delivery already on the sales stay out; anything else counts', () => {
    expect(paysCountInCosts('channel_fees')).toBe(false)
    expect(paysCountInCosts('delivery')).toBe(false)
    expect(paysCountInCosts('extra')).toBe(true)
    expect(paysCountInCosts(null)).toBe(true)
    const pool = costPool(
      MONTH,
      [rent],
      [
        expense({ pays: 'channel_fees' }),
        expense({ pays: 'delivery', cost: '700' }),
        expense({ pays: null, cost: '300' }),
      ],
    )
    expect(pool.total).toBe('20300')
  })

  it('a channel’s marked expenses are its fees for their month, reversals as expenses', () => {
    const fees: FeeExpense[] = [
      { channelId: 'talabat', cost: '1000', month: MONTH, reversedIn: null },
      { channelId: 'talabat', cost: '800', month: MONTH, reversedIn: null },
      // Reversed in its own month: as if never posted.
      { channelId: 'talabat', cost: '999', month: MONTH, reversedIn: MONTH },
      // Reversed in October (September closed): taken back there.
      { channelId: 'noon', cost: '400', month: MONTH, reversedIn: '2026-10' },
    ]
    const september = channelFeeExpensesOf(MONTH, fees)
    expect(Object.fromEntries(september.marked)).toEqual({ talabat: '1800', noon: '400' })
    expect(september.takenBack).toBe('0')
    // October (D-250): noon's reversal takes 400 back at the business level; nothing is marked for
    // October, so noon's commission % still applies to its October sales.
    const october = channelFeeExpensesOf('2026-10', fees)
    expect(october.marked.size).toBe(0)
    expect(october.takenBack).toBe('400')
    expect(channelFeeExpensesOf('2026-08', fees).marked.size).toBe(0)
    expect(() =>
      channelFeeExpensesOf(MONTH, [{ channelId: 'x', cost: '-1', month: MONTH, reversedIn: null }]),
    ).toThrow(RangeError)
  })

  it('a marked expense with no sales of its channel to sit on is taken off at the business level', () => {
    const fees = channelFeeExpensesOf(MONTH, [
      { channelId: 'talabat', cost: '300', month: MONTH, reversedIn: null },
      { channelId: 'noon', cost: '90', month: MONTH, reversedIn: null },
      { channelId: 'deliveroo', cost: '50', month: '2026-08', reversedIn: MONTH },
    ])
    // Talabat sold nothing in September (its 300 has nothing to sit on); noon's 90 sits on its sales;
    // Deliveroo's August expense is taken back (50).
    const sales = new Map([
      ['noon', '1000'],
      ['talabat', '0'],
    ])
    expect(feesNotCarried(MONTH, '2026-09-01', '2026-09-30', fees, sales)).toBe('250')
    // Over some of its days: spread like the month's bills (250 × 15 ÷ 30).
    expect(feesNotCarried(MONTH, '2026-09-01', '2026-09-15', fees, sales)).toBe('125')
    // A channel whose sales net to zero or less after a reversal carries none either.
    expect(feesNotCarried(MONTH, '2026-09-01', '2026-09-30', fees, new Map([['noon', '-5']]))).toBe(
      '340',
    )
    expect(() => feesNotCarried(MONTH, '2026-10-01', '2026-10-02', fees, sales)).toThrow(RangeError)
    const sum = sumRealProfit([
      saleLineProfit({
        kind: 'item',
        net: '1000',
        cost: { basis: 'none', materials: [], cost: null, time: { state: 'team' } },
        materialsRequired: false,
        fees: { state: 'expenses', fees: '90', sales: '1000' },
        rate: { state: 'off', source: null, costs: null, sales: null, rate: null },
      }),
    ])
    expect(sum.fees).toBe('90')
    const business = businessRealProfit(sum, {
      state: 'on',
      costs: '0',
      feesNotCarried: '250',
    })
    expect(business).toMatchObject({ fees: '340', feesNotCarried: '250' })
    expect(business.profit).toBe(plain(toDec(sum.profit).minus(toDec('250'))))
  })

  it('property: every marked expense is taken off once over a month, by its channel’s lines or the business level', () => {
    const money = fc.integer({ min: 0, max: 5_000_000 }).map((n) => scaled(n, 2))
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            channel: fc.constantFrom('a', 'b', 'c'),
            cost: money,
            reversedLater: fc.boolean(),
          }),
          { maxLength: 8 },
        ),
        fc.record({ a: money, b: fc.constant('0'), c: money }),
        (marks, sold) => {
          const expenses: FeeExpense[] = marks.map((m) => ({
            channelId: m.channel,
            cost: m.cost,
            month: MONTH,
            reversedIn: m.reversedLater ? '2026-10' : null,
          }))
          const fees = channelFeeExpensesOf(MONTH, expenses)
          const sales = new Map(Object.entries(sold))
          // What each channel's lines carry: its marked fees over its own sales (feeOf adds up to them).
          let carried = toDec('0')
          for (const [channelId, marked] of fees.marked) {
            if (toDec(sales.get(channelId) ?? '0').gt(0)) carried = carried.plus(toDec(marked))
          }
          const level = feesNotCarried(MONTH, '2026-09-01', '2026-09-30', fees, sales)
          const all = expenses.reduce((s, e) => s.plus(toDec(e.cost)), toDec('0'))
          expect(carried.plus(toDec(level)).equals(all)).toBe(true)
          // October gives back exactly what was reversed into it, with nothing marked for October.
          const october = channelFeeExpensesOf('2026-10', expenses)
          const back = expenses
            .filter((e) => e.reversedIn === '2026-10')
            .reduce((s, e) => s.plus(toDec(e.cost)), toDec('0'))
          expect(october.marked.size).toBe(0)
          expect(
            toDec(feesNotCarried('2026-10', '2026-10-01', '2026-10-31', october, sales)).equals(
              back.negated(),
            ),
          ).toBe(true)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('property: one statement and one expense for the same fees count once', () => {
    const money = fc.integer({ min: 1, max: 5_000_000 }).map((n) => scaled(n, 2))
    fc.assert(
      fc.property(
        money,
        money,
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 20 }),
        (statementFees, expenseCost, nets) => {
          const lines = nets.map((n) => scaled(n, 2))
          const sales = plain(lines.reduce((sum, value) => sum.plus(toDec(value)), toDec('0')))
          // The month's statement covers every line's day; the same fees were also marked on an
          // expense (its VAT invoice).
          const [part] = statementParts({
            from: '2026-09-01',
            to: '2026-09-30',
            fees: statementFees,
          })
          const marked = channelFeeExpensesOf(MONTH, [
            { channelId: 't', cost: expenseCost, month: MONTH, reversedIn: null },
          ])
          const fees = channelFeesOf({
            feesExpected: true,
            commissionPercent: '20',
            statement: { fees: part!.fees, sales },
            expenses: { fees: marked.marked.get('t')!, sales },
          })
          const carried = lines
            .map((net) => feeOfLine(net, fees))
            .reduce((sum, value) => sum.plus(toDec(value)), toDec('0'))
          // The lines carry the statement's fees (within each line's 12-decimal rounding)…
          const slack = toDec('0.000000000001').times(lines.length)
          expect(carried.minus(toDec(statementFees)).abs().lte(slack)).toBe(true)
          // …and the marked expense is not in the month's costs either: counted once.
          const pool = costPool(
            MONTH,
            [rent],
            [
              {
                categoryId: 'fees',
                runningCostId: null,
                cost: expenseCost,
                month: MONTH,
                reversedIn: null,
                pays: 'channel_fees',
              },
            ],
          )
          expect(pool.total).toBe('20000')
        },
      ),
      { numRuns: 200 },
    )
  })
})

/** A line's fee through saleLineProfit (item line, no other part). */
function feeOfLine(net: string, fees: ChannelFees): string {
  return (
    saleLineProfit({
      kind: 'item',
      net,
      cost: { basis: 'none', materials: [], cost: null, time: { state: 'team' } },
      materialsRequired: false,
      fees,
      rate: { state: 'off', source: null, costs: null, sales: null, rate: null },
    }).fees?.amount ?? '0'
  )
}

describe('the report’s sums (soldLinesProfit)', () => {
  const rate = (costs: string, sales: string): SaleRate =>
    saleRate({
      on: true,
      source: { basis: 'month', month: MONTH, from: null, to: null, shown: true },
      costs,
      sales,
    })

  it('the home baker’s order #1001 as sums: 35.10 with its delivery (definition of done)', () => {
    const cake = soldLinesProfit({
      kind: 'item',
      net: '150',
      materials: '32.4',
      materialRows: 1,
      unpricedRows: 0,
      withoutRecipe: 0,
      ownerTime: '40',
      rateNotSet: 0,
      fees: { state: 'none' },
      rate: rate('1000', '4000'),
    })
    const deliveryLine = soldLinesProfit({
      kind: 'delivery',
      net: '20',
      materials: null,
      materialRows: 0,
      unpricedRows: 0,
      withoutRecipe: 0,
      ownerTime: null,
      rateNotSet: 0,
      fees: { state: 'none' },
      rate: rate('1000', '4000'),
    })
    expect(cake).toMatchObject({ runningCosts: { amount: '37.5' }, profit: '40.1' })
    const order = sumRealProfit([cake, deliveryLine], [{ state: 'entered', cost: '25' }])
    expect(order).toMatchObject({ profit: '35.1', deliveryMargin: '-5', complete: true })
  })

  it('a sale reversed on a later day takes its delivery cost back on that day', () => {
    const sum = sumRealProfit(
      [],
      [
        { state: 'entered', cost: '25' },
        { state: 'reversed', cost: '25' },
      ],
    )
    expect(sum.deliveryCost).toBe('0')
    expect(() => sumRealProfit([], [{ state: 'reversed', cost: '-1' }])).toThrow(RangeError)
  })

  it('reasons follow what is missing in any of the lines', () => {
    const sums = soldLinesProfit({
      kind: 'item',
      net: '100',
      materials: '10',
      materialRows: 3,
      unpricedRows: 1,
      withoutRecipe: 2,
      ownerTime: null,
      rateNotSet: 1,
      fees: { state: 'not_entered' },
      rate: rate('1000', '4000'),
    })
    expect(sums.reasons).toEqual([
      'no_recipe',
      'unpriced_materials',
      'fees_not_entered',
      'hourly_rate_not_set',
    ])
    expect(sums.materials.state).toBe('no_price_yet')
    expect(sums.ownerTime.state).toBe('rate_not_set')
    expect(() => soldLinesProfit({ ...sumsInput(), unpricedRows: 2, materialRows: 1 })).toThrow(
      RangeError,
    )
  })

  it('property: the sums are the lines’ own profits added, within each line’s 12-decimal rounding', () => {
    const amount = fc.integer({ min: -2_000_000, max: 5_000_000 }).map((n) => scaled(n, 2))
    const material = fc.option(fc.integer({ min: 0, max: 900_000 }).map((n) => scaled(n, 3)))
    const time = fc.oneof(
      fc.constant<SaleTimeCost>({ state: 'team' }),
      fc.constant<SaleTimeCost>({ state: 'rate_not_set', minutes: '10' }),
      fc.integer({ min: 0, max: 50_000 }).map((n): SaleTimeCost => ({
        state: 'applied',
        minutes: '1',
        hourlyRate: '1',
        cost: c(scaled(n, 2)),
      })),
    )
    const feesArb = fc.oneof(
      fc.constant<ChannelFees>({ state: 'none' }),
      fc.constant<ChannelFees>({ state: 'commission', percent: '18.5' }),
      fc.constant<ChannelFees>({ state: 'expenses', fees: '1800', sales: '10000' }),
    )
    fc.assert(
      fc.property(
        fc.array(fc.record({ net: amount, material, time, unpriced: fc.boolean() }), {
          minLength: 1,
          maxLength: 25,
        }),
        feesArb,
        (lines, fees) => {
          const monthRate = rate('20000', '80000')
          const snapshots = lines.map(({ material: m, time: t, unpriced }): SaleLineCost => {
            const priced =
              m === null
                ? []
                : [
                    {
                      materialId: 'm',
                      baseQty: '1',
                      unitCost: null,
                      cost: c(m),
                      basis: 'last_purchase' as const,
                    },
                  ]
            const missing = unpriced
              ? [{ materialId: 'x', baseQty: '1', unitCost: null, cost: null, basis: null }]
              : []
            const all = [...priced, ...missing]
            return {
              basis: all.length === 0 ? 'none' : 'recipe',
              materials: all,
              cost: null,
              time: t,
            }
          })
          const each = lines.map((l, i) =>
            saleLineProfit({
              kind: 'item',
              net: l.net,
              cost: snapshots[i]!,
              materialsRequired: false,
              fees,
              rate: monthRate,
            }),
          )
          const added = sumRealProfit(each)
          const total = (values: readonly string[]) =>
            plain(values.reduce((sum, value) => sum.plus(toDec(value)), toDec('0')))
          const net = total(lines.map((l) => l.net))
          const priced = lines.flatMap((l) => (l.material === null ? [] : [l.material]))
          const timed = lines.flatMap((l) => (l.time.state === 'applied' ? [l.time.cost] : []))
          const summed = sumRealProfit([
            soldLinesProfit({
              kind: 'item',
              net,
              materials: priced.length === 0 ? null : total(priced),
              materialRows: snapshots.reduce((n, s) => n + s.materials.length, 0),
              unpricedRows: lines.filter((l) => l.unpriced).length,
              withoutRecipe: 0,
              ownerTime: timed.length === 0 ? null : total(timed),
              rateNotSet: lines.filter((l) => l.time.state === 'rate_not_set').length,
              fees,
              rate: monthRate,
            }),
          ])
          const slack = toDec('0.000000000001').times(lines.length + 1)
          for (const key of ['fees', 'runningCosts', 'profit'] as const) {
            expect(toDec(summed[key]).minus(toDec(added[key])).abs().lte(slack), key).toBe(true)
          }
          for (const key of ['sales', 'materials', 'ownerTime'] as const) {
            expect(summed[key], key).toBe(added[key])
          }
          expect(summed.reasons).toEqual(added.reasons)
        },
      ),
      { numRuns: 300 },
    )
  })
})

function sumsInput() {
  return {
    kind: 'item' as const,
    net: '1',
    materials: null,
    materialRows: 0,
    unpricedRows: 0,
    withoutRecipe: 0,
    ownerTime: null,
    rateNotSet: 0,
    fees: { state: 'none' } as ChannelFees,
    rate: { state: 'off', source: null, costs: null, sales: null, rate: null } as SaleRate,
  }
}

describe('Product costs switch the share on (M3 Step 3)', () => {
  const latte: SalePrice = {
    price: '18',
    priceIncludesVat: false,
    vatCategory: 'standard',
    vatRegistered: true,
  }
  const base = {
    materials: {
      state: 'on' as const,
      perUnit: '3.002034632035',
      lineCount: 6,
      unpricedLines: 0,
      tooLarge: false,
    },
    ownerTime: { state: 'team' as const },
    sale: latte,
  }

  it('applied: the latte carries 4.50 at 25 %, and its margin is after running costs', () => {
    const cost = productCost({
      ...base,
      runningCosts: { state: 'on', costs: '20000', sales: '80000' },
    })
    expect(cost.runningCosts).toEqual({ state: 'applied', rate: '0.25', share: '4.5' })
    expect(cost).toMatchObject({
      total: '7.502034632035',
      margin: '10.497965367965',
      beforeRunningCosts: false,
      complete: true,
    })
  })

  it('before 7 days of sales: no share yet, before running costs, nothing missing', () => {
    const cost = productCost({ ...base, runningCosts: { state: 'before_running_costs' } })
    expect(cost.runningCosts).toEqual({ state: 'before_running_costs', rate: null, share: null })
    expect(cost).toMatchObject({ beforeRunningCosts: true, complete: true, reasons: [] })
    // Without a price it is still "add its price" (no share can be worked out by it).
    const noPrice = productCost({
      ...base,
      sale: { ...latte, price: null },
      runningCosts: { state: 'before_running_costs' },
    })
    expect(noPrice.runningCosts.state).toBe('no_price')
  })
})

describe('the week, and the Dashboard’s thresholds (Q14)', () => {
  it('a week runs Monday to Sunday', () => {
    expect(weekOf('2026-10-05')).toBe('2026-10-05') // a Monday
    expect(weekOf('2026-10-11')).toBe('2026-10-05') // its Sunday
    expect(weekOf('2026-10-01')).toBe('2026-09-28') // a Thursday: the week starts in September
    expect(weekOf('1970-01-01')).toBe('1969-12-29')
    expect(() => weekOf('2026-13-01')).toThrow(RangeError)
  })

  it('low margin under 10 %, a loss under 0; cost increases in percent of the old average', () => {
    expect(marginConcern('-0.5')).toBe('loss')
    expect(marginConcern('9.999')).toBe('low')
    expect(marginConcern('10')).toBeNull()
    expect(marginConcern(null)).toBeNull()
    expect(costIncreasePercent('6', '6.6')).toBe('10')
    expect(costIncreasePercent('3', '2')).toBe('-33.333333333333')
    expect(costIncreasePercent('0', '2')).toBeNull()
  })
})
