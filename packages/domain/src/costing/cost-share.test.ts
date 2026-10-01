import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  monthlyAmount,
  RUNNING_COST_FREQUENCIES,
  type RunningCostFrequency,
} from '../expenses/keys'
import { addMonths, monthOf } from '../expenses/period'
import { toDec } from '../numbers/decimal'
import {
  costPool,
  costRate,
  costShare,
  daysIn,
  daysRunIn,
  type CostPool,
  type PoolCategory,
  type PoolExpense,
  type PoolRunningCost,
} from './cost-share'

// How running costs reach what the business sells (D-202, the owner's decision of 2026-09-30; D-203):
// the month's costs counted once (bills replace a category's regular amount, never add to it, over the
// period they pay for: the month, or a quarterly or yearly running cost's quarter or year, spread over
// its months; a running cost counts the days it ran; a reversal within its bill's period is as if
// never posted, a later one takes back only itself in the month it counts in), the rate (costs ÷
// sales) and a unit's share (its price before VAT × costs ÷ sales, divided once). The owner's example:
// costs of 20 000 over sales of 80 000 = 25 %, so a AED 400 service carries 100 and an AED 18 latte
// 4.50. Properties: counted once month by month and over each quarter or year, a reversal takes back
// only itself, a rent that changes mid-month counted once, any order, and Σ (price before VAT ×
// quantity sold) × rate = the month's costs when sales are at list price.

const MONTH = '2026-09'
const RENT = 'cat-rent'
const POWER = 'cat-electricity'
const SALARIES = 'cat-salaries'
const ADS = 'cat-marketing'
const LICENCE = 'cat-licences'

const running = (over: Partial<PoolRunningCost> = {}): PoolRunningCost => ({
  categoryId: RENT,
  amount: '12000',
  frequency: 'monthly',
  startsOn: '2026-01-01',
  endsOn: null,
  ...over,
})
const bill = (over: Partial<PoolExpense> = {}): PoolExpense => ({
  categoryId: POWER,
  cost: '3150',
  month: MONTH,
  reversedIn: null,
  ...over,
})
/** A category of the month's costs (amounts as plain strings), with what is not said left at none. */
interface Row {
  readonly categoryId: string
  readonly amount: string
  readonly source: PoolCategory['source']
  readonly regular?: string | null
  readonly period?: { from: string; to: string; months: 3 | 12; bills: string } | null
  readonly takenBack?: string | null
}
const row = (over: Row) => ({ regular: null, period: null, takenBack: null, ...over })
const amountOf = (pool: CostPool, categoryId: string) =>
  pool.categories.find((c) => c.categoryId === categoryId)

