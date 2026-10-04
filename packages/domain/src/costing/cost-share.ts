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
// The month's costs ("the pool") count every running cost and expense ONCE (D-202, D-203, D-216):
//   - an expense counts in the month it belongs to (`period_month`, D-194), finalized ones only, at
//     what it cost the business (`cost_total`: without the VAT a VAT-registered business reclaims,
//     the basis of running costs too);
//   - a running cost counts its regular amount for the days of the month it ran (its monthly amount
//     × the days from `starts_on` up to the day before `ends_on` ÷ the days of the month), so a rent
//     that changes mid-month is counted once;
//   - per RUNNING COST (the owner's decision of 2026-10-01, D-216), its own bills (the expenses that
//     say they pay it, `running_cost_id`) REPLACE its regular amount, never both, over the period
//     they pay for: the month, or, for a quarterly or yearly running cost, its quarter or year
//     (counted from the month it started), spread evenly over its months, so a yearly licence of
//     15 000 and its one bill count 1 250 a month, 15 000 over the year. Its other periods keep its
//     regular amount. A bill replaces only its own running cost: the category's other running costs
//     keep theirs;
//   - a running cost changed mid-month (D-176: one stops on the day another of the same name,
//     category and frequency starts, both paid by the month) is ONE running cost in that month
//     (D-217): one line, its regular amounts added, and a bill of either pays for both, so one rent
//     bill for the month of a rent change counts once, whichever of the two it says it pays;
//   - every other expense counts as itself, on top: an extra (`pays` `extra`), one in a category
//     without running costs, and one whose running cost is not counted (removed since, or Running
//     Costs off);
//   - a reversal (D-200) within the period its expense counts in takes it back as if it were never
//     posted; one counted later (its month's books were closed: `reversal_period_month`) leaves the
//     expense where it counted and takes its amount back in the month the reversal counts in, on top
//     of what that month counts (the running cost's bills or regular amount, or the extras): it never
//     replaces anything.
// Material purchases are not in it (materials are each product's own line) and neither is the
// owner's time (D-119). Sales arrive in Phase 3: until then there is nothing to divide by and every
// share is "awaiting sales".

/** A running cost as the month's costs read it (`running_costs`, D-169). */
export interface PoolRunningCost {
  /** Its id: the expenses that pay it name it (`expenses.running_cost_id`, D-216). */
  readonly id: string
  /**
   * Its name, as the owner typed it: one that stops on the day another of the same name (however it
   * is spaced or cased), category and frequency paid by the month starts is that running cost changed
   * (D-176, D-217).
   */
  readonly name: string
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
  /**
   * The running cost it is a bill of (`running_cost_id`, D-216): it takes the place of that running
   * cost's regular amount over the period it pays for. Null (an extra, an expense in a category
   * without running costs), or a running cost not given: it counts as itself.
   */
  readonly runningCostId: string | null
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

/** What a line of a category is: one of its running costs, or the expenses that count as themselves. */
export const POOL_LINE_KINDS = ['running_cost', 'extra'] as const
export type PoolLineKind = (typeof POOL_LINE_KINDS)[number]

/**
 * Where a line's amount comes from. A running cost: its bills (of the month, or of the quarter or
 * year they pay for), its regular amount, or only what a reversal of an earlier bill takes back. The
 * extras: the expenses of the month, or only what a reversal of an earlier one takes back.
 */
export const POOL_SOURCES = ['bills', 'regular', 'expenses', 'taken_back'] as const
export type PoolSource = (typeof POOL_SOURCES)[number]

/** The month, quarter or year a bill of a running cost pays for (D-203). */
export interface BillPeriod {
  /** Its first and last month (YYYY-MM). */
  readonly from: BusinessMonth
  readonly to: BusinessMonth
  /** A month (1), a quarter (3) or a year (12): its running cost's frequency. */
  readonly months: 1 | 3 | 12
}

/** The quarter or year a running cost's bills pay for (D-203), spread evenly over its months. */
export interface PoolPeriod extends BillPeriod {
  readonly months: 3 | 12
  /** Σ of its bills, exact (what is spread over its months). */
  readonly bills: CostAmount
}

/** One line of a category of the month's costs: a running cost, or the category's extras. */
export interface PoolLine {
  readonly kind: PoolLineKind
  /**
   * The running cost (`kind` running_cost); null for the extras. A running cost changed in the month
   * (D-217): the one that runs at its end (the latest to start), for both.
   */
  readonly runningCostId: string | null
  /** What it counts in the month (zero or less after a reversal taken back in it). */
  readonly amount: CostAmount
  /** running_cost: bills, regular or taken_back; extra: expenses or taken_back. */
  readonly source: PoolSource
  /**
   * A running cost's regular amount for the days of the month it ran (null: it did not run in it);
   * with bills it is shown beside them and not counted. Null for the extras.
   */
  readonly regular: CostAmount | null
  /** A running cost's bills of a quarter or year (`source` bills); null otherwise. */
  readonly period: PoolPeriod | null
  /**
   * What reversals of earlier months take back in this month (more than zero or zero), already out
   * of `amount`; null: none.
   */
  readonly takenBack: CostAmount | null
}

export interface PoolCategory {
  readonly categoryId: string
  /** Σ of its lines, exact. */
  readonly amount: CostAmount
  /** Its running costs with something in the month (by id), then its extras. */
  readonly lines: readonly PoolLine[]
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
// The period a running cost's bill pays for (D-203, D-216)
// ---------------------------------------------------------------------------------------------------

/** The months a bill of a running cost of this frequency pays for (1: its month). */
const BILLED_MONTHS: Readonly<Record<RunningCostFrequency, 1 | 3 | 12>> = {
  weekly: 1,
  monthly: 1,
  quarterly: 3,
  yearly: 12,
}

/** The months from `from` to `to` (negative when `to` is before it). */
function monthsBetween(from: BusinessMonth, to: BusinessMonth): number {
  const index = (month: BusinessMonth) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7))
  return index(to) - index(from)
}

