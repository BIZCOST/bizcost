import { PER_YEAR, type RunningCostFrequency } from '../expenses/keys'
import {
  addMonths,
  BUSINESS_MONTH_PATTERN,
  firstDayOf,
  monthOf,
  type BusinessMonth,
} from '../expenses/period'
import { exactProduct, plain, roundHalfUp, toDec } from '../numbers/decimal'
import { COST_SCALE, type CostAmount } from '../numbers/kinds'

// How the business's running costs reach what it sells (D-202, the owner's decision of 2026-09-30,
// which replaces D-116's share of the material cost): nothing is typed in for it; each product and
// service carries the business's costs in proportion to its price.
//
//   cost rate      = the month's costs ÷ the month's sales (before VAT)
//   a unit's share = its price before VAT × the month's costs ÷ the month's sales
//
// Costs of 20 000 and sales of 80 000 make 25 %: a AED 400 service carries 100, an AED 18 latte 4.50.
// The share is an exact product divided once, never the rounded rate × the price (D-107), and nothing
// is rounded to the currency.
//
// The month's costs ("the pool") count every running cost and expense ONCE (D-202, D-203):
//   - an expense counts in the month it belongs to (`period_month`, D-194), finalized ones only, at
//     what it cost the business (`cost_total`: without the VAT a VAT-registered business reclaims,
//     the basis of running costs too);
//   - a running cost counts its regular amount for the days of the month it ran (its monthly amount
//     × the days from `starts_on` up to the day before `ends_on` ÷ the days of the month), so a rent
//     that changes mid-month is counted once;
//   - per category, its bills REPLACE its running costs' regular amount, never both, over the period
//     they pay for: the month, or, for a category with a quarterly or yearly running cost, that
//     running cost's quarter or year (counted from the month it started; with several, the longest,
//     then the first started). A quarter's or a year's bills are spread evenly over its months, so a
//     yearly licence of 15 000 and its one bill count 1 250 a month, 15 000 over the year. A
//     category without bills for the period counts its regular amount; other expenses count as
//     themselves;
//   - a reversal (D-200) within the bill's own period takes it back as if it were never posted; one
//     counted later (its month's books were closed: `reversal_period_month`) leaves the bill where it
//     counted and takes its amount back in the month the reversal counts in, on top of what that
//     month counts for the category (its bills, or its regular amount): it never replaces anything.
// Material purchases are not in it (materials are each product's own line) and neither is the
// owner's time (D-119). Sales arrive in Phase 3: until then there is nothing to divide by and every
// share is "awaiting sales".

/** A running cost as the month's costs read it (`running_costs`, D-169). */
export interface PoolRunningCost {
  readonly categoryId: string
  /** The regular amount (more than zero), what it costs the business each period. */
  readonly amount: string
  readonly frequency: RunningCostFrequency
  /** YYYY-MM-DD: the first day it counts. */
  readonly startsOn: string
  /** YYYY-MM-DD: the day it stopped (it no longer counts from that day); null: still paid. */
  readonly endsOn: string | null
}

/** A finalized expense (posted, or posted then reversed) as the month's costs read it. */
export interface PoolExpense {
  readonly categoryId: string
  /** What it cost the business (`expenses.cost_total`, zero or more). */
  readonly cost: string
  /** The month it belongs to (`period_month`, YYYY-MM). */
  readonly month: BusinessMonth
  /**
   * Null while it stands. Reversed: the month its reversal counts in (`reversal_period_month`, or its
   * own month when that is null), never before its own month.
   */
  readonly reversedIn: BusinessMonth | null
}

/**
 * Where a category's amount for the month comes from: its bills (of the month, or of the quarter or
 * year they pay for), its running costs' regular amount, or only what a reversal takes back.
 */
export const POOL_SOURCES = ['bills', 'regular', 'taken_back'] as const
export type PoolSource = (typeof POOL_SOURCES)[number]

/** The quarter or year a category's bills pay for (D-203), spread evenly over its months. */
export interface PoolPeriod {
  /** Its first and last month (YYYY-MM). */
  readonly from: BusinessMonth
  readonly to: BusinessMonth
  /** A quarter (3) or a year (12): its running cost's frequency. */
  readonly months: 3 | 12
  /** Σ of its bills, exact (what is spread over its months). */
  readonly bills: CostAmount
}

