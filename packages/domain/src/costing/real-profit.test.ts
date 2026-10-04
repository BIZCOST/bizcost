import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { roundForDisplay } from '../numbers/rounding'
import { toDec } from '../numbers/decimal'
import type { CostAmount } from '../numbers/kinds'
import { addMonths, monthOf, type BusinessMonth } from '../expenses/period'
import { costPool, dayNumber, type PoolExpense, type PoolRunningCost } from './cost-share'
import {
  businessRealProfit,
  channelFeesOf,
  costsSpanOf,
  FIRST_MONTH_DAYS,
  monthCostsSoFar,
  rateCostsOf,
  rateSourceOf,
  saleLineProfit,
  saleRate,
  statementParts,
  sumRealProfit,
  type ChannelFees,
  type SaleLineProfit,
  type SaleLineProfitInput,
  type SaleRate,
} from './real-profit'
import type { SaleLineCost, SaleTimeCost } from './sale-cost'

// Real profit (M3 Step 1, D-223; Q6–Q8 of D-218): sales before VAT − materials − channel fees −
// delivery cost − the running-cost share at the price sold − the owner's time, part by part. The
// owner's examples are golden tests (the café's September, the running month, a first month, the home
// baker's order #1001); the properties: a finished month's shares add up to its costs, a channel's fees
// add up to its statements, a refund mirrors its sale, and costs so far over a whole month are the
// month's costs.

const c = (value: string) => value as CostAmount
/** A day number back as YYYY-MM-DD. */
const dayText = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10)
/** A frozen snapshot: materials of `materials` (null: none), no price yet for `unpriced` more. */
const snapshot = (
  materials: string | null,
  time: SaleTimeCost = { state: 'team' },
  unpriced = 0,
): SaleLineCost => {
  const priced =
    materials === null
      ? []
      : [
          {
            materialId: 'm',
            baseQty: '1',
            unitCost: null,
            cost: c(materials),
            basis: 'purchases_90_days' as const,
          },
        ]
  const missing = Array.from({ length: unpriced }, (_, i) => ({
    materialId: `x${i}`,
    baseQty: '1',
    unitCost: null,
    cost: null,
    basis: null,
  }))
  const all = [...priced, ...missing]
  return {
    basis: all.length === 0 ? 'none' : 'recipe',
    materials: all,
    cost: unpriced === 0 && materials !== null ? c(materials) : null,
    time,
  }
}
const noFees: ChannelFees = { state: 'none' }
/** A finished month's rate: costs ÷ item sales. */
const monthRate = (costs: string, sales: string): SaleRate =>
  saleRate({
    on: true,
    source: { basis: 'month', month: '2026-09', from: null, to: null, shown: true },
    costs,
    sales,
  })
const line = (over: Partial<SaleLineProfitInput> & Pick<SaleLineProfitInput, 'net'>) =>
  saleLineProfit({
    kind: 'item',
    cost: snapshot(null),
    materialsRequired: false,
    fees: noFees,
    rate: monthRate('20000', '80000'),
    ...over,
  })