/**
 * The period a bill for `month` pays for of this running cost (D-203, D-216), or null when a bill for
 * that month cannot pay it:
 *   - weekly or monthly: the month itself, when the running cost ran in it (a day or more,
 *     daysRunIn);
 *   - quarterly or yearly: its quarter or year that holds the month, counted from the month it
 *     started, when it ran in that period (it had not stopped by the period's first day, or by its own
 *     start in its first period). Its last period is still paid for after it stopped: a year's bill
 *     pays for the months of its year after the licence was given up.
 * An expense says it pays a running cost only for a month this is not null for (the API checks it);
 * the month's costs spread a bill over this period. Throws RangeError for a malformed day or month.
 */
export function billPeriodOf(
  cost: Pick<PoolRunningCost, 'frequency' | 'startsOn' | 'endsOn'>,
  month: BusinessMonth,
): BillPeriod | null {
  const months = BILLED_MONTHS[cost.frequency]
  if (months === 1) {
    return daysRunIn(cost, month) > 0 ? { from: month, to: month, months } : null
  }
  checkMonth(month)
  // Checks its days (and that it does not end before it starts).
  daysRunIn(cost, month)
  const start = monthOf(cost.startsOn)
  const gone = monthsBetween(start, month)
  if (gone < 0) return null
  const from = addMonths(start, gone - (gone % months))
  const first = firstDayOf(from) > cost.startsOn ? firstDayOf(from) : cost.startsOn
  if (cost.endsOn !== null && cost.endsOn <= first) return null
  return { from, to: addMonths(from, months - 1), months }
}

/** The period that holds `month` for a running cost's bills: its billPeriodOf, else the month. */
function holdingPeriod(cost: PoolRunningCost, month: BusinessMonth): BillPeriod {
  return billPeriodOf(cost, month) ?? { from: month, to: month, months: 1 }
}

const samePeriod = (a: BillPeriod, b: BillPeriod) => a.from === b.from && a.to === b.to

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** A running cost's regular amount for the days of `month` it ran (null: none), divided once. */
function regularOf(cost: PoolRunningCost, month: BusinessMonth): CostAmount | null {
  // amount × periods a year × days run ÷ (12 × days of the month).
  const days = daysRunIn(cost, month)
  if (days === 0) return null
  return plain(
    roundHalfUp(
      exactProduct([
        toDec(cost.amount),
        toDec(PER_YEAR[cost.frequency]),
        toDec(String(days)),
      ]).dividedBy(12 * daysIn(month)),
      COST_SCALE,
    ),
  ) as CostAmount
}

/**
 * A running cost's line for `month` (see above), or null when nothing of it counts in the month.
 * `group`: the running cost, or a running cost changed in the month (D-217, handoversOf: the one
 * that runs at its end first; all paid by the month, so a bill of any of them pays for its own
 * month); `bills`: the expenses that pay any of them, already checked.
 */
