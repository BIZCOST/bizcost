import { describe, expect, it } from 'vitest'
import { toDec } from '../numbers/decimal'
import type { CostAmount } from '../numbers/kinds'
import { dayNumber } from './cost-share'
import {
  businessRealProfit,
  costsSpanOf,
  FIRST_MONTH_DAYS,
  monthCostsSoFar,
  rateCostsOf,
  rateSourceOf,
  saleLineProfit,
  saleRate,
  sumRealProfit,
} from './real-profit'
import type { SaleLineCost } from './sale-cost'

// Adversary cases for real profit (M3 Step 1, D-223; the owner's answer Q6 of D-218): "A first month
// counts its costs from that sale, so far, and shows a rate once 7 days of sales exist", "the running
// month uses the last full month's rate", "never 2,400 % on day 3", and "none and applied replace
// awaiting_sales once sales exist" (plan Step 1). Each case below failed against the engine as first
// built; they now guard the fixes recorded in D-223.

const rent = (cost: string) => ({
  categoryId: 'rent',
  runningCostId: null,
  cost,
  month: '2026-09' as const,
  reversedIn: null,
})
const noMaterials: SaleLineCost = {
  basis: 'none',
  materials: [],
  cost: null,
  time: { state: 'team' },
}
const daysOf = (from: string, to: string) => dayNumber(to) - dayNumber(from) + 1

describe('a first month that starts in its last days (Q6)', () => {
  it('a rate that shows is never worked out from fewer than 7 days of sales', () => {
    // The café opens on 30 September. On 6 October it has 7 days of sales (30 Sep … 6 Oct), so a rate
    // shows, worked out over those 7 days: never 30 September alone, one day of sales.
    for (const [month, today] of [
      ['2026-10', '2026-10-06'],
      ['2026-10', '2026-10-31'],
    ] as const) {
      const source = rateSourceOf(month, today, '2026-09-30', '2026-09')!
      expect(source.shown).toBe(true)
      expect(source.from).not.toBeNull()
      expect(daysOf(source.from!, source.to!)).toBeGreaterThanOrEqual(FIRST_MONTH_DAYS)
    }
    // September itself, once over, keeps its own day: its sales carry exactly what the business takes
    // off for it (a finished month is exact; D-223).
    expect(rateSourceOf('2026-09', '2026-10-06', '2026-09-30', null)).toMatchObject({
      from: '2026-09-30',
      to: '2026-09-30',
    })
  })

  it('an October latte at AED 18.00 never carries 24.00 of running costs from one opening day', () => {
    // Rent 20,000 for September: 30 September counts 666.666666666667 of it. Each day sells 500
    // before VAT. Priced on the opening day alone, every October sale would carry 133 % of its price.
    const source = rateSourceOf('2026-10', '2026-10-06', '2026-09-30', '2026-09')!
    const costs = rateCostsOf(source, [], [rent('20000')])
    const sales = toDec('500').times(daysOf(source.from!, source.to!)).toString()
    const rate = saleRate({ on: true, source, costs, sales })
    const latte = saleLineProfit({
      kind: 'item',
      net: '18',
      cost: noMaterials,
      materialsRequired: false,
      fees: { state: 'none' },
      rate,
    })
    // 18 × 666.67 ÷ 500 = 24.00 would be more than the latte's price.
    expect(toDec(latte.runningCosts!.amount ?? '0').lte(toDec('18'))).toBe(true)
  })
})

describe('the business total of a first month’s first days', () => {
  it('never says "before running costs" while it has taken the running costs so far off', () => {
    // First sale 1 September; on the 3rd the lines are before running costs (fewer than 7 days), and
    // businessRealProfit subtracts 1–3 September's costs: 20,000 × 3 ÷ 30 = 2,000.
    const source = rateSourceOf('2026-09', '2026-09-03', '2026-09-01', null)
    const rate = saleRate({ on: true, source, costs: '2000', sales: '1000' })
    const sold = saleLineProfit({
      kind: 'item',
      net: '1000',
      cost: noMaterials,
      materialsRequired: false,
      fees: { state: 'none' },
      rate,
    })
    const span = costsSpanOf('2026-09', '2026-09-03', '2026-09-01')!
    const costs = monthCostsSoFar('2026-09', span.from, span.to, [], [rent('20000')]).total
    expect(costs).toBe('2000' as CostAmount)
    const business = businessRealProfit(sumRealProfit([sold]), { state: 'on', costs })
    expect(business.profit).toBe('-1000')
    // The profit already has the 2,000 taken off, so it is not flagged "before running costs".
    expect(business.beforeRunningCosts && !toDec(business.monthCosts!).isZero()).toBe(false)
  })
})

describe('the running month after a month without sales (Q6, plan Step 1)', () => {
  it('a business with sales is never "awaiting sales" because last month sold nothing', () => {
    // A home baker sold from June, took August off (no sales), and sells again in September. On 10
    // September her sales carry the last month that sold (July), never August's item sales of 0.
    const source = rateSourceOf('2026-09', '2026-09-10', '2026-06-05', '2026-07')
    expect(source).toMatchObject({ basis: 'last_month', month: '2026-07' })
    const rate = saleRate({ on: true, source, costs: '1000', sales: '4000' })
    expect(rate.state).not.toBe('awaiting_sales')
    // With no month before it that sold, September counts its own so far (sales of 900 by the 10th).
    const own = rateSourceOf('2026-09', '2026-09-10', '2026-06-05', null)
    expect(own).toMatchObject({ basis: 'so_far', month: '2026-09', shown: true })
    expect(saleRate({ on: true, source: own, costs: '333', sales: '900' }).state).not.toBe(
      'awaiting_sales',
    )
  })
})