describe('the café’s September (definition of done)', () => {
  const september = monthRate('20000', '80000')
  const latte = snapshot('3.002034632035')

  it('costs 20,000 ÷ item sales 80,000 = 25 %: an AED 18.00 latte carries 4.50 and earns 10.50 dine-in', () => {
    expect(september).toMatchObject({ state: 'applied', rate: '0.25' })
    const dineIn = line({ net: '18', cost: latte, rate: september })
    expect(dineIn).toMatchObject({
      sales: '18',
      materials: { state: 'priced', amount: '3.002034632035' },
      fees: { state: 'none', amount: null },
      runningCosts: { state: 'applied', basis: 'month', amount: '4.5' },
      ownerTime: { state: 'team', amount: null },
      profit: '10.497965367965',
      complete: true,
      reasons: [],
    })
    expect(roundForDisplay(dineIn.profit, 2)).toBe('10.50')
  })

  it('on Talabat: 20 % commission carries 3.60; its statement, 1,800 ÷ 10,000 = 18 %, carries 3.24 and earns 7.26', () => {
    const commission = channelFeesOf({
      feesExpected: true,
      commissionPercent: '20',
      statement: null,
      expenses: null,
    })
    expect(line({ net: '18', cost: latte, fees: commission }).fees).toEqual({
      state: 'commission',
      amount: '3.6',
    })
    const statement = channelFeesOf({
      feesExpected: true,
      commissionPercent: '20',
      statement: { fees: '1800', sales: '10000' },
      expenses: null,
    })
    const talabat = line({ net: '18', cost: latte, fees: statement })
    expect(talabat.fees).toEqual({ state: 'statement', amount: '3.24' })
    expect(talabat.profit).toBe('7.257965367965')
    expect(roundForDisplay(talabat.profit, 2)).toBe('7.26')
  })

  it('the business: 80,000 − materials 24,000 − fees 1,800 − running costs 20,000 = 34,200 (42.75 %)', () => {
    const talabatFees = channelFeesOf({
      feesExpected: true,
      commissionPercent: '20',
      statement: { fees: '1800', sales: '10000' },
      expenses: null,
    })
    const lines = [
      line({ net: '70000', cost: snapshot('21000'), rate: september }),
      line({ net: '10000', cost: snapshot('3000'), rate: september, fees: talabatFees }),
    ]
    const sum = sumRealProfit(lines)
    expect(sum).toMatchObject({
      sales: '80000',
      itemSales: '80000',
      materials: '24000',
      fees: '1800',
      runningCosts: '20000',
      profit: '34200',
      marginPercent: '42.75',
    })
    expect(businessRealProfit(sum, { state: 'on', costs: '20000' })).toMatchObject({
      profit: '34200',
      marginPercent: '42.75',
      monthCosts: '20000',
      notCarried: '0',
    })
  })

  it('20,000 ÷ 30,000: the shares add up within the 12-decimal rounding; the business subtracts exactly 20,000', () => {
    const rate = monthRate('20000', '30000')
    const lines = ['10000', '10000', '10000'].map((net) => line({ net, rate }))
    expect(lines[0]!.runningCosts?.amount).toBe('6666.666666666667')
    const sum = sumRealProfit(lines)
    expect(toDec(sum.runningCosts).minus(20000).abs().lte('1.5e-12')).toBe(true)
    const business = businessRealProfit(sum, { state: 'on', costs: '20000' })
    expect(business.profit).toBe('10000')
    expect(roundForDisplay(business.notCarried!, 2)).toBe('0.00')
  })
})