function runningCostLine(
  month: BusinessMonth,
  group: readonly PoolRunningCost[],
  bills: readonly PoolExpense[],
): PoolLine | null {
  const cost = group[0]!
  // Its regular amount: each running cost's divided once, then added (exact).
  let regular: CostAmount | null = null
  for (const member of group) {
    const own = regularOf(member, month)
    if (own !== null) {
      regular = (regular === null ? own : plain(toDec(regular).plus(toDec(own)))) as CostAmount
    }
  }

  // Its bills of the period that holds the month, and what reversals take back in it.
  const period = holdingPeriod(cost, month)
  let paid = toDec('0')
  let billed = false
  let takenBack = toDec('0')
  let tookBack = false
  for (const bill of bills) {
    const own = holdingPeriod(cost, bill.month)
    // Reversed within the period it pays for: as if never posted.
    if (bill.reversedIn !== null && bill.reversedIn <= own.to) continue
    if (samePeriod(own, period)) {
      paid = paid.plus(toDec(bill.cost))
      billed = true
    }
    // Reversed after its period: taken back in the month the reversal counts in, on top.
    if (bill.reversedIn === month) {
      takenBack = takenBack.plus(toDec(bill.cost))
      tookBack = true
    }
  }
  if (!billed && regular === null && !tookBack) return null

  let base = toDec('0')
  if (billed) {
    // A quarter's or a year's bills, spread evenly over its months (divided once).
    base = period.months === 1 ? paid : roundHalfUp(paid.dividedBy(period.months), COST_SCALE)
  } else if (regular !== null) {
    base = toDec(regular)
  }
  return {
    kind: 'running_cost',
    runningCostId: cost.id,
    amount: plain(base.minus(takenBack)) as CostAmount,
    source: billed ? 'bills' : regular !== null ? 'regular' : 'taken_back',
    regular,
    period:
      billed && period.months !== 1
        ? {
            from: period.from,
            to: period.to,
            months: period.months,
            bills: plain(paid) as CostAmount,
          }
        : null,
    takenBack: tookBack ? (plain(takenBack) as CostAmount) : null,
  }
}

/** The same name, however it is spaced or cased ("Shop rent" and "shop rent "). */
const nameKey = (name: string) => name.trim().toLocaleLowerCase('en')

/**
 * The running costs changed in `month` (D-176, D-217): one paid by the month (weekly or monthly) that
 * stops on the day another of the same name, category and frequency paid by the month starts, both
 * having run a day of the month, is that running cost changed: in that month they are one. Returns
 * each running cost's group (by id), the one that runs at the end of the month first (the latest to
 * start, then by id); a running cost not changed in the month is a group of its own. Quarterly and
 * yearly ones each keep their own quarter or year (D-216).
 */
function handoversOf(
  month: BusinessMonth,
  costs: ReadonlyMap<string, PoolRunningCost>,
): Map<string, readonly PoolRunningCost[]> {
  const root = new Map<string, string>()
  const find = (id: string): string => {
    let at = id
    while (root.get(at) !== at) at = root.get(at)!
    return at
  }
  const byKey = new Map<string, PoolRunningCost[]>()
  for (const cost of costs.values()) {
    root.set(cost.id, cost.id)
    if (BILLED_MONTHS[cost.frequency] !== 1 || daysRunIn(cost, month) === 0) continue
    const key = JSON.stringify([cost.categoryId, nameKey(cost.name)])
    const list = byKey.get(key)
    if (list) list.push(cost)
    else byKey.set(key, [cost])
  }
  for (const list of byKey.values()) {
    for (const before of list) {
      for (const after of list) {
        if (before !== after && before.endsOn !== null && before.endsOn === after.startsOn) {
          const a = find(before.id)
          const b = find(after.id)
          if (a !== b) root.set(a < b ? b : a, a < b ? a : b)
        }
      }
    }
  }
  const groups = new Map<string, PoolRunningCost[]>()
  for (const cost of costs.values()) {
    const top = find(cost.id)
    const list = groups.get(top)
    if (list) list.push(cost)
    else groups.set(top, [cost])
  }
  const lastFirst = (a: PoolRunningCost, b: PoolRunningCost) =>
    a.startsOn > b.startsOn ? -1 : a.startsOn < b.startsOn ? 1 : byId(a.id, b.id)
  const result = new Map<string, readonly PoolRunningCost[]>()
  for (const list of groups.values()) {
    const ordered = [...list].sort(lastFirst)
    for (const cost of ordered) result.set(cost.id, ordered)
  }
  return result
}