export interface PoolCategory {
  readonly categoryId: string
  /** What the category counts in the month (zero or less after a reversal taken back in it). */
  readonly amount: CostAmount
  readonly source: PoolSource
  /**
   * The regular amount of its running costs for the days of the month they ran; null: none ran in
   * it. With bills (`source` `bills`) it is shown beside them and not counted.
   */
  readonly regular: CostAmount | null
  /** With `source` `bills`: the quarter or year its bills pay for; null: the month's own bills. */
  readonly period: PoolPeriod | null
  /**
   * What reversals of earlier months' bills take back in this month (more than zero or zero), already
   * out of `amount`; null: none.
   */
  readonly takenBack: CostAmount | null
}

export interface CostPool {
  readonly month: BusinessMonth
  /** Σ of the categories' amounts, exact. */
  readonly total: CostAmount
  /** Each category with something in the month, by id. */
  readonly categories: readonly PoolCategory[]
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 86_400_000

/** A day as a number of days (YYYY-MM-DD, any year from 0001). */
function dayNumber(day: string): number {
  if (!DAY.test(day)) throw new RangeError(`Not a day: "${day}"`)
  const time = Date.parse(`${day}T00:00:00Z`)
  if (Number.isNaN(time)) throw new RangeError(`Not a day: "${day}"`)
  return Math.round(time / DAY_MS)
}

function checkMonth(month: BusinessMonth): void {
  if (!BUSINESS_MONTH_PATTERN.test(month)) throw new RangeError(`Not a month: "${month}"`)
}

/**
 * The days of `month` (YYYY-MM) on which a running cost counts (runningCostActiveOn): from
 * `startsOn`, up to the day before `endsOn`. 0 when it did not run in the month. Throws RangeError for
 * a malformed day or month, or an end before the start.
 */
export function daysRunIn(
  cost: Pick<PoolRunningCost, 'startsOn' | 'endsOn'>,
  month: BusinessMonth,
): number {
  const days = daysIn(month)
  const first = dayNumber(firstDayOf(month))
  const next = first + days
  const starts = dayNumber(cost.startsOn)
  const ends = cost.endsOn === null ? null : dayNumber(cost.endsOn)
  if (ends !== null && ends < starts) {
    throw new RangeError(`A running cost must not end before it starts: "${cost.endsOn}"`)
  }
  const from = Math.max(first, starts)
  const until = ends === null ? next : Math.min(next, ends)
  return Math.max(0, until - from)
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

/** The days of `month` (28 to 31; the Gregorian calendar, as the database's dates). */
export function daysIn(month: BusinessMonth): number {
  checkMonth(month)
  const year = Number(month.slice(0, 4))
  const index = Number(month.slice(5, 7)) - 1
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  return index === 1 && leap ? 29 : MONTH_DAYS[index]!
}

// ---------------------------------------------------------------------------------------------------
// The period a category's bills pay for (D-203)
// ---------------------------------------------------------------------------------------------------

/** The months a bill of a running cost of this frequency pays for (1: its month). */
const BILLED_MONTHS: Readonly<Record<RunningCostFrequency, 1 | 3 | 12>> = {
  weekly: 1,
  monthly: 1,
  quarterly: 3,
  yearly: 12,
}

/** A month, a quarter or a year: its first and last month. */
interface BillPeriod {
  readonly from: BusinessMonth
  readonly to: BusinessMonth
  readonly months: 1 | 3 | 12
}

/** The months from `from` to `to` (negative when `to` is before it). */
function monthsBetween(from: BusinessMonth, to: BusinessMonth): number {
  const index = (month: BusinessMonth) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7))
  return index(to) - index(from)
}

/**
 * The quarter or year of a quarterly or yearly running cost that holds `month`, counted from the
 * month it started, when it ran in it (it had not stopped by the period's first day, or by its own
 * start in its first period); null otherwise, or for a weekly or monthly one.
 */
function costPeriodOf(cost: PoolRunningCost, month: BusinessMonth): BillPeriod | null {
  const months = BILLED_MONTHS[cost.frequency]
  if (months === 1) return null
  const start = monthOf(cost.startsOn)
  const gone = monthsBetween(start, month)
  if (gone < 0) return null
  const from = addMonths(start, gone - (gone % months))
  const first = firstDayOf(from) > cost.startsOn ? firstDayOf(from) : cost.startsOn
  if (cost.endsOn !== null && cost.endsOn <= first) return null
  return { from, to: addMonths(from, months - 1), months }
}