describe('which month’s rate (Q6)', () => {
  it('on 10 October an October latte carries September’s rate until October ends', () => {
    const source = rateSourceOf('2026-10', '2026-10-10', '2026-03-02', '2026-09')
    expect(source).toEqual({
      basis: 'last_month',
      month: '2026-09',
      from: null,
      to: null,
      shown: true,
    })
    const rate = saleRate({ on: true, source, costs: '20000', sales: '80000' })
    expect(line({ net: '18', rate }).runningCosts).toEqual({
      state: 'applied',
      basis: 'last_month',
      amount: '4.5',
    })
    // The business's October subtracts its costs so far: 1–10 October.
    expect(costsSpanOf('2026-10', '2026-10-10', '2026-03-02')).toEqual({
      from: '2026-10-01',
      to: '2026-10-10',
    })
    // September, once over, is its own month.
    expect(rateSourceOf('2026-09', '2026-10-10', '2026-03-02', null)).toMatchObject({
      basis: 'month',
    })
    expect(costsSpanOf('2026-09', '2026-10-10', '2026-03-02')).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    })
  })

  it('a first month: the rent bill of 6,000 counts 6,000 × 15 ÷ 30 = 3,000 on the 15th; ÷ 12,000 = 25 % so far', () => {
    const rent: PoolExpense = {
      categoryId: 'rent',
      runningCostId: null,
      cost: '6000',
      month: '2026-09',
      reversedIn: null,
    }
    const source = rateSourceOf('2026-09', '2026-09-15', '2026-09-01', null)
    expect(source).toEqual({
      basis: 'so_far',
      month: '2026-09',
      from: '2026-09-01',
      to: '2026-09-15',
      shown: true,
    })
    const soFar = monthCostsSoFar('2026-09', source!.from!, source!.to!, [], [rent])
    expect(soFar).toMatchObject({ days: 15, total: '3000' })
    const rate = saleRate({ on: true, source, costs: soFar.total, sales: '12000' })
    expect(rate).toMatchObject({ state: 'applied', rate: '0.25' })
  })

  it('on the 4th it is before running costs (fewer than 7 days of sales), never 800 ÷ 1,000 = 80 %', () => {
    const source = rateSourceOf('2026-09', '2026-09-04', '2026-09-01', null)
    expect(source?.shown).toBe(false)
    const rate = saleRate({ on: true, source, costs: '800', sales: '1000' })
    expect(rate).toMatchObject({ state: 'before_running_costs', rate: null })
    const sold = line({ net: '100', rate })
    expect(sold).toMatchObject({ beforeRunningCosts: true, complete: true, profit: '100' })
    expect(sold.runningCosts).toEqual({
      state: 'before_running_costs',
      basis: 'so_far',
      amount: null,
    })
    // The business still takes off 1–4 September's costs: they are in its profit, not before it.
    expect(businessRealProfit(sumRealProfit([sold]), { state: 'on', costs: '800' })).toMatchObject({
      profit: '-700',
      beforeRunningCosts: false,
      notCarried: '800',
    })
    // The 7th is the 7th day of sales.
    expect(rateSourceOf('2026-09', '2026-09-07', '2026-09-01', null)?.shown).toBe(true)
  })

  it('a first month of 3 days runs on into October until 7 days of sales exist; never its own 3 days for all of October', () => {
    // First sale 28 September. Rent 6,000 for September and 6,200 for October: 200 a day.
    const rent = (cost: string, month: '2026-09' | '2026-10'): PoolExpense => ({
      categoryId: 'rent',
      runningCostId: null,
      cost,
      month,
      reversedIn: null,
    })
    const rents = [rent('6000', '2026-09'), rent('6200', '2026-10')]
    expect(rateSourceOf('2026-10', '2026-10-02', '2026-09-28', '2026-09')).toEqual({
      basis: 'so_far',
      month: '2026-10',
      from: '2026-09-28',
      to: '2026-10-02',
      shown: false,
    })
    // On 4 October, 7 days of sales (28 September … 4 October): 600 + 800 = 1,400 ÷ 5,600 = 25 %.
    const source = rateSourceOf('2026-10', '2026-10-04', '2026-09-28', '2026-09')!
    expect(source).toMatchObject({ basis: 'so_far', from: '2026-09-28', to: '2026-10-04' })
    expect(source.shown).toBe(true)
    const costs = rateCostsOf(source, [], rents)
    expect(costs).toBe('1400')
    const rate = saleRate({ on: true, source, costs, sales: '5600' })
    expect(rate).toMatchObject({ state: 'applied', rate: '0.25' })
    expect(line({ net: '18', rate }).runningCosts).toEqual({
      state: 'applied',
      basis: 'so_far',
      amount: '4.5',
    })
    // September, once over, keeps its own 3 days (exact: its sales carry what the business takes off).
    expect(rateSourceOf('2026-09', '2026-10-04', '2026-09-28', null)).toEqual({
      basis: 'so_far',
      month: '2026-09',
      from: '2026-09-28',
      to: '2026-09-30',
      shown: true,
    })
    expect(costsSpanOf('2026-09', '2026-10-04', '2026-09-28')).toEqual({
      from: '2026-09-28',
      to: '2026-09-30',
    })
    expect(costsSpanOf('2026-10', '2026-10-04', '2026-09-28')).toEqual({
      from: '2026-10-01',
      to: '2026-10-04',
    })
    // November carries October's rate; had October sold nothing, its own so far from the 7th.
    expect(rateSourceOf('2026-11', '2026-11-10', '2026-09-28', '2026-10')).toEqual({
      basis: 'last_month',
      month: '2026-10',
      from: null,
      to: null,
      shown: true,
    })
    expect(rateSourceOf('2026-11', '2026-11-06', '2026-09-28', '2026-09')).toEqual({
      basis: 'so_far',
      month: '2026-11',
      from: '2026-11-01',
      to: '2026-11-06',
      shown: false,
    })
    expect(rateSourceOf('2026-11', '2026-11-07', '2026-09-28', '2026-09')?.shown).toBe(true)
  })

  it('after a month without sales the running month carries the last month that sold', () => {
    // A home baker sold from June and took August off. On 10 September: July's rate.
    const source = rateSourceOf('2026-09', '2026-09-10', '2026-06-05', '2026-07')
    expect(source).toEqual({
      basis: 'last_month',
      month: '2026-07',
      from: null,
      to: null,
      shown: true,
    })
    expect(saleRate({ on: true, source, costs: '3000', sales: '12000' })).toMatchObject({
      state: 'applied',
      rate: '0.25',
    })
    // No month before it sold (the first month sold only charges): its own so far from the 1st.
    expect(rateSourceOf('2026-09', '2026-09-10', '2026-06-05', null)).toEqual({
      basis: 'so_far',
      month: '2026-09',
      from: '2026-09-01',
      to: '2026-09-10',
      shown: true,
    })
    expect(() => rateSourceOf('2026-09', '2026-09-10', '2026-06-05', '2026-09')).toThrow(RangeError)
    expect(() => rateSourceOf('2026-09', '2026-09-10', '2026-06-05', '2026-05')).toThrow(RangeError)
    expect(() => rateSourceOf('2026-09', '2026-09-10', null, '2026-08')).toThrow(RangeError)
  })

  it('a rate shown while its month runs is never worked out from fewer than 7 days of sales', () => {
    const start = dayNumber('2026-01-01')
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 400 }),
        fc.integer({ min: 0, max: 120 }),
        fc.nat(),
        fc.boolean(),
        (firstOffset, after, pick, sold) => {
          const firstSale = dayText(start + firstOffset)
          const today = dayText(start + firstOffset + after)
          const month = today.slice(0, 7) as BusinessMonth
          const before: BusinessMonth[] = []
          for (let m = monthOf(firstSale); m < month; m = addMonths(m, 1)) before.push(m)
          const lastSold = sold && before.length > 0 ? before[pick % before.length]! : null
          const source = rateSourceOf(month, today, firstSale, lastSold)
          expect(source).not.toBeNull()
          if (!source!.shown || source!.from === null) return
          expect(dayNumber(source!.to!) - dayNumber(source!.from) + 1).toBeGreaterThanOrEqual(
            FIRST_MONTH_DAYS,
          )
          if (source!.basis === 'so_far') expect(source!.to).toBe(today)
        },
      ),
      { numRuns: 1000 },
    )
  })

  it('off, awaiting sales and none', () => {
    expect(saleRate({ on: false, source: null, costs: null, sales: null }).state).toBe('off')
    expect(rateSourceOf('2026-08', '2026-10-10', '2026-09-01', null)).toBeNull()
    expect(saleRate({ on: true, source: null, costs: null, sales: null }).state).toBe(
      'awaiting_sales',
    )
    expect(monthRate('20000', '0').state).toBe('awaiting_sales')
    const none = monthRate('-5', '1000')
    expect(none).toMatchObject({ state: 'none', rate: '0' })
    expect(line({ net: '18', rate: none }).runningCosts?.amount).toBe('0')
    expect(costsSpanOf('2026-08', '2026-10-10', '2026-09-01')).toBeNull()
    expect(() => rateSourceOf('2026-11', '2026-10-10', null, null)).toThrow(RangeError)
    expect(() => rateSourceOf('2026-10', '2026-10-10', '2026-10-11', null)).toThrow(RangeError)
  })

  it('with Running Costs and Expenses off, the business subtracts nothing and says so', () => {
    const sold = line({
      net: '18',
      rate: saleRate({ on: false, source: null, costs: null, sales: null }),
    })
    expect(sold.runningCosts).toEqual({ state: 'off', basis: null, amount: null })
    expect(businessRealProfit(sumRealProfit([sold]), { state: 'off' })).toMatchObject({
      profit: '18',
      monthCosts: null,
      notCarried: null,
    })
  })
})