describe('the month’s costs, counted once', () => {
  it('bills replace a category’s regular amount; without bills it counts; other expenses as themselves', () => {
    const pool = costPool(
      MONTH,
      [
        running(),
        running({ categoryId: POWER, amount: '3000' }),
        running({ categoryId: SALARIES, amount: '16000' }),
      ],
      [bill(), bill({ categoryId: ADS, cost: '500' })],
    )
    expect(pool).toEqual({
      month: MONTH,
      // 12 000 + 3 150 (the bill, not 3 000 + 3 150) + 16 000 + 500.
      total: '31650',
      categories: [
        row({ categoryId: POWER, amount: '3150', source: 'bills', regular: '3000' }),
        row({ categoryId: ADS, amount: '500', source: 'bills' }),
        row({ categoryId: RENT, amount: '12000', source: 'regular', regular: '12000' }),
        row({ categoryId: SALARIES, amount: '16000', source: 'regular', regular: '16000' }),
      ],
    })
  })

  it('a running cost counts the days of the month it ran: a rent that changes mid-month once', () => {
    // 10 000 up to 15 September, 12 000 from 16 September: 15 days of each.
    const pool = costPool(
      MONTH,
      [
        running({ amount: '10000', endsOn: '2026-09-16' }),
        running({ amount: '12000', startsOn: '2026-09-16' }),
      ],
      [],
    )
    expect(pool.categories).toEqual([
      row({ categoryId: RENT, amount: '11000', source: 'regular', regular: '11000' }),
    ])
    // From 20 September: 11 of 30 days. Weekly and yearly: their monthly amounts for a whole month.
    expect(costPool(MONTH, [running({ amount: '3000', startsOn: '2026-09-20' })], []).total).toBe(
      '1100',
    )
    expect(costPool(MONTH, [running({ amount: '1200', frequency: 'weekly' })], []).total).toBe(
      '5200',
    )
    expect(costPool(MONTH, [running({ amount: '15000', frequency: 'yearly' })], []).total).toBe(
      '1250',
    )
    // One that ended before the month, or starts after it: nothing.
    expect(
      costPool(
        MONTH,
        [
          running({ startsOn: '2026-01-01', endsOn: '2026-09-01' }),
          running({ startsOn: '2026-10-01' }),
        ],
        [],
      ),
    ).toEqual({ month: MONTH, total: '0', categories: [] })
  })

  it('reversals count where D-200 says, and take back only themselves', () => {
    // Posted and reversed in September: not a bill, the regular amount counts.
    const undone = costPool(
      MONTH,
      [running({ categoryId: POWER, amount: '3000' })],
      [bill({ reversedIn: MONTH })],
    )
    expect(undone.categories).toEqual([
      row({ categoryId: POWER, amount: '3000', source: 'regular', regular: '3000' }),
    ])
    // August's bill, reversed once August was closed: it counts in August and back in September.
    const august = bill({ month: '2026-08', reversedIn: MONTH })
    expect(costPool('2026-08', [], [august]).total).toBe('3150')
    expect(costPool(MONTH, [], [august]).categories).toEqual([
      row({ categoryId: POWER, amount: '-3150', source: 'taken_back', takenBack: '3150' }),
    ])
    // Taken back on top of what September counts: its regular 3 000 (it is not a bill of
    // September, so it replaces nothing), or September's own bill of 3 000.
    const power = running({ categoryId: POWER, amount: '3000' })
    expect(costPool(MONTH, [power], [august]).categories).toEqual([
      row({
        categoryId: POWER,
        amount: '-150',
        source: 'regular',
        regular: '3000',
        takenBack: '3150',
      }),
    ])
    expect(costPool(MONTH, [power], [august, bill({ cost: '3000' })])).toEqual({
      month: MONTH,
      total: '-150',
      categories: [
        row({
          categoryId: POWER,
          amount: '-150',
          source: 'bills',
          regular: '3000',
          takenBack: '3150',
        }),
      ],
    })
    // September's bill reversed in October: it counts in September.
    expect(costPool(MONTH, [], [bill({ reversedIn: '2026-10' })]).total).toBe('3150')
    expect(costPool('2026-10', [], [bill({ reversedIn: '2026-10' })]).total).toBe('-3150')
  })

  it('a quarter’s or a year’s bills pay for its months: spread evenly, in place of its regular amount', () => {
    // The trade licence: 15 000 a year from January, renewed in March. Every month of the year
    // counts 1 250 of it, never 1 250 beside the bill.
    const licence = running({ categoryId: LICENCE, amount: '15000', frequency: 'yearly' })
    const renewal = bill({ categoryId: LICENCE, cost: '15000', month: '2026-03' })
    const year = { from: '2026-01', to: '2026-12', months: 12, bills: '15000' } as const
    for (const month of ['2026-01', '2026-03', MONTH, '2026-12']) {
      expect(costPool(month, [licence], [renewal]).categories).toEqual([
        row({
          categoryId: LICENCE,
          amount: '1250',
          source: 'bills',
          regular: '1250',
          period: year,
        }),
      ])
    }
    // The next year has no bill yet: its regular amount.
    expect(costPool('2027-01', [licence], [renewal]).categories).toEqual([
      row({ categoryId: LICENCE, amount: '1250', source: 'regular', regular: '1250' }),
    ])
    // Rent of 30 000 a quarter from 15 January: its quarters are January to March, April to June…;
    // February's cheque pays for January to March, 10 000 each month (January ran 17 of 31 days).
    const rent = running({ amount: '30000', frequency: 'quarterly', startsOn: '2026-01-15' })
    const cheque = bill({ categoryId: RENT, cost: '30000', month: '2026-02' })
    expect(costPool('2026-01', [rent], [cheque]).categories).toEqual([
      row({
        categoryId: RENT,
        amount: '10000',
        source: 'bills',
        regular: '5483.870967741935',
        period: { from: '2026-01', to: '2026-03', months: 3, bills: '30000' },
      }),
    ])
    expect(costPool('2026-04', [rent], [cheque]).total).toBe('10000')
    expect(costPool('2026-04', [rent], [cheque]).categories[0]?.source).toBe('regular')
    // 10 000 ÷ 3 is rounded once, in its 12th decimal.
    expect(
      costPool('2026-05', [rent], [bill({ categoryId: RENT, cost: '10000', month: '2026-06' })])
        .total,
    ).toBe('3333.333333333333')
  })

  it('a quarter’s or a year’s bill reversed within it is as if never posted; later, it is taken back where it counts', () => {
    const licence = running({ categoryId: LICENCE, amount: '15000', frequency: 'yearly' })
    // Entered by mistake in March, reversed in May (March's books closed): within the year.
    const mistake = bill({
      categoryId: LICENCE,
      cost: '15000',
      month: '2026-03',
      reversedIn: '2026-05',
    })
    expect(costPool('2026-04', [licence], [mistake])).toEqual(costPool('2026-04', [licence], []))
    // December's bill, reversed in January (December closed): it pays for 2026; January takes it
    // back on top of its own regular amount.
    const december = bill({
      categoryId: LICENCE,
      cost: '15000',
      month: '2026-12',
      reversedIn: '2027-01',
    })
    expect(costPool('2026-06', [licence], [december]).total).toBe('1250')
    expect(costPool('2027-01', [licence], [december]).categories).toEqual([
      row({
        categoryId: LICENCE,
        amount: '-13750',
        source: 'regular',
        regular: '1250',
        takenBack: '15000',
      }),
    ])
  })

  it('a year still paid for after its running cost stopped; two in one category share the first one’s year', () => {
    // Stopped on 1 July: its year's bill still pays for August, where nothing ran.
    const licence = running({
      categoryId: LICENCE,
      amount: '12000',
      frequency: 'yearly',
      endsOn: '2026-07-01',
    })
    const renewal = bill({ categoryId: LICENCE, cost: '12000', month: '2026-02' })
    expect(costPool('2026-08', [licence], [renewal]).categories).toEqual([
      row({
        categoryId: LICENCE,
        amount: '1000',
        source: 'bills',
        period: { from: '2026-01', to: '2026-12', months: 12, bills: '12000' },
      }),
    ])
    // Without its bill, August counts nothing of it.
    expect(costPool('2026-08', [licence], []).categories).toEqual([])
    // A second yearly one from June in the same category: the first one's year holds both bills.
    const permit = running({
      categoryId: LICENCE,
      amount: '2400',
      frequency: 'yearly',
      startsOn: '2026-06-01',
    })
    const both = [running({ categoryId: LICENCE, amount: '12000', frequency: 'yearly' }), permit]
    const bills = [renewal, bill({ categoryId: LICENCE, cost: '2400', month: '2026-06' })]
    expect(costPool('2026-09', both, bills).categories).toEqual([
      row({
        categoryId: LICENCE,
        amount: '1200',
        source: 'bills',
        regular: '1200',
        period: { from: '2026-01', to: '2026-12', months: 12, bills: '14400' },
      }),
    ])
  })

  it('nothing in the month: 0, and no category', () => {
    expect(costPool(MONTH, [], [])).toEqual({ month: MONTH, total: '0', categories: [] })
    expect(costPool(MONTH, [], [bill({ month: '2026-08' })]).total).toBe('0')
  })

  it('days of a month: February of a leap year, and the first and last years', () => {
    expect(daysIn('2028-02')).toBe(29)
    expect(daysIn('2026-02')).toBe(28)
    expect(daysIn('0001-01')).toBe(31)
    expect(daysIn('9999-12')).toBe(31)
    expect(daysRunIn({ startsOn: '2028-02-29', endsOn: null }, '2028-02')).toBe(1)
    expect(daysRunIn({ startsOn: '2028-02-10', endsOn: '2028-02-10' }, '2028-02')).toBe(0)
  })

  it('refuses what cannot be', () => {
    expect(() => costPool('2026-13', [], [])).toThrow(RangeError)
    expect(() => costPool(MONTH, [running({ amount: '0' })], [])).toThrow(RangeError)
    expect(() => costPool(MONTH, [running({ amount: '-1' })], [])).toThrow(RangeError)
    expect(() => costPool(MONTH, [running({ endsOn: '2025-12-31' })], [])).toThrow(RangeError)
    expect(() => costPool(MONTH, [running({ startsOn: '2026-9-1' })], [])).toThrow(RangeError)
    expect(() => costPool(MONTH, [], [bill({ cost: '-1' })])).toThrow(RangeError)
    expect(() => costPool(MONTH, [], [bill({ reversedIn: '2026-08' })])).toThrow(RangeError)
    expect(() => costPool(MONTH, [], [bill({ month: '0000-01' })])).toThrow(RangeError)
  })
})

