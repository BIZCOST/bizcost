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
  billPeriodOf,
  costPool,
  costRate,
  costShare,
  daysIn,
  daysRunIn,
  type CostPool,
  type PoolExpense,
  type PoolLine,
  type PoolRunningCost,
} from './cost-share'

// How running costs reach what the business sells (D-202, the owner's decision of 2026-09-30; D-203;
// D-216, his decision of 2026-10-01): the month's costs counted once PER RUNNING COST (its own bills
// replace its regular amount, never add to it, over the period they pay for: the month, or a
// quarterly or yearly running cost's quarter or year, spread over its months; a bill replaces only
// its own running cost, and an extra counts on top as itself; a running cost counts the days it ran;
// a reversal within its period is as if never posted, a later one takes back only itself in the
// month it counts in), the rate (costs ÷ sales) and a unit's share (its price before VAT × costs ÷
// sales, divided once). The owner's example: costs of 20 000 over sales of 80 000 = 25 %, so a
// AED 400 service carries 100 and an AED 18 latte 4.50. Properties: a running cost's line depends
// only on it and its own bills, an extra always adds, nothing counted twice month by month and over
// each quarter or year, a reversal takes back only itself, a rent that changes mid-month counted
// once (D-217: one line, and one bill of either pays for both), any order, and Σ (price before VAT
// × quantity sold) × rate = the month's costs when sales are at list price.

const MONTH = '2026-09'
const RENT = 'cat-rent'
const POWER = 'cat-electricity'
const SALARIES = 'cat-salaries'
const ADS = 'cat-marketing'
const LICENCE = 'cat-licences'
const UPKEEP = 'cat-maintenance'

/** A running cost: by default the shop rent, 12 000 a month; named as its id unless said. */
const running = (over: Partial<PoolRunningCost> = {}): PoolRunningCost => ({
  id: 'rent',
  name: over.id ?? 'rent',
  categoryId: RENT,
  amount: '12000',
  frequency: 'monthly',
  startsOn: '2026-01-01',
  endsOn: null,
  ...over,
})
/** An expense: by default the electricity bill of September, which pays the running cost `power`. */
const bill = (over: Partial<PoolExpense> = {}): PoolExpense => ({
  categoryId: POWER,
  runningCostId: 'power',
  cost: '3150',
  month: MONTH,
  reversedIn: null,
  ...over,
})
const extra = (over: Partial<PoolExpense> = {}): PoolExpense =>
  bill({ runningCostId: null, ...over })

/** A line of the month's costs (amounts as plain strings), with what is not said left at none. */
interface Line {
  readonly kind?: PoolLine['kind']
  readonly runningCostId?: string | null
  readonly amount: string
  readonly source: PoolLine['source']
  readonly regular?: string | null
  readonly period?: { from: string; to: string; months: 3 | 12; bills: string } | null
  readonly takenBack?: string | null
}
const line = (over: Line) => ({
  kind: over.runningCostId === undefined || over.runningCostId === null ? 'extra' : 'running_cost',
  runningCostId: null,
  regular: null,
  period: null,
  takenBack: null,
  ...over,
})
const categoryOf = (pool: CostPool, categoryId: string) =>
  pool.categories.find((c) => c.categoryId === categoryId)
const lineOf = (pool: CostPool, runningCostId: string) =>
  pool.categories.flatMap((c) => c.lines).find((l) => l.runningCostId === runningCostId)
const extrasOf = (pool: CostPool, categoryId: string) =>
  categoryOf(pool, categoryId)?.lines.find((l) => l.kind === 'extra')