describe('the home baker’s order #1001 (definition of done)', () => {
  // A chocolate cake at 150 with delivery charged 20; September's 1,000 ÷ 4,000 = 25 %; materials
  // 32.40 (chocolate 20.00, butter 8.00, flour 2.50, eggs 1.60, sugar 0.30); her 60 minutes at AED
  // 40 an hour; the delivery cost 25. Not registered for VAT; no app fees.
  const september = monthRate('1000', '4000')
  const time: SaleTimeCost = { state: 'applied', minutes: '60', hourlyRate: '40', cost: c('40') }
  const cake = () =>
    line({ net: '150', cost: snapshot('32.4', time), materialsRequired: true, rate: september })
  const delivered = () => line({ kind: 'delivery', net: '20' })

  it('earns 35.10: 150 − 32.40 − 37.50 − 40 on the cake, and delivery 20 − 25 = −5', () => {
    expect(cake()).toMatchObject({ profit: '40.1', runningCosts: { amount: '37.5' } })
    expect(delivered()).toMatchObject({ profit: '20', fees: null, runningCosts: null })
    const order = sumRealProfit([cake(), delivered()], [{ state: 'entered', cost: '25' }])
    expect(order).toMatchObject({
      sales: '170',
      itemSales: '150',
      materials: '32.4',
      runningCosts: '37.5',
      ownerTime: '40',
      deliveryCharged: '20',
      deliveryCost: '25',
      deliveryMargin: '-5',
      profit: '35.1',
      complete: true,
    })
  })

  it('refunded 20 by amount for a damaged cake: sales 150, materials still 32.40, real profit 20.10', () => {
    // A price cut takes back no cost: the refund line has no materials and no time.
    const refund = line({ net: '-20', rate: september })
    expect(refund).toMatchObject({ runningCosts: { amount: '-5' }, profit: '-15' })
    const order = sumRealProfit([cake(), delivered(), refund], [{ state: 'entered', cost: '25' }])
    expect(order).toMatchObject({ sales: '150', materials: '32.4', profit: '20.1' })
  })

  it('without the delivery cost or the hourly rate it is incomplete, never 0', () => {
    const waiting = line({
      net: '150',
      cost: snapshot('32.4', { state: 'rate_not_set', minutes: '60' }),
      rate: september,
    })
    expect(waiting).toMatchObject({
      ownerTime: { state: 'rate_not_set', amount: null },
      reasons: ['hourly_rate_not_set'],
      complete: false,
    })
    const order = sumRealProfit([waiting, delivered()], [{ state: 'not_entered' }])
    expect(order.reasons).toEqual(['hourly_rate_not_set', 'delivery_cost_not_entered'])
    expect(order.deliveryCost).toBe('0')
  })
})