describe('the rate and a unit’s share (the owner’s example)', () => {
  it('costs 20 000 and sales 80 000: 25 %; AED 400 carries 100, AED 18 carries 4.50', () => {
    expect(costRate({ state: 'on', costs: '20000', sales: '80000' })).toEqual({
      state: 'ready',
      rate: '0.25',
    })
    expect(costShare('400', '20000', '80000')).toBe('100')
    expect(costShare('18', '20000', '80000')).toBe('4.5')
    // With its VAT taken out first (17.142857142857 before VAT).
    expect(costShare('17.142857142857', '20000', '80000')).toBe('4.285714285714')
  })

  it('divided once: never the rounded rate × the price', () => {
    expect(costRate({ state: 'on', costs: '1000', sales: '3000' }).rate).toBe('0.333333333333')
    // 4 × 1 000 ÷ 3 000 = 1.333…, not 4 × 0.333333333333 = 1.333333333332.
    expect(costShare('4', '1000', '3000')).toBe('1.333333333333')
  })

  it('no sales yet, sales of nothing, costs of nothing or less, and off', () => {
    expect(costRate({ state: 'off' })).toEqual({ state: 'off', rate: null })
    for (const sales of [null, '0', '-5']) {
      expect(costRate({ state: 'on', costs: '20000', sales })).toEqual({
        state: 'awaiting_sales',
        rate: null,
      })
      expect(costShare('18', '20000', sales)).toBeNull()
    }
    for (const costs of ['0', '-150']) {
      expect(costRate({ state: 'on', costs, sales: '80000' })).toEqual({ state: 'none', rate: '0' })
      expect(costShare('18', costs, '80000')).toBe('0')
    }
    expect(costShare('0', '20000', '80000')).toBe('0')
    expect(() => costShare('-1', '20000', '80000')).toThrow(RangeError)
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

const CATEGORIES = ['a', 'b', 'c', 'd']
const categoryArb = fc.constantFrom(...CATEGORIES)
/** A month from January 2025 to December 2027. */
const monthArb = fc.integer({ min: 0, max: 35 }).map((i) => addMonths('2025-01', i))
/** A day from 2024 to 2028. */
const dayArb = fc
  .date({
    min: new Date('2024-06-01T00:00:00Z'),
    max: new Date('2028-06-30T00:00:00Z'),
    noInvalidDate: true,
  })
  .map((date) => date.toISOString().slice(0, 10))
const frequencyArb = fc.constantFrom<RunningCostFrequency>(...RUNNING_COST_FREQUENCIES)

const runningArb: fc.Arbitrary<PoolRunningCost> = fc
  .record({
    categoryId: categoryArb,
    amount: positiveArb(50_000, 4),
    frequency: frequencyArb,
    a: dayArb,
    b: fc.option(dayArb, { nil: null }),
  })
  .map(({ a, b, ...rest }) => ({
    ...rest,
    startsOn: b === null || a <= b ? a : b,
    endsOn: b === null ? null : a <= b ? b : a,
  }))
const expenseArb: fc.Arbitrary<PoolExpense> = fc
  .record({
    categoryId: categoryArb,
    cost: decimalArb(20_000, 4),
    month: monthArb,
    later: fc.option(fc.integer({ min: 0, max: 3 }), { nil: null }),
  })
  .map(({ later, ...rest }) => ({
    ...rest,
    reversedIn: later === null ? null : addMonths(rest.month, later),
  }))

/** The frequencies whose bills pay for their own month (quarterly and yearly ones pay for more). */
const BILLED_MONTHLY: readonly RunningCostFrequency[] = ['weekly', 'monthly']

const sum = (values: readonly string[]) =>
  values.reduce((acc, value) => acc.plus(toDec(value)), toDec('0'))

describe('properties', () => {
  it('counted once, month by month: a category counts its bills or its regular amount, never both, less what is taken back', () => {
    // Weekly and monthly running costs: their bills pay for their own month.
    const monthlyArb = runningArb.filter((c) => BILLED_MONTHLY.includes(c.frequency))
    fc.assert(
      fc.property(
        monthArb,
        fc.array(monthlyArb, { maxLength: 8 }),
        fc.array(expenseArb, { maxLength: 10 }),
        (month, costs, expenses) => {
          const pool = costPool(month, costs, expenses)
          const regular = costPool(month, costs, [])
          const bills = costPool(month, [], expenses)
          const ids = [
            ...new Set([...regular.categories, ...bills.categories].map((c) => c.categoryId)),
          ].sort()
          expect(pool.categories.map((c) => c.categoryId)).toEqual(ids)
          for (const category of pool.categories) {
            const billed = amountOf(bills, category.categoryId)
            const ran = amountOf(regular, category.categoryId)
            expect(category.regular).toBe(ran?.amount ?? null)
            expect(category.takenBack).toBe(billed?.takenBack ?? null)
            expect(category.period).toBeNull()
            if (billed?.source === 'bills') {
              expect(category).toMatchObject({ source: 'bills', amount: billed.amount })
            } else if (ran) {
              // A reversal of an earlier month replaces nothing: it is taken back from the regular.
              const back = toDec(billed?.takenBack ?? '0')
              expect(category.source).toBe('regular')
              expect(toDec(category.amount).equals(toDec(ran.amount).minus(back))).toBe(true)
            } else {
              expect(category).toMatchObject({ source: 'taken_back', amount: billed!.amount })
            }
          }
          expect(toDec(pool.total).equals(sum(pool.categories.map((c) => c.amount)))).toBe(true)
        },
      ),
    )
  })

  it('counted once over each quarter or year: its bills when it has any, else its regular amount', () => {
    const tolerance = (months: number) => toDec('0.0000000000005').times(months)
    fc.assert(
      fc.property(
        fc.constantFrom<RunningCostFrequency>('quarterly', 'yearly'),
        positiveArb(50_000, 4),
        dayArb.filter((day) => day < '2026-01-01'),
        fc.array(
          fc.record({ after: fc.integer({ min: 0, max: 35 }), cost: decimalArb(20_000, 4) }),
          { maxLength: 6 },
        ),
        // Another category with its own bills, which never mixes in.
        fc.array(
          expenseArb.map((e) => ({ ...e, categoryId: 'b' })),
          { maxLength: 4 },
        ),
        (frequency, amount, startsOn, paid, others) => {
          const cost: PoolRunningCost = {
            categoryId: 'a',
            amount,
            frequency,
            startsOn,
            endsOn: null,
          }
          const start = monthOf(startsOn)
          const bills = paid.map((p): PoolExpense => ({
            categoryId: 'a',
            cost: p.cost,
            month: addMonths(start, p.after),
            reversedIn: null,
          }))
          const expenses = [...bills, ...others]
          const size = frequency === 'quarterly' ? 3 : 12
          for (let first = 0; first < 36; first += size) {
            const months = Array.from({ length: size }, (_, i) => addMonths(start, first + i))
            const ofPeriod = bills.filter((b) => months.includes(b.month))
            const counted = months.map((m) => amountOf(costPool(m, [cost], expenses), 'a'))
            const total = sum(counted.map((c) => c?.amount ?? '0'))
            if (ofPeriod.length > 0) {
              const expected = sum(ofPeriod.map((b) => b.cost))
              expect(total.minus(expected).abs().lte(tolerance(size))).toBe(true)
              for (const category of counted) {
                expect(category).toMatchObject({
                  source: 'bills',
                  period: { from: months[0], to: months[size - 1], months: size },
                })
                expect(toDec(category!.period!.bills).equals(expected)).toBe(true)
              }
            } else {
              const regular = sum(months.map((m) => costPool(m, [cost], []).total))
              expect(total.equals(regular)).toBe(true)
              for (const category of counted) expect(category?.source).toBe('regular')
            }
          }
        },
      ),
    )
  })

  it('a reversal takes back only itself: as if never posted within its period, else in the month it counts in', () => {
    fc.assert(
      fc.property(
        fc.array(runningArb, { maxLength: 6 }),
        fc.array(expenseArb, { maxLength: 6 }),
        expenseArb,
        fc.integer({ min: 0, max: 14 }),
        (costs, expenses, extra, later) => {
          const standing: PoolExpense = { ...extra, reversedIn: null }
          const reversed: PoolExpense = { ...extra, reversedIn: addMonths(extra.month, later) }
          const months = Array.from({ length: 30 }, (_, i) => addMonths(extra.month, i - 13))
          const totals = (list: readonly PoolExpense[]) =>
            months.map((m) => toDec(costPool(m, costs, list).total))
          const without = totals(expenses)
          const kept = totals([...expenses, standing])
          const undone = totals([...expenses, reversed])
          const neverPosted = undone.every((total, i) => total.equals(without[i]!))
          const takenBack = undone.every((total, i) =>
            total.equals(
              kept[i]!.minus(months[i] === reversed.reversedIn ? toDec(extra.cost) : toDec('0')),
            ),
          )
          expect(neverPosted || takenBack).toBe(true)
          // In its own month: as if never posted. Later, in a category whose bills pay for their
          // own month only: taken back in the month the reversal counts in.
          if (later === 0) expect(neverPosted).toBe(true)
          const paysForMonths = costs.some(
            (c) => c.categoryId === extra.categoryId && !BILLED_MONTHLY.includes(c.frequency),
          )
          if (later > 0 && !paysForMonths) expect(takenBack).toBe(true)
          // Over the months, a reversed expense adds up to what the months count without it, or to
          // what they count with it standing less its cost: never more taken back than it cost.
          const over = (list: readonly ReturnType<typeof toDec>[]) =>
            list.reduce((acc, value) => acc.plus(value), toDec('0'))
          expect(
            over(undone).equals(over(without)) ||
              over(undone).equals(over(kept).minus(toDec(extra.cost))),
          ).toBe(true)
        },
      ),
    )
  })

  it('in any order, the same; the total is the exact sum of its categories', () => {
    fc.assert(
      fc.property(
        monthArb,
        fc.array(runningArb, { maxLength: 8 }),
        fc.array(expenseArb, { maxLength: 10 }),
        (month, costs, expenses) => {
          const pool = costPool(month, costs, expenses)
          expect(costPool(month, [...costs].reverse(), [...expenses].reverse())).toEqual(pool)
          expect(toDec(pool.total).equals(sum(pool.categories.map((c) => c.amount)))).toBe(true)
        },
      ),
    )
  })

  it('a running cost split on any day counts the same; a whole month counts its monthly amount', () => {
    fc.assert(
      fc.property(monthArb, runningArb, dayArb, (month, cost, day) => {
        const split: PoolRunningCost[] =
          cost.startsOn <= day && (cost.endsOn === null || day <= cost.endsOn)
            ? [
                { ...cost, endsOn: day },
                { ...cost, startsOn: day },
              ]
            : [cost]
        expect(costPool(month, split, [])).toEqual(costPool(month, [cost], []))
        const whole = { ...cost, startsOn: `${month}-01`, endsOn: null }
        expect(costPool(month, [whole], []).total).toBe(monthlyAmount(cost.amount, cost.frequency))
        expect(daysRunIn(whole, month)).toBe(daysIn(month))
      }),
    )
  })

  it('Σ (price before VAT × quantity sold) × rate = the month’s costs when sales are at list price', () => {
    const itemArb = fc.record({
      beforeVat: decimalArb(10_000, 12),
      qty: fc.integer({ min: 1, max: 500 }),
    })
    fc.assert(
      fc.property(
        positiveArb(1_000_000, 4),
        fc.array(itemArb, { minLength: 1, maxLength: 12 }),
        (costs, items) => {
          const sales = sum(items.map((i) => toDec(i.beforeVat).times(i.qty).toString()))
          fc.pre(sales.gt(0))
          let carried = toDec('0')
          let sold = 0
          for (const item of items) {
            const share = costShare(item.beforeVat, costs, sales.toString())!
            carried = carried.plus(toDec(share).times(item.qty))
            sold += item.qty
          }
          // Each share is rounded once, in its 12th decimal: within half a unit of it per unit sold.
          const tolerance = toDec('0.0000000000005').times(sold)
          expect(carried.minus(toDec(costs)).abs().lte(tolerance)).toBe(true)
          // And the rate is the month's costs ÷ sales, rounded once.
          const { rate } = costRate({ state: 'on', costs, sales: sales.toString() })
          const exact = toDec(costs).dividedBy(sales)
          expect(toDec(rate!).minus(exact).abs().lte(toDec('0.0000000000005'))).toBe(true)
        },
      ),
    )
  })

  it('a higher price never carries less, and a share is never negative', () => {
    fc.assert(
      fc.property(
        decimalArb(10_000, 12),
        decimalArb(10_000, 4),
        fc.option(decimalArb(1_000_000, 4), { nil: null }),
        fc.boolean(),
        (price, costs, sales, negative) => {
          const signed = negative && costs !== '0' ? `-${costs}` : costs
          const share = costShare(price, signed, sales)
          if (sales === null || !toDec(sales).gt(0)) {
            expect(share).toBeNull()
            return
          }
          expect(toDec(share!).gte(0)).toBe(true)
          const more = costShare(toDec(price).plus(1).toString(), signed, sales)!
          expect(toDec(more).gte(toDec(share!))).toBe(true)
        },
      ),
    )
  })
})