/**
 * The period a category's bills of `month` pay for (D-203): the quarter or year of its quarterly or
 * yearly running cost that ran in it (the longest, then the first started: it holds the others' bills
 * while it runs), else the month itself. `costs`: the category's running costs.
 */
function billPeriodOf(costs: readonly PoolRunningCost[], month: BusinessMonth): BillPeriod {
  let best: { period: BillPeriod; startsOn: string } | null = null
  for (const cost of costs) {
    const period = costPeriodOf(cost, month)
    if (period === null) continue
    if (
      best === null ||
      period.months > best.period.months ||
      (period.months === best.period.months && cost.startsOn < best.startsOn)
    ) {
      best = { period, startsOn: cost.startsOn }
    }
  }
  return best?.period ?? { from: month, to: month, months: 1 }
}

const samePeriod = (a: BillPeriod, b: BillPeriod) => a.from === b.from && a.to === b.to

/**
 * One category's amount for `month` (see above), or null when nothing of it counts in the month.
 * `costs` and `expenses` are the category's, already checked.
 */
function categoryOf(
  month: BusinessMonth,
  categoryId: string,
  costs: readonly PoolRunningCost[],
  expenses: readonly PoolExpense[],
): PoolCategory | null {
  // Its regular amount: Σ amount × periods a year × days run ÷ (12 × days of the month), divided once.
  let regularSum = toDec('0')
  let ran = false
  for (const cost of costs) {
    const days = daysRunIn(cost, month)
    if (days === 0) continue
    regularSum = regularSum.plus(
      exactProduct([toDec(cost.amount), toDec(PER_YEAR[cost.frequency]), toDec(String(days))]),
    )
    ran = true
  }
  const regular = ran
    ? (plain(roundHalfUp(regularSum.dividedBy(12 * daysIn(month)), COST_SCALE)) as CostAmount)
    : null

  // Its bills of the period that holds the month, and what reversals take back in it.
  const period = billPeriodOf(costs, month)
  let bills = toDec('0')
  let billed = false
  let takenBack = toDec('0')
  let tookBack = false
  for (const expense of expenses) {
    const own = billPeriodOf(costs, expense.month)
    // Reversed within the period it pays for: as if never posted.
    if (expense.reversedIn !== null && expense.reversedIn <= own.to) continue
    if (samePeriod(own, period)) {
      bills = bills.plus(toDec(expense.cost))
      billed = true
    }
    // Reversed after its period: taken back in the month the reversal counts in, on top.
    if (expense.reversedIn === month) {
      takenBack = takenBack.plus(toDec(expense.cost))
      tookBack = true
    }
  }
  if (!billed && !ran && !tookBack) return null

  let base = toDec('0')
  if (billed) {
    // Spread evenly over the months whose bills are this period's (all of them, but where two of the
    // category's running costs hand over from one to the other).
    let months = 1
    if (period.months > 1) {
      months = 0
      for (let i = 0; i < period.months; i += 1) {
        if (samePeriod(billPeriodOf(costs, addMonths(period.from, i)), period)) months += 1
      }
    }
    base = months === 1 ? bills : roundHalfUp(bills.dividedBy(months), COST_SCALE)
  } else if (regular !== null) {
    base = toDec(regular)
  }
  return {
    categoryId,
    amount: plain(base.minus(takenBack)) as CostAmount,
    source: billed ? 'bills' : ran ? 'regular' : 'taken_back',
    regular,
    period:
      billed && period.months !== 1
        ? {
            from: period.from,
            to: period.to,
            months: period.months,
            bills: plain(bills) as CostAmount,
          }
        : null,
    takenBack: tookBack ? (plain(takenBack) as CostAmount) : null,
  }
}

/**
 * The business's costs of `month` (YYYY-MM), counted once (see above): per category its bills for the
 * period that holds the month when it has any (a quarter's or a year's spread over its months), else
 * its running costs' regular amount (divided once and rounded once to 12 decimals), less what
 * reversals of earlier months' bills take back in it; the total is their exact sum. Pure: the caller
 * reads the running costs and the finalized expenses, those of the months around it (a year's bills
 * may be in any month of that year) and the reversals counted in it. Throws RangeError for a
 * malformed month or day, a negative amount, or a reversal counted before its expense's month.
 */