describe('parts that are not known yet', () => {
  it('a material with no price yet: the priced ones only, and incomplete', () => {
    const sold = line({ net: '18', cost: snapshot('2.967034632035', { state: 'team' }, 1) })
    expect(sold.materials).toEqual({ state: 'no_price_yet', amount: '2.967034632035' })
    expect(sold.reasons).toEqual(['unpriced_materials'])
  })

  it('a product sold without a recipe while Materials was on; a service without one is complete', () => {
    expect(line({ net: '18', materialsRequired: true }).reasons).toEqual(['no_recipe'])
    expect(line({ net: '400', materialsRequired: false })).toMatchObject({
      materials: { state: 'none', amount: null },
      complete: true,
    })
  })

  it('a delivery app without a statement, fee expenses or a %: before app fees', () => {
    const fees = channelFeesOf({
      feesExpected: true,
      commissionPercent: null,
      statement: null,
      expenses: null,
    })
    expect(fees).toEqual({ state: 'not_entered' })
    expect(line({ net: '18', fees })).toMatchObject({
      fees: { state: 'not_entered', amount: null },
      reasons: ['fees_not_entered'],
    })
    // The month's expenses marked "App fees of Talabat" when no statement covers the day.
    const expenses = channelFeesOf({
      feesExpected: true,
      commissionPercent: '20',
      statement: null,
      expenses: { fees: '1500', sales: '10000' },
    })
    expect(line({ net: '18', fees: expenses }).fees).toEqual({ state: 'expenses', amount: '2.7' })
  })
})