/**
 * A category's extras for `month`: the expenses that count as themselves, in their own month (a
 * reversal in it: as if never posted), less what reversals of earlier months take back in it. Null
 * when none counts in the month.
 */
function extraLine(month: BusinessMonth, expenses: readonly PoolExpense[]): PoolLine | null {
  let counted = toDec('0')
  let any = false
  let takenBack = toDec('0')
  let tookBack = false
  for (const expense of expenses) {
    // Its period is its own month: reversed in it, as if never posted.
    if (expense.reversedIn !== null && expense.reversedIn <= expense.month) continue
    if (expense.month === month) {
      counted = counted.plus(toDec(expense.cost))
      any = true
    }
    if (expense.reversedIn === month) {
      takenBack = takenBack.plus(toDec(expense.cost))
      tookBack = true
    }
  }
  if (!any && !tookBack) return null
  return {
    kind: 'extra',
    runningCostId: null,
    amount: plain(counted.minus(takenBack)) as CostAmount,
    source: any ? 'expenses' : 'taken_back',
    regular: null,
    period: null,
    takenBack: tookBack ? (plain(takenBack) as CostAmount) : null,
  }
}

/**
 * The business's costs of `month` (YYYY-MM), counted once (see above): per running cost its own bills
 * for the period that holds the month when it has any (a quarter's or a year's spread over its
 * months), else its regular amount (divided once and rounded once to 12 decimals), less what
 * reversals of its earlier bills take back in it (a running cost changed in the month: one line for
 * both, D-217); every other expense as itself; grouped by category
 * (a running cost's line under its own category), each category and the total their exact sums.
 * Pure: the caller reads the running costs and the finalized expenses, those of the months around it
 * (a year's bills may be in any month of that year) and the reversals counted in it. Throws RangeError
 * for a malformed month or day, a running cost given twice or not more than zero, a negative expense,
 * or a reversal counted before its expense's month.
 */
export function costPool(
  month: BusinessMonth,
  runningCosts: readonly PoolRunningCost[],
  expenses: readonly PoolExpense[],
): CostPool {
  checkMonth(month)
  const costs = new Map<string, PoolRunningCost>()
  for (const cost of runningCosts) {
    if (!toDec(cost.amount).gt(0)) {
      throw new RangeError(`A running cost must be more than zero: "${cost.amount}"`)
    }
    if (costs.has(cost.id)) throw new RangeError(`A running cost given twice: "${cost.id}"`)
    // Checks its days (and that it does not end before it starts).
    daysRunIn(cost, month)
    costs.set(cost.id, cost)
  }
  const bills = new Map<string, PoolExpense[]>()
  const extras = new Map<string, PoolExpense[]>()
  const push = (map: Map<string, PoolExpense[]>, key: string, expense: PoolExpense) => {
    const list = map.get(key)
    if (list) list.push(expense)
    else map.set(key, [expense])
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
    // The bill of a running cost that is counted; anything else counts as itself.
    if (expense.runningCostId !== null && costs.has(expense.runningCostId)) {
      push(bills, expense.runningCostId, expense)
    } else {
      push(extras, expense.categoryId, expense)
    }
  }
  const lines = new Map<string, PoolLine[]>()
  const add = (categoryId: string, line: PoolLine | null) => {
    if (line === null) return
    const list = lines.get(categoryId)
    if (list) list.push(line)
    else lines.set(categoryId, [line])
  }
  // Per running cost, or per running cost changed in the month (D-217: one line, under the
  // category they share).
  const groups = handoversOf(month, costs)
  for (const id of [...costs.keys()].sort(byId)) {
    const group = groups.get(id)!
    if (group[0]!.id !== id) continue
    const paying = group.flatMap((member) => bills.get(member.id) ?? [])
    add(group[0]!.categoryId, runningCostLine(month, group, paying))
  }
  for (const categoryId of [...extras.keys()].sort(byId)) {
    add(categoryId, extraLine(month, extras.get(categoryId)!))
  }
  const categories: PoolCategory[] = []
  let total = toDec('0')
  for (const categoryId of [...lines.keys()].sort(byId)) {
    const list = lines.get(categoryId)!
    const amount = list.reduce((sum, line) => sum.plus(toDec(line.amount)), toDec('0'))
    total = total.plus(amount)
    categories.push({ categoryId, amount: plain(amount) as CostAmount, lines: list })
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