export function costPool(
  month: BusinessMonth,
  runningCosts: readonly PoolRunningCost[],
  expenses: readonly PoolExpense[],
): CostPool {
  checkMonth(month)
  const groups = new Map<string, { costs: PoolRunningCost[]; expenses: PoolExpense[] }>()
  const groupOf = (categoryId: string) => {
    let found = groups.get(categoryId)
    if (!found) {
      found = { costs: [], expenses: [] }
      groups.set(categoryId, found)
    }
    return found
  }
  for (const cost of runningCosts) {
    if (!toDec(cost.amount).gt(0)) {
      throw new RangeError(`A running cost must be more than zero: "${cost.amount}"`)
    }
    // Checks its days (and that it does not end before it starts).
    daysRunIn(cost, month)
    groupOf(cost.categoryId).costs.push(cost)
  }
  for (const expense of expenses) {
    checkMonth(expense.month)
    if (expense.reversedIn !== null) checkMonth(expense.reversedIn)
    if (toDec(expense.cost).lt(0)) {
      throw new RangeError(`An expense must not be negative: "${expense.cost}"`)
    }
    if (expense.reversedIn !== null && expense.reversedIn < expense.month) {
      throw new RangeError(
        `A reversal counts in its expense's month or later: "${expense.reversedIn}"`,
      )
    }
    groupOf(expense.categoryId).expenses.push(expense)
  }
  const categories: PoolCategory[] = []
  let total = toDec('0')
  for (const [categoryId, group] of [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const category = categoryOf(month, categoryId, group.costs, group.expenses)
    if (category === null) continue
    total = total.plus(toDec(category.amount))
    categories.push(category)
  }
  return { month, total: plain(total) as CostAmount, categories }
}

// ---------------------------------------------------------------------------------------------------
// The rate and a unit's share
// ---------------------------------------------------------------------------------------------------

/** Divides once and rounds once to 12 decimals: the exact product of `numerators` ÷ `divisor`. */
function divideOnce(numerators: readonly string[], divisor: string): CostAmount {
  return plain(
    roundHalfUp(exactProduct(numerators.map(toDec)).dividedBy(toDec(divisor)), COST_SCALE),
  ) as CostAmount
}

/**
 * What the running costs are shared by (D-202):
 * - `off`: neither Running Costs nor Expenses is on: there is nothing to share;
 * - `on`: the month's costs (costPool's total) and the same month's sales before VAT (null until
 *   sales are recorded, Phase 3).
 */
export type RunningCostsPart =
  | { readonly state: 'off' }
  | { readonly state: 'on'; readonly costs: string; readonly sales: string | null }

/**
 * The business's cost rate: `off`; `awaiting_sales` (no sales to divide by: none recorded, or they
 * come to zero or less); `none` (the costs come to zero or less: nothing to share, the rate is 0);
 * `ready` (costs ÷ sales).
 */
export const COST_RATE_STATES = ['off', 'awaiting_sales', 'none', 'ready'] as const
export type CostRateState = (typeof COST_RATE_STATES)[number]

/**
 * The month's costs ÷ the month's sales before VAT, rounded once to 12 decimals: 20 000 ÷ 80 000 =
 * 0.25. Null while there are no sales to divide by (null, or not more than zero); 0 when the costs
 * come to zero or less (a reversal counted in a later month can leave a month below zero: it spreads
 * nothing, never a negative share).
 */
export function costRate(part: RunningCostsPart): {
  readonly state: CostRateState
  readonly rate: CostAmount | null
} {
  if (part.state === 'off') return { state: 'off', rate: null }
  if (part.sales === null || !toDec(part.sales).gt(0)) {
    return { state: 'awaiting_sales', rate: null }
  }
  if (!toDec(part.costs).gt(0)) return { state: 'none', rate: '0' as CostAmount }
  return { state: 'ready', rate: divideOnce([part.costs], part.sales) }
}

/**
 * One unit's share of the running costs (D-202): its price before VAT × the month's costs ÷ the
 * month's sales, an exact product divided once and rounded once to 12 decimals (never the rounded rate
 * × the price). AED 18 at 20 000 ÷ 80 000 carries 4.5. Null while there are no sales to divide by; 0
 * when the costs come to zero or less. Throws RangeError for a negative price.
 */
export function costShare(
  priceBeforeVat: string,
  costs: string,
  sales: string | null,
): CostAmount | null {
  if (toDec(priceBeforeVat).lt(0)) {
    throw new RangeError(`A price must not be negative: "${priceBeforeVat}"`)
  }
  if (sales === null || !toDec(sales).gt(0)) return null
  if (!toDec(costs).gt(0)) return '0' as CostAmount
  return divideOnce([priceBeforeVat, costs], sales)
}