describe('a statement over two months, split by days', () => {
  it('2,480 for 16 Oct–15 Nov: 1,280 in October (16 days) and 1,200 in November (15)', () => {
    expect(statementParts({ from: '2026-10-16', to: '2026-11-15', fees: '2480' })).toEqual([
      { month: '2026-10', from: '2026-10-16', to: '2026-10-31', days: 16, fees: '1280' },
      { month: '2026-11', from: '2026-11-01', to: '2026-11-15', days: 15, fees: '1200' },
    ])
    expect(statementParts({ from: '2026-09-01', to: '2026-09-30', fees: '1800' })).toEqual([
      { month: '2026-09', from: '2026-09-01', to: '2026-09-30', days: 30, fees: '1800' },
    ])
    expect(() => statementParts({ from: '2026-10-02', to: '2026-10-01', fees: '1' })).toThrow(
      RangeError,
    )
  })
})

describe('the month’s costs so far', () => {
  const rent: PoolRunningCost = {
    id: 'rent',
    name: 'Shop rent',
    categoryId: 'rent',
    amount: '12000',
    frequency: 'monthly',
    startsOn: '2026-01-01',
    endsOn: null,
  }
  const licence: PoolRunningCost = {
    id: 'licence',
    name: 'Trade licence',
    categoryId: 'licences',
    amount: '15000',
    frequency: 'yearly',
    startsOn: '2026-03-01',
    endsOn: null,
  }

  it('running costs for the days they ran up to today; bills and expenses spread over the month', () => {
    const power: PoolExpense = {
      categoryId: 'electricity',
      runningCostId: null,
      cost: '3000',
      month: '2026-09',
      reversedIn: null,
    }
    const soFar = monthCostsSoFar('2026-09', '2026-09-01', '2026-09-10', [rent, licence], [power])
    // Rent 12,000 × 10 ÷ 30 = 4,000; licence 1,250 × 10 ÷ 30; electricity 3,000 × 10 ÷ 30 = 1,000.
    expect(soFar.categories).toEqual([
      { categoryId: 'electricity', amount: '1000' },
      { categoryId: 'licences', amount: '416.666666666667' },
      { categoryId: 'rent', amount: '4000' },
    ])
    expect(soFar.total).toBe('5416.666666666667')
  })

  it('a rent changed mid-month counts each part for its own days (D-217)', () => {
    const before = { ...rent, id: 'old', amount: '10000', endsOn: '2026-09-16' }
    const after = { ...rent, id: 'new', startsOn: '2026-09-16' }
    // 1–20 Sep: 15 days at 10,000 and 5 at 12,000, each ÷ 30.
    const soFar = monthCostsSoFar('2026-09', '2026-09-01', '2026-09-20', [before, after], [])
    expect(soFar.total).toBe('7000')
    const whole = monthCostsSoFar('2026-09', '2026-09-01', '2026-09-30', [before, after], [])
    expect(whole.total).toBe(costPool('2026-09', [before, after], []).total)
  })

  it('refuses days outside the month or the wrong way round', () => {
    expect(() => monthCostsSoFar('2026-09', '2026-08-31', '2026-09-10', [], [])).toThrow(RangeError)
    expect(() => monthCostsSoFar('2026-09', '2026-09-10', '2026-09-09', [], [])).toThrow(RangeError)
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
/** Each value rounded once to 12 decimals is within half a unit: n values within n × 0.5e-12. */
const tolerance = (count: number) => toDec('0.0000000000005').times(count)

const negate = (value: string | null) =>
  value === null || toDec(value).isZero() ? value : toDec(value).negated().toString()

describe('properties of real profit', () => {
  it('a finished month’s shares add up to its costs (within the 12-decimal rounding of each)', () => {
    fc.assert(
      fc.property(
        fc.array(positive(5000, 2), { minLength: 1, maxLength: 40 }),
        positive(90000, 4),
        (nets, costs) => {
          const sales = nets.reduce((acc, net) => acc.plus(toDec(net)), toDec('0')).toString()
          const rate = monthRate(costs, sales)
          const sum = sumRealProfit(nets.map((net) => line({ net, rate })))
          expect(
            toDec(sum.runningCosts).minus(toDec(costs)).abs().lte(tolerance(nets.length)),
          ).toBe(true)
          const business = businessRealProfit(sum, { state: 'on', costs })
          expect(toDec(business.profit).eq(toDec(sales).minus(toDec(costs)))).toBe(true)
          expect(toDec(business.notCarried!).abs().lte(tolerance(nets.length))).toBe(true)
        },
      ),
    )
  })

  it('a channel’s fees add up to its statements, month part by month part', () => {
    const day = fc
      .integer({ min: 0, max: 120 })
      .map((offset) =>
        new Date(Date.UTC(2026, 8, 1) + offset * 86_400_000).toISOString().slice(0, 10),
      )
    fc.assert(
      fc.property(
        day,
        fc.integer({ min: 0, max: 70 }),
        decimal(9000, 2),
        fc.array(positive(900, 2), { minLength: 1, maxLength: 10 }),
        (from, length, fees, perPart) => {
          const to = new Date(Date.parse(`${from}T00:00:00Z`) + length * 86_400_000)
            .toISOString()
            .slice(0, 10)
          const parts = statementParts({ from, to, fees })
          expect(
            parts.reduce((acc, p) => acc.plus(toDec(p.fees)), toDec('0')).eq(toDec(fees)),
          ).toBe(true)
          let carried = toDec('0')
          for (const part of parts) {
            // The channel's item sales in the part's days: the same lines in each part.
            const sales = perPart.reduce((acc, net) => acc.plus(toDec(net)), toDec('0')).toString()
            const source = channelFeesOf({
              feesExpected: true,
              commissionPercent: null,
              statement: { fees: part.fees, sales },
              expenses: null,
            })
            const lines = perPart.map((net) => line({ net, fees: source }))
            const own = sumRealProfit(lines).fees
            expect(toDec(own).minus(toDec(part.fees)).abs().lte(tolerance(perPart.length))).toBe(
              true,
            )
            carried = carried.plus(toDec(own))
          }
          expect(
            carried
              .minus(toDec(fees))
              .abs()
              .lte(tolerance(perPart.length * parts.length)),
          ).toBe(true)
        },
      ),
    )
  })

  it('a refund mirrors its sale: every part negated', () => {
    const fees: fc.Arbitrary<ChannelFees> = fc.oneof(
      fc.constant({ state: 'none' as const }),
      fc.constant({ state: 'not_entered' as const }),
      decimal(30, 2).map((percent) => ({ state: 'commission' as const, percent })),
      fc.record({
        state: fc.constant('statement' as const),
        fees: decimal(2000, 2),
        sales: positive(20000, 2),
      }),
    )
    fc.assert(
      fc.property(
        positive(2000, 2),
        fc.option(decimal(500, 12), { nil: null }),
        fees,
        positive(30000, 2),
        positive(90000, 2),
        fc.constantFrom('item', 'delivery', 'charge'),
        (net, materials, channel, costs, sales, kind) => {
          const sold: SaleLineProfit = line({
            kind: kind as SaleLineProfitInput['kind'],
            net,
            cost: snapshot(materials),
            fees: channel,
            rate: monthRate(costs, sales),
          })
          const back = line({
            kind: kind as SaleLineProfitInput['kind'],
            net: `-${net}`,
            cost: snapshot(negate(materials)),
            fees: channel,
            rate: monthRate(costs, sales),
          })
          expect(back.sales).toBe(negate(sold.sales))
          expect(back.profit).toBe(negate(sold.profit))
          expect(back.materials.amount).toBe(negate(sold.materials.amount))
          expect(back.fees?.amount ?? null).toBe(negate(sold.fees?.amount ?? null))
          expect(back.runningCosts?.amount ?? null).toBe(negate(sold.runningCosts?.amount ?? null))
          expect(back.reasons).toEqual(sold.reasons)
        },
      ),
    )
  })

  it('the costs so far over a whole month are the month’s costs; over its days they add up within rounding', () => {
    const cost: fc.Arbitrary<PoolRunningCost> = fc
      .record({
        id: fc.constantFrom('a', 'b', 'c', 'd'),
        name: fc.constantFrom('Rent', 'Power'),
        categoryId: fc.constantFrom('rent', 'power'),
        amount: positive(20000, 2),
        frequency: fc.constantFrom('weekly', 'monthly', 'quarterly', 'yearly'),
        startsOn: fc.constantFrom('2026-01-01', '2026-09-05', '2026-09-16', '2026-10-01'),
        endsOn: fc.constantFrom(null, '2026-09-16', '2026-09-25', '2026-12-01'),
      })
      .filter((rc) => rc.endsOn === null || rc.endsOn >= rc.startsOn)
    const expense: fc.Arbitrary<PoolExpense> = fc.record({
      categoryId: fc.constantFrom('rent', 'power', 'ads'),
      runningCostId: fc.constantFrom(null, 'a', 'b'),
      cost: decimal(5000, 2),
      month: fc.constantFrom('2026-08', '2026-09'),
      reversedIn: fc.constantFrom(null, '2026-09'),
    })
    fc.assert(
      fc.property(
        fc.uniqueArray(cost, { selector: (rc) => rc.id, maxLength: 4 }),
        fc.array(expense, { maxLength: 5 }),
        fc.integer({ min: 2, max: 29 }),
        (costs, expenses, cut) => {
          const pool = costPool('2026-09', costs, expenses)
          const whole = monthCostsSoFar('2026-09', '2026-09-01', '2026-09-30', costs, expenses)
          expect(whole.total).toBe(pool.total)
          const day = (n: number) => `2026-09-${String(n).padStart(2, '0')}`
          const first = monthCostsSoFar('2026-09', day(1), day(cut), costs, expenses)
          const rest = monthCostsSoFar('2026-09', day(cut + 1), day(30), costs, expenses)
          const lines = pool.categories.reduce((n, category) => n + category.lines.length + 4, 0)
          expect(
            toDec(first.total)
              .plus(toDec(rest.total))
              .minus(toDec(pool.total))
              .abs()
              .lte(tolerance(2 * lines)),
          ).toBe(true)
        },
      ),
    )
  })
})