describe('the month’s costs, counted once per running cost (D-216)', () => {
  it('the owner’s question: a 300 bonus under Salaries is an extra, on top of the regular 16 000', () => {
    const salaries = running({ id: 'salaries', categoryId: SALARIES, amount: '16000' })
    const bonus = extra({ categoryId: SALARIES, cost: '300' })
    expect(costPool(MONTH, [salaries], [bonus])).toEqual({
      month: MONTH,
      total: '16300',
      categories: [
        {
          categoryId: SALARIES,
          amount: '16300',
          lines: [
            line({
              runningCostId: 'salaries',
              amount: '16000',
              source: 'regular',
              regular: '16000',
            }),
            line({ amount: '300', source: 'expenses' }),
          ],
        },
      ],
    })
  })

  it('a bill replaces its own running cost’s regular amount; without one it counts; extras as themselves', () => {
    const pool = costPool(
      MONTH,
      [
        running(),
        running({ id: 'power', categoryId: POWER, amount: '3000' }),
        running({ id: 'salaries', categoryId: SALARIES, amount: '16000' }),
      ],
      [bill(), extra({ categoryId: ADS, cost: '500' })],
    )
    expect(pool).toEqual({
      month: MONTH,
      // 12 000 + 3 150 (the bill, not 3 000 + 3 150) + 16 000 + 500.
      total: '31650',
      categories: [
        {
          categoryId: POWER,
          amount: '3150',
          lines: [
            line({ runningCostId: 'power', amount: '3150', source: 'bills', regular: '3000' }),
          ],
        },
        { categoryId: ADS, amount: '500', lines: [line({ amount: '500', source: 'expenses' })] },
        {
          categoryId: RENT,
          amount: '12000',
          lines: [
            line({ runningCostId: 'rent', amount: '12000', source: 'regular', regular: '12000' }),
          ],
        },
        {
          categoryId: SALARIES,
          amount: '16000',
          lines: [
            line({
              runningCostId: 'salaries',
              amount: '16000',
              source: 'regular',
              regular: '16000',
            }),
          ],
        },
      ],
    })
  })

  it('a one-off repair beside the maintenance contract adds to it; the contract’s own bill replaces only the contract', () => {
    const contract = running({ id: 'contract', categoryId: UPKEEP, amount: '500' })
    const repair = extra({ categoryId: UPKEEP, cost: '800' })
    expect(categoryOf(costPool(MONTH, [contract], [repair]), UPKEEP)?.amount).toBe('1300')
    // The contract's own invoice of 520 replaces its 500; the repair still counts.
    const invoice = bill({ categoryId: UPKEEP, runningCostId: 'contract', cost: '520' })
    expect(categoryOf(costPool(MONTH, [contract], [repair, invoice]), UPKEEP)).toEqual({
      categoryId: UPKEEP,
      amount: '1320',
      lines: [
        line({ runningCostId: 'contract', amount: '520', source: 'bills', regular: '500' }),
        line({ amount: '800', source: 'expenses' }),
      ],
    })
  })

  it('two running costs in one category: each bill replaces only its own', () => {
    // The shop's rent (12 000 a month) and the warehouse's (30 000 a quarter from January). The
    // shop's September bill replaces the shop's rent; the warehouse keeps its regular 10 000.
    const shop = running({ id: 'shop' })
    const warehouse = running({ id: 'warehouse', amount: '30000', frequency: 'quarterly' })
    const shopBill = bill({ categoryId: RENT, runningCostId: 'shop', cost: '12500' })
    expect(categoryOf(costPool(MONTH, [shop, warehouse], [shopBill]), RENT)).toEqual({
      categoryId: RENT,
      amount: '22500',
      lines: [
        line({ runningCostId: 'shop', amount: '12500', source: 'bills', regular: '12000' }),
        line({ runningCostId: 'warehouse', amount: '10000', source: 'regular', regular: '10000' }),
      ],
    })
    // The warehouse's July cheque pays for July to September; the shop keeps its regular amount.
    const cheque = bill({
      categoryId: RENT,
      runningCostId: 'warehouse',
      cost: '31500',
      month: '2026-07',
    })
    expect(categoryOf(costPool(MONTH, [shop, warehouse], [cheque]), RENT)?.lines).toEqual([
      line({ runningCostId: 'shop', amount: '12000', source: 'regular', regular: '12000' }),
      line({
        runningCostId: 'warehouse',
        amount: '10500',
        source: 'bills',
        regular: '10000',
        period: { from: '2026-07', to: '2026-09', months: 3, bills: '31500' },
      }),
    ])
  })

  it('the month a rent changes, one bill pays for both, whichever of the two it says it pays (D-217)', () => {
    // The shop rent goes from 10 000 to 12 000 on 16 September (D-176: the old one stops that day
    // and the new one starts it, the same name). The landlord's one bill for September, 11 000, is
    // the rent of the month: it counts once, never with the old rent's 5 000 on top, whichever of the
    // two «فاتورة لـ Shop rent» was chosen.
    const old = running({ id: 'old', name: 'Shop rent', amount: '10000', endsOn: '2026-09-16' })
    const renewed = running({
      id: 'new',
      name: ' shop RENT',
      amount: '12000',
      startsOn: '2026-09-16',
    })
    for (const paid of ['old', 'new']) {
      const one = bill({ categoryId: RENT, runningCostId: paid, cost: '11000' })
      expect(categoryOf(costPool(MONTH, [old, renewed], [one]), RENT)).toEqual({
        categoryId: RENT,
        amount: '11000',
        lines: [line({ runningCostId: 'new', amount: '11000', source: 'bills', regular: '11000' })],
      })
    }
    // A bill for each half: both, once.
    const halves = [
      bill({ categoryId: RENT, runningCostId: 'old', cost: '5000' }),
      bill({ categoryId: RENT, runningCostId: 'new', cost: '6000' }),
    ]
    expect(costPool(MONTH, [old, renewed], halves).total).toBe('11000')
    // The months around it are each rent's own: August the old one's (with its bill), October the
    // new one's.
    const august = bill({ categoryId: RENT, runningCostId: 'old', cost: '10000', month: '2026-08' })
    expect(costPool('2026-08', [old, renewed], [august]).categories[0]?.lines).toEqual([
      line({ runningCostId: 'old', amount: '10000', source: 'bills', regular: '10000' }),
    ])
    expect(costPool('2026-10', [old, renewed], [august]).total).toBe('12000')
    // Paid by the quarter from 16 September, or started a day after the old one stopped: two running
    // costs, each its own line and its own bills.
    const one = bill({ categoryId: RENT, runningCostId: 'old', cost: '5000' })
    const quarterly = { ...renewed, frequency: 'quarterly' as const, amount: '36000' }
    expect(categoryOf(costPool(MONTH, [old, quarterly], [one]), RENT)?.lines).toEqual([
      line({ runningCostId: 'new', amount: '6000', source: 'regular', regular: '6000' }),
      line({ runningCostId: 'old', amount: '5000', source: 'bills', regular: '5000' }),
    ])
    const later = { ...renewed, startsOn: '2026-09-17' }
    expect(categoryOf(costPool(MONTH, [old, later], [one]), RENT)?.lines).toHaveLength(2)
  })

  it('a bill of a running cost that is not counted (removed, or Running Costs off) counts as itself', () => {
    const pool = costPool(MONTH, [], [bill()])
    expect(pool.categories).toEqual([
      { categoryId: POWER, amount: '3150', lines: [line({ amount: '3150', source: 'expenses' })] },
    ])
  })

  it('a running cost’s line goes under its own category', () => {
    // The bill says Electricity; its running cost was moved to Utilities since: the line goes with
    // the running cost, so it replaces that running cost's amount where it is counted.
    const power = running({ id: 'power', categoryId: 'cat-utilities', amount: '3000' })
    const pool = costPool(MONTH, [power], [bill()])
    expect(pool.categories.map((c) => c.categoryId)).toEqual(['cat-utilities'])
    expect(pool.total).toBe('3150')
  })

  it('a running cost counts the days of the month it ran: a rent that changes mid-month once', () => {
    // 10 000 up to 15 September, 12 000 from 16 September: 15 days of each. The same rent changed
    // (D-176: the old one stops the day the new one starts, same name): one line (D-217).
    const pool = costPool(
      MONTH,
      [
        running({ id: 'old', name: 'Shop rent', amount: '10000', endsOn: '2026-09-16' }),
        running({ id: 'new', name: 'Shop rent', amount: '12000', startsOn: '2026-09-16' }),
      ],
      [],
    )
    expect(pool.categories).toEqual([
      {
        categoryId: RENT,
        amount: '11000',
        lines: [
          line({ runningCostId: 'new', amount: '11000', source: 'regular', regular: '11000' }),
        ],
      },
    ])
    // Two rents (another name: a second shop), each its own line.
    expect(
      costPool(
        MONTH,
        [
          running({ id: 'old', amount: '10000', endsOn: '2026-09-16' }),
          running({ id: 'new', amount: '12000', startsOn: '2026-09-16' }),
        ],
        [],
      ).categories[0]?.lines,
    ).toEqual([
      line({ runningCostId: 'new', amount: '6000', source: 'regular', regular: '6000' }),
      line({ runningCostId: 'old', amount: '5000', source: 'regular', regular: '5000' }),
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
          running({ id: 'a', startsOn: '2026-01-01', endsOn: '2026-09-01' }),
          running({ id: 'b', startsOn: '2026-10-01' }),
        ],
        [],
      ),
    ).toEqual({ month: MONTH, total: '0', categories: [] })
  })

  it('reversals count where D-200 says, and take back only themselves', () => {
    // Posted and reversed in September: not a bill, the regular amount counts.
    const power = running({ id: 'power', categoryId: POWER, amount: '3000' })
    expect(costPool(MONTH, [power], [bill({ reversedIn: MONTH })]).categories[0]?.lines).toEqual([
      line({ runningCostId: 'power', amount: '3000', source: 'regular', regular: '3000' }),
    ])
    // August's bill, reversed once August was closed: it counts in August and back in September.
    const august = bill({ month: '2026-08', reversedIn: MONTH })
    expect(costPool('2026-08', [], [august]).total).toBe('3150')
    expect(costPool(MONTH, [], [august]).categories[0]?.lines).toEqual([
      line({ amount: '-3150', source: 'taken_back', takenBack: '3150' }),
    ])
    // Taken back on top of what September counts for its running cost: its regular 3 000 (it is
    // not a bill of September, so it replaces nothing), or September's own bill of 3 000.
    expect(lineOf(costPool(MONTH, [power], [august]), 'power')).toEqual(
      line({
        runningCostId: 'power',
        amount: '-150',
        source: 'regular',
        regular: '3000',
        takenBack: '3150',
      }),
    )
    expect(costPool(MONTH, [power], [august, bill({ cost: '3000' })]).total).toBe('-150')
    expect(
      lineOf(costPool(MONTH, [power], [august, bill({ cost: '3000' })]), 'power')?.source,
    ).toBe('bills')
    // September's bill reversed in October: it counts in September.
    expect(costPool(MONTH, [], [bill({ reversedIn: '2026-10' })]).total).toBe('3150')
    expect(costPool('2026-10', [], [bill({ reversedIn: '2026-10' })]).total).toBe('-3150')
    // An extra reversed later: it counts in its month and is taken back with the month's extras.
    const bonus = extra({ categoryId: SALARIES, cost: '300', month: '2026-08', reversedIn: MONTH })
    const salaries = running({ id: 'salaries', categoryId: SALARIES, amount: '16000' })
    expect(
      costPool(MONTH, [salaries], [bonus, extra({ categoryId: SALARIES, cost: '200' })]),
    ).toMatchObject({ total: '15900' })
    expect(extrasOf(costPool(MONTH, [salaries], [bonus]), SALARIES)).toEqual(
      line({ amount: '-300', source: 'taken_back', takenBack: '300' }),
    )
  })

  it('a quarter’s or a year’s bills pay for its months: spread evenly, in place of its regular amount', () => {
    // The trade licence: 15 000 a year from January, renewed in March. Every month of the year
    // counts 1 250 of it, never 1 250 beside the bill.
    const licence = running({
      id: 'licence',
      categoryId: LICENCE,
      amount: '15000',
      frequency: 'yearly',
    })
    const renewal = bill({
      categoryId: LICENCE,
      runningCostId: 'licence',
      cost: '15000',
      month: '2026-03',
    })
    const year = { from: '2026-01', to: '2026-12', months: 12, bills: '15000' } as const
    for (const month of ['2026-01', '2026-03', MONTH, '2026-12']) {
      expect(lineOf(costPool(month, [licence], [renewal]), 'licence')).toEqual(
        line({
          runningCostId: 'licence',
          amount: '1250',
          source: 'bills',
          regular: '1250',
          period: year,
        }),
      )
    }
    // The next year has no bill yet: its regular amount.
    expect(lineOf(costPool('2027-01', [licence], [renewal]), 'licence')).toEqual(
      line({ runningCostId: 'licence', amount: '1250', source: 'regular', regular: '1250' }),
    )
    // Rent of 30 000 a quarter from 15 January: its quarters are January to March, April to June…;
    // February's cheque pays for January to March, 10 000 each month (January ran 17 of 31 days).
    const rent = running({ amount: '30000', frequency: 'quarterly', startsOn: '2026-01-15' })
    const cheque = bill({
      categoryId: RENT,
      runningCostId: 'rent',
      cost: '30000',
      month: '2026-02',
    })
    expect(lineOf(costPool('2026-01', [rent], [cheque]), 'rent')).toEqual(
      line({
        runningCostId: 'rent',
        amount: '10000',
        source: 'bills',
        regular: '5483.870967741935',
        period: { from: '2026-01', to: '2026-03', months: 3, bills: '30000' },
      }),
    )
    expect(costPool('2026-04', [rent], [cheque]).total).toBe('10000')
    expect(lineOf(costPool('2026-04', [rent], [cheque]), 'rent')?.source).toBe('regular')
    // 10 000 ÷ 3 is rounded once, in its 12th decimal.
    expect(
      costPool(
        '2026-05',
        [rent],
        [bill({ categoryId: RENT, runningCostId: 'rent', cost: '10000', month: '2026-06' })],
      ).total,
    ).toBe('3333.333333333333')
  })

  it('a quarter’s or a year’s bill reversed within it is as if never posted; later, it is taken back where it counts', () => {
    const licence = running({
      id: 'licence',
      categoryId: LICENCE,
      amount: '15000',
      frequency: 'yearly',
    })
    const of = { categoryId: LICENCE, runningCostId: 'licence', cost: '15000' }
    // Entered by mistake in March, reversed in May (March's books closed): within the year.
    const mistake = bill({ ...of, month: '2026-03', reversedIn: '2026-05' })
    expect(costPool('2026-04', [licence], [mistake])).toEqual(costPool('2026-04', [licence], []))
    // December's bill, reversed in January (December closed): it pays for 2026; January takes it
    // back on top of its own regular amount.
    const december = bill({ ...of, month: '2026-12', reversedIn: '2027-01' })
    expect(costPool('2026-06', [licence], [december]).total).toBe('1250')
    expect(lineOf(costPool('2027-01', [licence], [december]), 'licence')).toEqual(
      line({
        runningCostId: 'licence',
        amount: '-13750',
        source: 'regular',
        regular: '1250',
        takenBack: '15000',
      }),
    )
  })

  it('a year still paid for after its running cost stopped; two yearly ones in a category each keep their own year', () => {
    // Stopped on 1 July: its year's bill still pays for August, where nothing ran.
    const licence = running({
      id: 'licence',
      categoryId: LICENCE,
      amount: '12000',
      frequency: 'yearly',
      endsOn: '2026-07-01',
    })
    const renewal = bill({
      categoryId: LICENCE,
      runningCostId: 'licence',
      cost: '12000',
      month: '2026-02',
    })
    expect(lineOf(costPool('2026-08', [licence], [renewal]), 'licence')).toEqual(
      line({
        runningCostId: 'licence',
        amount: '1000',
        source: 'bills',
        period: { from: '2026-01', to: '2026-12', months: 12, bills: '12000' },
      }),
    )
    // Without its bill, August counts nothing of it.
    expect(costPool('2026-08', [licence], []).categories).toEqual([])
    // A second yearly one from June: its own year (June to May), its own bill.
    const permit = running({
      id: 'permit',
      categoryId: LICENCE,
      amount: '2400',
      frequency: 'yearly',
      startsOn: '2026-06-01',
    })
    const yearly = running({
      id: 'licence',
      categoryId: LICENCE,
      amount: '12000',
      frequency: 'yearly',
    })
    const bills = [
      renewal,
      bill({ categoryId: LICENCE, runningCostId: 'permit', cost: '2640', month: '2026-06' }),
    ]
    expect(categoryOf(costPool('2026-09', [yearly, permit], bills), LICENCE)).toEqual({
      categoryId: LICENCE,
      amount: '1220',
      lines: [
        line({
          runningCostId: 'licence',
          amount: '1000',
          source: 'bills',
          regular: '1000',
          period: { from: '2026-01', to: '2026-12', months: 12, bills: '12000' },
        }),
        line({
          runningCostId: 'permit',
          amount: '220',
          source: 'bills',
          regular: '200',
          period: { from: '2026-06', to: '2027-05', months: 12, bills: '2640' },
        }),
      ],
    })
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
    expect(() => costPool(MONTH, [running(), running()], [])).toThrow(RangeError)
    expect(() => costPool(MONTH, [running({ endsOn: '2025-12-31' })], [])).toThrow(RangeError)
    expect(() => costPool(MONTH, [running({ startsOn: '2026-9-1' })], [])).toThrow(RangeError)
    expect(() => costPool(MONTH, [], [bill({ cost: '-1' })])).toThrow(RangeError)
    expect(() => costPool(MONTH, [], [bill({ reversedIn: '2026-08' })])).toThrow(RangeError)
    expect(() => costPool(MONTH, [], [bill({ month: '0000-01' })])).toThrow(RangeError)
  })
})

describe('the period a bill pays for (billPeriodOf)', () => {
  it('a weekly or monthly running cost: its month, when it ran a day of it', () => {
    const rent = running({ startsOn: '2026-03-31', endsOn: '2026-06-01' })
    expect(billPeriodOf(rent, '2026-02')).toBeNull()
    expect(billPeriodOf(rent, '2026-03')).toEqual({ from: '2026-03', to: '2026-03', months: 1 })
    expect(billPeriodOf({ ...rent, frequency: 'weekly' }, '2026-05')).toEqual({
      from: '2026-05',
      to: '2026-05',
      months: 1,
    })
    // It stopped on 1 June: not a day of June.
    expect(billPeriodOf(rent, '2026-06')).toBeNull()
  })

  it('a quarterly or yearly one: its quarter or year, from the month it started, while it ran in it', () => {
    const rent = running({ frequency: 'quarterly', startsOn: '2026-01-15', endsOn: '2026-07-01' })
    expect(billPeriodOf(rent, '2025-12')).toBeNull()
    expect(billPeriodOf(rent, '2026-02')).toEqual({ from: '2026-01', to: '2026-03', months: 3 })
    expect(billPeriodOf(rent, '2026-06')).toEqual({ from: '2026-04', to: '2026-06', months: 3 })
    // Stopped on the first day of its third quarter: nothing of it to pay there.
    expect(billPeriodOf(rent, '2026-08')).toBeNull()
    // A year still paid for after it stopped mid-year.
    const licence = running({ frequency: 'yearly', startsOn: '2026-03-10', endsOn: '2026-08-01' })
    expect(billPeriodOf(licence, '2027-01')).toEqual({ from: '2026-03', to: '2027-02', months: 12 })
    expect(billPeriodOf(licence, '2027-03')).toBeNull()
  })

  it('refuses a malformed month or day', () => {
    expect(() => billPeriodOf(running(), '2026-13')).toThrow(RangeError)
    expect(() => billPeriodOf(running({ frequency: 'yearly' }), '2026-1')).toThrow(RangeError)
    expect(() => billPeriodOf(running({ startsOn: '2026-1-01' }), MONTH)).toThrow(RangeError)
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

const CATEGORIES = ['a', 'b', 'c']
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

/** A running cost without its id (the properties number them). */
const runningArb = fc
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
/** Running costs numbered r0, r1… (two or more may share a category). */
const costsArb = (maxLength: number) =>
  fc
    .array(runningArb, { maxLength })
    .map((list) =>
      list.map((cost, i): PoolRunningCost => ({ ...cost, id: `r${i}`, name: `r${i}` })),
    )

/**
 * An expense: `pays` 0–7 is the bill of the running cost of that number when it exists (in its
 * category, as the API checks), anything else an extra in a random category; `rX` a bill of a
 * running cost that is not counted (removed since).
 */
const expenseArb = fc.record({
  categoryId: categoryArb,
  pays: fc.oneof(fc.integer({ min: 0, max: 9 }), fc.constant(-1)),
  cost: decimalArb(20_000, 4),
  month: monthArb,
  later: fc.option(fc.integer({ min: 0, max: 3 }), { nil: null }),
})
type ExpenseSeed = typeof expenseArb extends fc.Arbitrary<infer T> ? T : never
function expenseOf(seed: ExpenseSeed, costs: readonly PoolRunningCost[]): PoolExpense {
  const cost = seed.pays >= 0 ? costs[seed.pays] : undefined
  return {
    categoryId: cost?.categoryId ?? seed.categoryId,
    runningCostId: cost ? cost.id : seed.pays === 9 ? 'rX' : null,
    cost: seed.cost,
    month: seed.month,
    reversedIn: seed.later === null ? null : addMonths(seed.month, seed.later),
  }
}
const expensesOf = (seeds: readonly ExpenseSeed[], costs: readonly PoolRunningCost[]) =>
  seeds.map((seed) => expenseOf(seed, costs))

const sum = (values: readonly string[]) =>
  values.reduce((acc, value) => acc.plus(toDec(value)), toDec('0'))
const linesOf = (pool: CostPool) => pool.categories.flatMap((c) => c.lines)

/** The frequencies whose bills pay for their own month (quarterly and yearly ones pay for more). */
const BILLED_MONTHLY: readonly RunningCostFrequency[] = ['weekly', 'monthly']

describe('properties', () => {
  it('a running cost’s line depends only on it and its own bills; the extras only on themselves', () => {
    fc.assert(
      fc.property(
        monthArb,
        costsArb(8),
        fc.array(expenseArb, { maxLength: 12 }),
        (month, costs, seeds) => {
          const expenses = expensesOf(seeds, costs)
          const pool = costPool(month, costs, expenses)
          const ids = new Set(costs.map((c) => c.id))
          for (const cost of costs) {
            const own = expenses.filter((e) => e.runningCostId === cost.id)
            const alone = lineOf(costPool(month, [cost], own), cost.id)
            expect(lineOf(pool, cost.id)).toEqual(alone)
            // Under its own category, with its regular amount whatever its bills.
            if (alone) {
              expect(categoryOf(pool, cost.categoryId)?.lines).toContainEqual(alone)
              expect(alone.regular).toBe(
                lineOf(costPool(month, [cost], []), cost.id)?.regular ?? null,
              )
            }
          }
          for (const category of CATEGORIES) {
            const extras = expenses.filter(
              (e) =>
                e.categoryId === category &&
                (e.runningCostId === null || !ids.has(e.runningCostId)),
            )
            expect(extrasOf(pool, category)).toEqual(
              extrasOf(costPool(month, [], extras), category),
            )
          }
          for (const category of pool.categories) {
            expect(category.lines.length).toBeGreaterThan(0)
            expect(toDec(category.amount).equals(sum(category.lines.map((l) => l.amount)))).toBe(
              true,
            )
          }
          expect(toDec(pool.total).equals(sum(pool.categories.map((c) => c.amount)))).toBe(true)
        },
      ),
    )
  })

  it('an extra always adds: its own month counts it on top, and nothing else changes', () => {
    fc.assert(
      fc.property(
        costsArb(6),
        fc.array(expenseArb, { maxLength: 8 }),
        expenseArb,
        (costs, seeds, seed) => {
          const expenses = expensesOf(seeds, costs)
          const added: PoolExpense = {
            ...expenseOf(seed, costs),
            runningCostId: null,
            reversedIn: null,
          }
          for (let i = -13; i <= 13; i += 1) {
            const month = addMonths(added.month, i)
            const before = costPool(month, costs, expenses)
            const after = costPool(month, costs, [...expenses, added])
            const more = i === 0 ? toDec(added.cost) : toDec('0')
            expect(toDec(after.total).equals(toDec(before.total).plus(more))).toBe(true)
            // Every running cost's line stays as it was.
            expect(linesOf(after).filter((l) => l.kind === 'running_cost')).toEqual(
              linesOf(before).filter((l) => l.kind === 'running_cost'),
            )
          }
        },
      ),
    )
  })

  it('a bill replaces only its own running cost: no other running cost or extra changes in any month', () => {
    fc.assert(
      fc.property(
        costsArb(6).filter((costs) => costs.length > 0),
        fc.array(expenseArb, { maxLength: 8 }),
        expenseArb,
        fc.nat(),
        (costs, seeds, seed, pick) => {
          const expenses = expensesOf(seeds, costs)
          const cost = costs[pick % costs.length]!
          const added: PoolExpense = {
            ...expenseOf(seed, costs),
            categoryId: cost.categoryId,
            runningCostId: cost.id,
            reversedIn: null,
          }
          for (let i = -13; i <= 13; i += 1) {
            const month = addMonths(added.month, i)
            const others = (pool: CostPool) =>
              linesOf(pool).filter((l) => l.runningCostId !== cost.id)
            expect(others(costPool(month, costs, [...expenses, added]))).toEqual(
              others(costPool(month, costs, expenses)),
            )
          }
        },
      ),
    )
  })

  it('no running cost counted twice over any month, quarter or year: its own bills when it has any, else its regular amount', () => {
    const tolerance = (months: number) => toDec('0.0000000000005').times(months)
    fc.assert(
      fc.property(
        costsArb(4).filter((costs) => costs.length > 0),
        fc.array(
          fc.record({
            cost: fc.nat(),
            after: fc.integer({ min: -2, max: 37 }),
            paid: decimalArb(20_000, 4),
          }),
          {
            maxLength: 10,
          },
        ),
        // Extras and bills of running costs that are not counted, which never mix in.
        fc.array(
          expenseArb.map((e) => ({ ...e, pays: -1 })),
          { maxLength: 4 },
        ),
        (costs, paid, seeds) => {
          const bills = paid.map((p): PoolExpense => {
            const cost = costs[p.cost % costs.length]!
            return {
              categoryId: cost.categoryId,
              runningCostId: cost.id,
              cost: p.paid,
              month: addMonths(monthOf(cost.startsOn), p.after),
              reversedIn: null,
            }
          })
          const expenses = [...bills, ...expensesOf(seeds, costs)]
          for (const cost of costs) {
            const size = BILLED_MONTHLY.includes(cost.frequency)
              ? 1
              : cost.frequency === 'quarterly'
                ? 3
                : 12
            const start = monthOf(cost.startsOn)
            for (let first = 0; first < 36; first += size) {
              const months = Array.from({ length: size }, (_, i) => addMonths(start, first + i))
              const ofPeriod = bills.filter(
                (b) => b.runningCostId === cost.id && months.includes(b.month),
              )
              const counted = months.map((m) => lineOf(costPool(m, costs, expenses), cost.id))
              const total = sum(counted.map((l) => l?.amount ?? '0'))
              const regular = sum(
                months.map((m) => lineOf(costPool(m, [cost], []), cost.id)?.amount ?? '0'),
              )
              if (ofPeriod.length > 0) {
                const expected = sum(ofPeriod.map((b) => b.cost))
                expect(total.minus(expected).abs().lte(tolerance(size))).toBe(true)
                // A period it ran in: each of its months counts its share of the bills. (One it
                // had stopped before: each bill counts in its own month only.)
                if (billPeriodOf(cost, months[0]!) !== null) {
                  for (const l of counted) expect(l?.source).toBe('bills')
                }
              } else {
                expect(total.equals(regular)).toBe(true)
                for (const l of counted) if (l) expect(l.source).toBe('regular')
              }
            }
          }
        },
      ),
    )
  })

  it('a reversal takes back only itself: as if never posted within its period, else in the month it counts in', () => {
    fc.assert(
      fc.property(
        costsArb(6),
        fc.array(expenseArb, { maxLength: 6 }),
        expenseArb,
        fc.integer({ min: 0, max: 14 }),
        (costs, seeds, seed, later) => {
          const expenses = expensesOf(seeds, costs)
          const subject = expenseOf(seed, costs)
          const standing: PoolExpense = { ...subject, reversedIn: null }
          const reversed: PoolExpense = { ...subject, reversedIn: addMonths(subject.month, later) }
          const months = Array.from({ length: 30 }, (_, i) => addMonths(subject.month, i - 13))
          const totals = (list: readonly PoolExpense[]) =>
            months.map((m) => toDec(costPool(m, costs, list).total))
          const without = totals(expenses)
          const kept = totals([...expenses, standing])
          const undone = totals([...expenses, reversed])
          const neverPosted = undone.every((total, i) => total.equals(without[i]!))
          const takenBack = undone.every((total, i) =>
            total.equals(
              kept[i]!.minus(months[i] === reversed.reversedIn ? toDec(subject.cost) : toDec('0')),
            ),
          )
          expect(neverPosted || takenBack).toBe(true)
          // In its own month: as if never posted. Later, an extra or a bill that pays for its own
          // month only: taken back in the month the reversal counts in.
          if (later === 0) expect(neverPosted).toBe(true)
          const paid = costs.find((c) => c.id === subject.runningCostId)
          const paysForMonths = paid !== undefined && !BILLED_MONTHLY.includes(paid.frequency)
          if (later > 0 && !paysForMonths) expect(takenBack).toBe(true)
          // Over the months, a reversed expense adds up to what the months count without it, or to
          // what they count with it standing less its cost: never more taken back than it cost.
          const over = (list: readonly ReturnType<typeof toDec>[]) =>
            list.reduce((acc, value) => acc.plus(value), toDec('0'))
          expect(
            over(undone).equals(over(without)) ||
              over(undone).equals(over(kept).minus(toDec(subject.cost))),
          ).toBe(true)
        },
      ),
    )
  })

  it('in any order, the same; the total is the exact sum of its categories', () => {
    fc.assert(
      fc.property(
        monthArb,
        costsArb(8),
        fc.array(expenseArb, { maxLength: 10 }),
        (month, costs, seeds) => {
          const expenses = expensesOf(seeds, costs)
          const pool = costPool(month, costs, expenses)
          expect(costPool(month, [...costs].reverse(), [...expenses].reverse())).toEqual(pool)
          expect(toDec(pool.total).equals(sum(pool.categories.map((c) => c.amount)))).toBe(true)
        },
      ),
    )
  })

  it('a running cost split on any day counts the same; a whole month counts its monthly amount', () => {
    fc.assert(
      fc.property(
        monthArb,
        costsArb(1).filter((c) => c.length === 1),
        dayArb,
        (month, [cost], day) => {
          const split: PoolRunningCost[] =
            cost!.startsOn <= day && (cost!.endsOn === null || day <= cost!.endsOn)
              ? [
                  { ...cost!, endsOn: day },
                  { ...cost!, id: 'r1', startsOn: day },
                ]
              : [cost!]
          // Each running cost is divided once: the two halves may differ from the whole in the 12th
          // decimal, never more.
          const whole = toDec(costPool(month, [cost!], []).total)
          const halves = toDec(costPool(month, split, []).total)
          expect(whole.minus(halves).abs().lte(toDec('0.000000000001'))).toBe(true)
          const full = { ...cost!, startsOn: `${month}-01`, endsOn: null }
          expect(costPool(month, [full], []).total).toBe(
            monthlyAmount(cost!.amount, cost!.frequency),
          )
          expect(daysRunIn(full, month)).toBe(daysIn(month))
        },
      ),
    )
  })

  it('a running cost changed mid-month is one: one line, its bills whichever of the two each names, else its regular amounts (D-217)', () => {
    const paidByTheMonth = fc.constantFrom<RunningCostFrequency>(...BILLED_MONTHLY)
    fc.assert(
      fc.property(
        monthArb,
        fc.integer({ min: 2, max: 28 }),
        fc.tuple(positiveArb(50_000, 4), positiveArb(50_000, 4)),
        fc.tuple(paidByTheMonth, paidByTheMonth),
        fc.array(fc.record({ old: fc.boolean(), cost: decimalArb(20_000, 4) }), { maxLength: 4 }),
        // Other running costs (other names), never mixed in.
        costsArb(3),
        (month, day, [was, now], [before, after], paid, others) => {
          const handover = `${month}-${String(day).padStart(2, '0')}`
          const old: PoolRunningCost = {
            id: 'old',
            name: 'Shop rent',
            categoryId: 'a',
            amount: was,
            frequency: before,
            startsOn: `${addMonths(month, -2)}-01`,
            endsOn: handover,
          }
          const renewed: PoolRunningCost = {
            ...old,
            id: 'new',
            name: 'shop rent ',
            amount: now,
            frequency: after,
            startsOn: handover,
            endsOn: null,
          }
          const billsNaming = (swap: boolean) =>
            paid.map((p): PoolExpense => ({
              categoryId: 'a',
              runningCostId: p.old !== swap ? 'old' : 'new',
              cost: p.cost,
              month,
              reversedIn: null,
            }))
          const pool = costPool(month, [old, renewed, ...others], billsNaming(false))
          const changed = linesOf(pool).filter(
            (l) => l.runningCostId === 'old' || l.runningCostId === 'new',
          )
          expect(changed).toHaveLength(1)
          const [one] = changed
          const regular = sum(
            [old, renewed].map((cost) => lineOf(costPool(month, [cost], []), cost.id)!.regular!),
          )
          expect(one!.runningCostId).toBe('new')
          expect(toDec(one!.regular!).equals(regular)).toBe(true)
          if (paid.length > 0) {
            expect(one!.source).toBe('bills')
            expect(toDec(one!.amount).equals(sum(paid.map((p) => p.cost)))).toBe(true)
          } else {
            expect(one!.source).toBe('regular')
            expect(toDec(one!.amount).equals(regular)).toBe(true)
          }
          // Whichever of the two each bill names, the same; the others as without them.
          expect(costPool(month, [old, renewed, ...others], billsNaming(true))).toEqual(pool)
          expect(
            toDec(pool.total).equals(
              toDec(costPool(month, others, []).total).plus(toDec(one!.amount)),
            ),
          ).toBe(true)
          // The month before, only the old one ran: its own line, without the new one's bills.
          const earlier = addMonths(month, -1)
          expect(lineOf(costPool(earlier, [old, renewed], billsNaming(false)), 'old')).toEqual(
            lineOf(costPool(earlier, [old], []), 'old'),
          )
        },
      ),
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
