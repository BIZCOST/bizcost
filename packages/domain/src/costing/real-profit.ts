import type { SaleLineKind } from '../documents/sale'
import { PER_YEAR } from '../expenses/keys'
import {
  addMonths,
  BUSINESS_MONTH_PATTERN,
  firstDayOf,
  monthOf,
  type BusinessMonth,
} from '../expenses/period'
import { exactProduct, plain, roundHalfUp, toDec } from '../numbers/decimal'
import { COST_SCALE, type CostAmount } from '../numbers/kinds'
import {
  costPool,
  costRate,
  costShare,
  dayNumber,
  daysIn,
  daysRunIn,
  handoversOf,
  type PoolExpense,
  type PoolRunningCost,
} from './cost-share'
import type { OwnerTimeState } from './product-cost'
import type { SaleLineCost } from './sale-cost'

// Real profit (M3 Step 1, D-223; the owner's answers Q6–Q8 of D-218), worked out on read from the
// posted sales and their frozen snapshots (sale-cost.ts), the month's costs (costPool, D-202, D-203,
// D-216), the channels' fees and the owner's time. Nothing is stored.
//
//   real profit = sales before VAT − materials − channel fees − delivery cost − running-cost share
//                 − the owner's time (without a team, Q7)
//
// Each part has a state, and nothing missing is ever 0: a part not known yet is left out (null) and
// says why (`reasons`), and the profit is worked out on what is known.
//   - The share is worked out at the price actually sold: line net × the month's costs ÷ the month's
//     item sales before VAT, one exact division rounded once to 12 decimals (costShare, D-202). Only
//     item lines carry one; delivery charged meets its own cost (delivery margin = charged − what it
//     cost), and a charge (a service charge) is a sale that carries none. A month whose item sales
//     come to zero or less carries no share (D-202).
//   - Which month's rate (Q6, rateSourceOf): a finished month its own costs ÷ its own item sales
//     (`month`); the running month the last full month's rate (`last_month`: the latest month that
//     sold, so a month off never leaves a month's sales without one); the month of the first finalized
//     sale its costs from that sale's day ÷ its item sales (`so_far`, monthCostsSoFar), shown once 7
//     days of sales exist (the first sale's day is the first), "before running costs" until then. A
//     rate shown while a month runs is never worked out from fewer than 7 days of sales: a first month
//     with fewer runs on into the month after it. One rate for the whole business.
//   - The business's real profit (businessRealProfit) subtracts the month's costs themselves: whole
//     in a finished month, so far in the running one, from the first sale in a first month
//     (costsSpanOf). The views by product, channel and branch carry shares; the line "Running costs
//     not carried by this month's sales" holds the difference: zero in a finished month (within the
//     12-decimal rounding of each share), not zero in a first month or the running one.
//   - Channel fees stay with their channel, never in running costs (Q8): a channel's fees for a
//     period ÷ its item sales in that period × the line's net, one division. From the posted
//     statement that covers the line's day (its part in the line's month: a statement over two months
//     is split between them by days, statementParts), else the expenses marked as that channel's fees
//     for the month, else the channel's commission %. A channel without any fees (the shop's counter)
//     carries none; a delivery app or marketplace without any says "before app fees".
//   - A refund or credit (a negative net) mirrors its sale: every part negated.

const DAY_MS = 86_400_000

/** A day number back as YYYY-MM-DD. */
function dayString(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10)
}

function checkMonth(month: BusinessMonth): void {
  if (!BUSINESS_MONTH_PATTERN.test(month)) throw new RangeError(`Not a month: "${month}"`)
}

/** The last day of `month` (YYYY-MM-DD). */
function lastDayOf(month: BusinessMonth): string {
  return `${month}-${String(daysIn(month)).padStart(2, '0')}`
}

/** Checks today and the first sale's day (never after today: nothing is sold in the future). */
function checkSaleDays(today: string, firstSaleDay: string | null): void {
  const now = dayNumber(today)
  if (firstSaleDay !== null && dayNumber(firstSaleDay) > now) {
    throw new RangeError(`The first sale is after today: "${firstSaleDay}"`)
  }
}

/** Divides once and rounds once to 12 decimals: the exact product of `numerators` ÷ `divisor`. */
function divideOnce(numerators: readonly string[], divisor: string): CostAmount {
  return plain(
    roundHalfUp(exactProduct(numerators.map(toDec)).dividedBy(toDec(divisor)), COST_SCALE),
  ) as CostAmount
}

/** `value` in the sign of `net` (for a share worked out on a net's size). */
function inSignOf(net: string, value: CostAmount): CostAmount {
  return toDec(net).lt(0) && !toDec(value).isZero()
    ? (plain(toDec(value).negated()) as CostAmount)
    : value
}

const add = (values: readonly (string | null)[]): CostAmount =>
  plain(
    values.reduce((acc, value) => (value === null ? acc : acc.plus(toDec(value))), toDec('0')),
  ) as CostAmount

// ---------------------------------------------------------------------------------------------------
// The month's costs so far
// ---------------------------------------------------------------------------------------------------

/** The month's costs counted over some of its days (monthCostsSoFar). */
export interface CostsSoFar {
  readonly month: BusinessMonth
  /** The first and last day counted (YYYY-MM-DD, within the month). */
  readonly from: string
  readonly to: string
  /** The days counted, from … to. */
  readonly days: number
  /** Σ of the categories, exact. */
  readonly total: CostAmount
  /** Each category with something in the month (costPool's), its amount so far. */
  readonly categories: readonly { readonly categoryId: string; readonly amount: CostAmount }[]
}

/**
 * The days of `month` whose costs the business's real profit subtracts (Q6): the whole month once it
 * is over, up to `today` while it runs, and from the first finalized sale's day in the month of that
 * sale. Null for a month before the first sale (nothing sold: nothing to set against). Throws
 * RangeError for a malformed day or month, or a month after today's.
 */
export function costsSpanOf(
  month: BusinessMonth,
  today: string,
  firstSaleDay: string | null,
): { readonly from: string; readonly to: string } | null {
  checkMonth(month)
  checkSaleDays(today, firstSaleDay)
  if (month > monthOf(today)) throw new RangeError(`A month after today: "${month}"`)
  if (firstSaleDay === null || monthOf(firstSaleDay) > month) return null
  const from = monthOf(firstSaleDay) === month ? firstSaleDay : firstDayOf(month)
  return { from, to: monthOf(today) === month ? today : lastDayOf(month) }
}

/**
 * The month's costs over the days `from` … `to` of it (both within `month`): each running cost for the
 * days it ran in them (its regular amount × days ÷ the month's days, divided once), and the month's
 * bills and expenses (and what reversals take back in it) spread evenly over its days, counted for
 * those days. Built on costPool (each running cost, bill and extra counted once, D-202, D-216, D-217)
 * and daysRunIn. Over the whole month it is costPool's total exactly. The first month's rent bill of
 * 6,000 counts 6,000 × 15 ÷ 30 = 3,000 on the 15th of a 30-day month. Throws RangeError as costPool
 * does, and for days outside the month or `to` before `from`.
 */
export function monthCostsSoFar(
  month: BusinessMonth,
  from: string,
  to: string,
  runningCosts: readonly PoolRunningCost[],
  expenses: readonly PoolExpense[],
): CostsSoFar {
  const pool = costPool(month, runningCosts, expenses)
  if (monthOf(from) !== month || monthOf(to) !== month) {
    throw new RangeError(`The days must be within ${month}: "${from}" … "${to}"`)
  }
  const first = dayNumber(from)
  const last = dayNumber(to)
  if (last < first) throw new RangeError(`"${to}" is before "${from}"`)
  const days = last - first + 1
  const monthDays = daysIn(month)
  const byId = new Map(runningCosts.map((cost) => [cost.id, cost] as const))
  const groups = handoversOf(month, byId)
  /** Spread evenly over the month's days, for the days counted (divided once). */
  const spread = (amount: string) => divideOnce([amount, String(days)], String(monthDays))
  /** A running cost's regular amount for the days of from … to it ran (divided once). */
  const regularSoFar = (cost: PoolRunningCost): CostAmount => {
    const starts = Math.max(dayNumber(cost.startsOn), first)
    const ends = Math.min(cost.endsOn === null ? last + 1 : dayNumber(cost.endsOn), last + 1)
    const ran =
      ends <= starts
        ? 0
        : daysRunIn({ startsOn: dayString(starts), endsOn: dayString(ends) }, month)
    return divideOnce([cost.amount, PER_YEAR[cost.frequency], String(ran)], String(12 * monthDays))
  }
  const categories = pool.categories.map((category) => {
    const amounts = category.lines.map((line) => {
      if (line.kind === 'running_cost' && line.source === 'regular') {
        const group = groups.get(line.runningCostId!) ?? []
        const regular = add(group.map(regularSoFar))
        return line.takenBack === null
          ? regular
          : (plain(toDec(regular).minus(toDec(spread(line.takenBack)))) as CostAmount)
      }
      return spread(line.amount)
    })
    return { categoryId: category.categoryId, amount: add(amounts) }
  })
  return { month, from, to, days, total: add(categories.map((c) => c.amount)), categories }
}

// ---------------------------------------------------------------------------------------------------
// Which month's rate (Q6)
// ---------------------------------------------------------------------------------------------------

/** Where the running-cost rate comes from (Q6). */
export const RATE_BASES = ['month', 'last_month', 'so_far'] as const
export type RateBasis = (typeof RATE_BASES)[number]

/** Days of sales a rate worked out so far needs before it shows (its first day is the first). */
export const FIRST_MONTH_DAYS = 7

export interface RateSource {
  readonly basis: RateBasis
  /** The month whose costs and item sales give the rate (with `from` … `to`: the month of `to`). */
  readonly month: BusinessMonth
  /**
   * The days whose costs (rateCostsOf) and item sales give the rate; null: the whole month. A first
   * month's run from the first sale's day up to today or its last day; in the month after a first month
   * with fewer than 7 days of sales, from the first sale (in the month before) up to today; in a
   * running month no earlier month gives a rate to, from its 1st up to today.
   */
  readonly from: string | null
  readonly to: string | null
  /** False while fewer than 7 days have passed since `from`: "before running costs". */
  readonly shown: boolean
}

/**
 * The rate the sales of `month` carry (Q6), never worked out ahead of 7 days of sales:
 * - once it is over, `month`: its own costs ÷ its own item sales (a first month: from its first sale);
 * - the month of the first finalized sale, while it runs, `so_far`: its costs from that sale's day ÷
 *   its item sales, shown once 7 days of sales exist (the first sale's day is the first);
 * - the month after a first month with fewer than 7 days of sales (a first sale in its last 6 days),
 *   while it runs, `so_far` from that first sale: the first month's days run on into it until 7 exist,
 *   so an opening day's rate never prices a whole month;
 * - any other running month, `last_month`: the rate of `lastSoldMonth`, the latest month before it
 *   whose item sales came to more than zero (the month before, unless it sold nothing: a home baker
 *   back from a month off carries the month before it). Without one (or only a first month with fewer
 *   than 7 days of sales), `so_far` from its own 1st, shown from its 7th.
 * Null when nothing was sold by the end of `month` (awaiting sales). Throws RangeError for a malformed
 * day or month, a month after today's, or a `lastSoldMonth` not before `month` or before the first sale.
 */
export function rateSourceOf(
  month: BusinessMonth,
  today: string,
  firstSaleDay: string | null,
  lastSoldMonth: BusinessMonth | null,
): RateSource | null {
  checkMonth(month)
  checkSaleDays(today, firstSaleDay)
  const now = dayNumber(today)
  if (month > monthOf(today)) throw new RangeError(`A month after today: "${month}"`)
  if (lastSoldMonth !== null) {
    checkMonth(lastSoldMonth)
    if (lastSoldMonth >= month || firstSaleDay === null || lastSoldMonth < monthOf(firstSaleDay)) {
      throw new RangeError(`Not a month sold in before ${month}: "${lastSoldMonth}"`)
    }
  }
  if (firstSaleDay === null) return null
  const first = monthOf(firstSaleDay)
  if (first > month) return null
  const running = month === monthOf(today)
  /** Its days from `from` up to `to`, shown once 7 days have passed since `from`. */
  const soFar = (from: string, to: string): RateSource => ({
    basis: 'so_far',
    month,
    from,
    to,
    shown: now - dayNumber(from) + 1 >= FIRST_MONTH_DAYS,
  })
  if (month === first) return soFar(firstSaleDay, running ? today : lastDayOf(month))
  if (!running) return { basis: 'month', month, from: null, to: null, shown: true }
  // A first month with fewer than 7 days of sales gives no rate to another month.
  const short = dayNumber(lastDayOf(first)) - dayNumber(firstSaleDay) + 1 < FIRST_MONTH_DAYS
  if (short && addMonths(month, -1) === first) return soFar(firstSaleDay, today)
  if (lastSoldMonth === null || (short && lastSoldMonth === first)) {
    return soFar(firstDayOf(month), today)
  }
  return lastSoldMonth === first
    ? { basis: 'last_month', month: first, from: firstSaleDay, to: lastDayOf(first), shown: true }
    : { basis: 'last_month', month: lastSoldMonth, from: null, to: null, shown: true }
}

/**
 * The costs a rate divides (rateSourceOf): the whole month's (costPool's total), or those of its days
 * (monthCostsSoFar), month by month where they run on from a short first month into the next, added.
 * The caller gives the running costs and finalized expenses of those months and the months around them
 * (as costPool reads them), and divides by the item sales of the same days. Throws RangeError as
 * costPool and monthCostsSoFar do.
 */
export function rateCostsOf(
  source: RateSource,
  runningCosts: readonly PoolRunningCost[],
  expenses: readonly PoolExpense[],
): CostAmount {
  if (source.from === null || source.to === null) {
    return costPool(source.month, runningCosts, expenses).total
  }
  const parts: CostAmount[] = []
  for (let month = monthOf(source.from); month <= monthOf(source.to); month = addMonths(month, 1)) {
    const from = month === monthOf(source.from) ? source.from : firstDayOf(month)
    const to = month === monthOf(source.to) ? source.to : lastDayOf(month)
    parts.push(monthCostsSoFar(month, from, to, runningCosts, expenses).total)
  }
  return add(parts)
}

/**
 * The share's state on a sale: `off` (neither Running Costs nor Expenses is on); `awaiting_sales`
 * (no item sales to divide by); `before_running_costs` (a rate worked out so far, before 7 days of
 * sales: a first month's first days); `none` (the costs come to zero or less: a share of 0);
 * `applied`.
 */
export const SALE_SHARE_STATES = [
  'off',
  'awaiting_sales',
  'before_running_costs',
  'none',
  'applied',
] as const
export type SaleShareState = (typeof SALE_SHARE_STATES)[number]

export interface SaleRate {
  readonly state: SaleShareState
  readonly source: RateSource | null
  /** The costs divided (the month's, or so far) and the item sales they are divided by. */
  readonly costs: string | null
  readonly sales: string | null
  /** costs ÷ sales (12 decimals); 0 when `none`; null otherwise. */
  readonly rate: CostAmount | null
}

/**
 * The rate a sale's lines carry, from the source rateSourceOf gave and the costs (rateCostsOf) and item
 * sales of its month, or of its days: costs ÷ sales, rounded once (costRate). `costs` and `sales` are
 * needed only when the source shows. Throws RangeError for a source that shows without its costs.
 */
export function saleRate(input: {
  readonly on: boolean
  readonly source: RateSource | null
  readonly costs: string | null
  readonly sales: string | null
}): SaleRate {
  const none = { costs: null, sales: null, rate: null }
  if (!input.on) return { state: 'off', source: input.source, ...none }
  if (input.source === null) return { state: 'awaiting_sales', source: null, ...none }
  if (!input.source.shown) return { state: 'before_running_costs', source: input.source, ...none }
  if (input.costs === null) throw new RangeError('A rate that shows needs its costs')
  const { state, rate } = costRate({ state: 'on', costs: input.costs, sales: input.sales })
  if (state === 'awaiting_sales') return { state, source: input.source, ...none }
  return {
    state: state === 'none' ? 'none' : 'applied',
    source: input.source,
    costs: input.costs,
    sales: input.sales,
    rate,
  }
}

/** A line net's share of the running costs (null unless `applied` or `none`), in the net's sign. */
function shareOf(net: string, rate: SaleRate): CostAmount | null {
  if (rate.state === 'none') return '0' as CostAmount
  if (rate.state !== 'applied') return null
  const share = costShare(plain(toDec(net).abs()), rate.costs!, rate.sales)
  return share === null ? null : inSignOf(net, share)
}

// ---------------------------------------------------------------------------------------------------
// Channel fees (Q8)
// ---------------------------------------------------------------------------------------------------

/** A posted statement of a channel: its period and its fees (before VAT). */
export interface FeeStatement {
  readonly from: string
  readonly to: string
  readonly fees: string
}

/** A statement's part in one month (statementParts). */
export interface StatementPart {
  readonly month: BusinessMonth
  readonly from: string
  readonly to: string
  readonly days: number
  /** fees × its days ÷ the statement's days (one division); the last part takes the rest. */
  readonly fees: CostAmount
}

/**
 * A statement split between the months it covers by days, one division each, the last part the rest
 * so the parts add up to its fees exactly: 2,480 for 16 Oct–15 Nov is 1,280 in October (16 days) and
 * 1,200 in November (15). Throws RangeError for a malformed day, an end before the start or negative
 * fees.
 */
export function statementParts(statement: FeeStatement): StatementPart[] {
  const first = dayNumber(statement.from)
  const last = dayNumber(statement.to)
  if (last < first) throw new RangeError(`A statement ends before it starts: "${statement.to}"`)
  if (toDec(statement.fees).lt(0)) {
    throw new RangeError(`Fees must not be negative: "${statement.fees}"`)
  }
  const total = last - first + 1
  const parts: StatementPart[] = []
  let given = toDec('0')
  for (
    let month = monthOf(statement.from);
    month <= monthOf(statement.to);
    month = addMonths(month, 1)
  ) {
    const from = month === monthOf(statement.from) ? statement.from : firstDayOf(month)
    const to = month === monthOf(statement.to) ? statement.to : lastDayOf(month)
    const days = dayNumber(to) - dayNumber(from) + 1
    const isLast = month === monthOf(statement.to)
    const fees = isLast
      ? (plain(toDec(statement.fees).minus(given)) as CostAmount)
      : divideOnce([statement.fees, String(days)], String(total))
    given = given.plus(toDec(fees))
    parts.push({ month, from, to, days, fees })
  }
  return parts
}

/**
 * Where a line's channel fees come from: `none` (a channel that keeps nothing of a sale), `statement`
 * (the part of the posted statement covering its day, in its month), `expenses` (the expenses marked as
 * the channel's fees for the month), `commission` (the channel's %), `not_entered` (a delivery app or
 * marketplace with none of them: "before app fees").
 */
export const FEE_STATES = ['none', 'statement', 'expenses', 'commission', 'not_entered'] as const
export type FeeState = (typeof FEE_STATES)[number]

export type ChannelFees =
  | { readonly state: 'none' | 'not_entered' }
  | {
      readonly state: 'statement' | 'expenses'
      /** The fees of the period (a statement's part in the month, or the month's marked expenses). */
      readonly fees: string
      /** The channel's item sales before VAT in the same days. */
      readonly sales: string
    }
  | { readonly state: 'commission'; readonly percent: string }

/**
 * A channel's fees for a line (Q8): the statement covering the line's day, else the month's marked
 * expenses, else the commission %; without any, `not_entered` for a channel that keeps a part of each
 * sale (a delivery app or marketplace: `feesExpected`), else `none`.
 */
export function channelFeesOf(input: {
  readonly feesExpected: boolean
  readonly commissionPercent: string | null
  readonly statement: { readonly fees: string; readonly sales: string } | null
  readonly expenses: { readonly fees: string; readonly sales: string } | null
}): ChannelFees {
  if (input.statement !== null) return { state: 'statement', ...input.statement }
  if (input.expenses !== null) return { state: 'expenses', ...input.expenses }
  if (input.commissionPercent !== null) {
    if (toDec(input.commissionPercent).lt(0)) {
      throw new RangeError(`A commission must not be negative: "${input.commissionPercent}"`)
    }
    return { state: 'commission', percent: input.commissionPercent }
  }
  return { state: input.feesExpected ? 'not_entered' : 'none' }
}

/** A line net's channel fees, in the net's sign: null when `none` or `not_entered`. */
function feeOf(net: string, fees: ChannelFees): CostAmount | null {
  const size = plain(toDec(net).abs())
  if (fees.state === 'commission') return inSignOf(net, divideOnce([size, fees.percent], '100'))
  if (fees.state !== 'statement' && fees.state !== 'expenses') return null
  if (toDec(fees.fees).lt(0)) throw new RangeError(`Fees must not be negative: "${fees.fees}"`)
  // Item sales of zero or less carry nothing (as a month's running costs, D-202).
  if (!toDec(fees.sales).gt(0)) return '0' as CostAmount
  return inSignOf(net, divideOnce([size, fees.fees], fees.sales))
}

// ---------------------------------------------------------------------------------------------------
// A line's real profit, a sum of lines, and the business's
// ---------------------------------------------------------------------------------------------------

/**
 * Why a real profit is incomplete (something the member can add or that will come):
 * - `no_recipe`: a product sold without a recipe while Materials was on (its snapshot has none);
 * - `unpriced_materials`: a material had no price yet (filled once by the purchase that prices it);
 * - `fees_not_entered`: a delivery app or marketplace without a statement, fee expenses or a %;
 * - `hourly_rate_not_set`: minutes without the owner's hourly rate (filled once it is set);
 * - `delivery_cost_not_entered`: a delivery whose cost is not typed yet.
 * A share before running costs or awaiting sales is not one: it says `beforeRunningCosts` (D-203).
 */
export const REAL_PROFIT_REASONS = [
  'no_recipe',
  'unpriced_materials',
  'fees_not_entered',
  'hourly_rate_not_set',
  'delivery_cost_not_entered',
] as const
export type RealProfitReason = (typeof REAL_PROFIT_REASONS)[number]

/** A line's materials: `none` (nothing frozen), `priced`, or `no_price_yet` (its priced ones only). */
export type ProfitMaterialsState = 'none' | 'priced' | 'no_price_yet'

export interface SaleLineProfitInput {
  readonly kind: SaleLineKind
  /** The line's net before VAT (computeSale), negative on a refund. */
  readonly net: string
  /** Its snapshot (saleLineCost, filled since). */
  readonly cost: SaleLineCost
  /** A product sold while Materials was on: without a recipe its profit is incomplete. */
  readonly materialsRequired: boolean
  /** Its channel's fees (item lines). */
  readonly fees: ChannelFees
  /** The rate of its month (item lines). */
  readonly rate: SaleRate
}

export interface SaleLineProfit {
  readonly kind: SaleLineKind
  /** Its sales before VAT (the line's net). */
  readonly sales: string
  readonly materials: {
    readonly state: ProfitMaterialsState
    /** Σ of the priced materials; null with none priced. */
    readonly amount: CostAmount | null
  }
  /** Item lines only (null: delivery and charges carry no fees). */
  readonly fees: { readonly state: FeeState; readonly amount: CostAmount | null } | null
  /** Item lines only (null: delivery and charges carry no share). */
  readonly runningCosts: {
    readonly state: SaleShareState
    readonly basis: RateBasis | null
    readonly amount: CostAmount | null
  } | null
  readonly ownerTime: { readonly state: OwnerTimeState; readonly amount: CostAmount | null }
  /** sales − every part known (exact). */
  readonly profit: CostAmount
  /** The share applies and is not in it yet (awaiting sales, or a first month's first days). */
  readonly beforeRunningCosts: boolean
  readonly reasons: readonly RealProfitReason[]
  readonly complete: boolean
}

/** A sold line's real profit, part by part (see above). Pure; throws RangeError on malformed input. */
export function saleLineProfit(input: SaleLineProfitInput): SaleLineProfit {
  const { cost } = input
  const isItem = input.kind === 'item'
  const reasons = new Set<RealProfitReason>()

  const unpriced = cost.materials.filter((m) => m.cost === null).length
  const priced = cost.materials.filter((m) => m.cost !== null)
  const materials = {
    state: (cost.materials.length === 0
      ? 'none'
      : unpriced > 0
        ? 'no_price_yet'
        : 'priced') as ProfitMaterialsState,
    amount: priced.length === 0 ? null : add(priced.map((m) => m.cost)),
  }
  if (isItem && input.materialsRequired && cost.basis === 'none') reasons.add('no_recipe')
  if (unpriced > 0) reasons.add('unpriced_materials')

  const fees = isItem ? { state: input.fees.state, amount: feeOf(input.net, input.fees) } : null
  if (fees?.state === 'not_entered') reasons.add('fees_not_entered')

  const runningCosts = isItem
    ? {
        state: input.rate.state,
        basis: input.rate.source?.basis ?? null,
        amount: shareOf(input.net, input.rate),
      }
    : null

  const time = cost.time
  const ownerTime = {
    state: time.state,
    amount: time.state === 'applied' ? time.cost : null,
  }
  if (time.state === 'rate_not_set') reasons.add('hourly_rate_not_set')

  const known = add([
    materials.amount,
    fees?.amount ?? null,
    runningCosts?.amount ?? null,
    ownerTime.amount,
  ])
  const ordered = REAL_PROFIT_REASONS.filter((reason) => reasons.has(reason))
  return {
    kind: input.kind,
    sales: plain(toDec(input.net)),
    materials,
    fees,
    runningCosts,
    ownerTime,
    profit: plain(toDec(input.net).minus(toDec(known))) as CostAmount,
    beforeRunningCosts:
      runningCosts !== null &&
      (runningCosts.state === 'awaiting_sales' || runningCosts.state === 'before_running_costs'),
    reasons: ordered,
    complete: ordered.length === 0,
  }
}

/** What a sale's delivery cost the business (sales.delivery_cost): `none` without delivery. */
export type SaleDeliveryCost =
  | { readonly state: 'none' }
  | { readonly state: 'not_entered' }
  | { readonly state: 'entered'; readonly cost: string }

/** Real profit of some sold lines (a sale, an order, a day, a product, a channel, a branch…). */
export interface RealProfitSum {
  /** Σ of the lines' sales before VAT. */
  readonly sales: CostAmount
  /** Σ of the item lines' (what the share and the fees are divided by). */
  readonly itemSales: CostAmount
  readonly materials: CostAmount
  readonly fees: CostAmount
  /** Delivery charged (Σ delivery lines), what it cost (Σ entered), and the margin. */
  readonly deliveryCharged: CostAmount
  readonly deliveryCost: CostAmount
  readonly deliveryMargin: CostAmount
  /** Σ of the shares carried (businessRealProfit subtracts the month's costs in their place). */
  readonly runningCosts: CostAmount
  readonly ownerTime: CostAmount
  /** sales − every part (exact). */
  readonly profit: CostAmount
  /** profit ÷ sales × 100, divided once (12 decimals); null when sales are zero or less. */
  readonly marginPercent: string | null
  /**
   * A line's share applies and is not in the profit yet (D-203). Never on the business's real profit
   * while it subtracts the month's costs (businessRealProfit): they are in it.
   */
  readonly beforeRunningCosts: boolean
  readonly reasons: readonly RealProfitReason[]
  readonly complete: boolean
}

/** profit × 100 ÷ sales, divided once; null when the sales are zero or less. */
function marginOf(profit: string, sales: string): string | null {
  return toDec(sales).gt(0) ? divideOnce([profit, '100'], sales) : null
}

/**
 * The sum of sold lines' real profits (each part's exact sum), less what their deliveries cost.
 * The home baker's order #1001: 150 − 32.40 − 37.50 − 40 = 40.10 on the cake, and delivery charged 20
 * that cost 25 (margin −5): 35.10.
 */
export function sumRealProfit(
  lines: readonly SaleLineProfit[],
  deliveries: readonly SaleDeliveryCost[] = [],
): RealProfitSum {
  const reasons = new Set<RealProfitReason>(lines.flatMap((line) => line.reasons))
  for (const delivery of deliveries) {
    if (delivery.state === 'not_entered') reasons.add('delivery_cost_not_entered')
    if (delivery.state === 'entered' && toDec(delivery.cost).lt(0)) {
      throw new RangeError(`A delivery cost must not be negative: "${delivery.cost}"`)
    }
  }
  const deliveryCost = add(deliveries.map((d) => (d.state === 'entered' ? d.cost : null)))
  const deliveryCharged = add(lines.filter((l) => l.kind === 'delivery').map((l) => l.sales))
  const sales = add(lines.map((l) => l.sales))
  const profit = plain(
    toDec(add(lines.map((l) => l.profit))).minus(toDec(deliveryCost)),
  ) as CostAmount
  const ordered = REAL_PROFIT_REASONS.filter((reason) => reasons.has(reason))
  return {
    sales,
    itemSales: add(lines.filter((l) => l.kind === 'item').map((l) => l.sales)),
    materials: add(lines.map((l) => l.materials.amount)),
    fees: add(lines.map((l) => l.fees?.amount ?? null)),
    deliveryCharged,
    deliveryCost,
    deliveryMargin: plain(toDec(deliveryCharged).minus(toDec(deliveryCost))) as CostAmount,
    runningCosts: add(lines.map((l) => l.runningCosts?.amount ?? null)),
    ownerTime: add(lines.map((l) => l.ownerTime.amount)),
    profit,
    marginPercent: marginOf(profit, sales),
    beforeRunningCosts: lines.some((l) => l.beforeRunningCosts),
    reasons: ordered,
    complete: ordered.length === 0,
  }
}

/** The business's real profit of a month (or part of it): its lines, less the month's costs. */
export interface BusinessRealProfit extends RealProfitSum {
  /** The month's costs subtracted (whole, or so far: costsSpanOf); null when both modules are off. */
  readonly monthCosts: CostAmount | null
  /** monthCosts − the shares carried: "Running costs not carried by this month's sales". */
  readonly notCarried: CostAmount | null
}

/**
 * The business's real profit (see above): every sale of the month summed (sumRealProfit), less the
 * month's costs themselves in place of the shares its lines carry, with what the shares did not carry
 * said apart. The café's September: 80,000 − 24,000 − 1,800 − 20,000 = 34,200 (42.75 %). With the
 * costs subtracted it is never "before running costs", even while its lines are (a first month's first
 * days): `notCarried` says what their shares do not carry yet.
 */
export function businessRealProfit(
  sum: RealProfitSum,
  costs: { readonly state: 'off' } | { readonly state: 'on'; readonly costs: string },
): BusinessRealProfit {
  if (costs.state === 'off') return { ...sum, monthCosts: null, notCarried: null }
  const monthCosts = plain(toDec(costs.costs)) as CostAmount
  const profit = plain(
    toDec(sum.profit).plus(toDec(sum.runningCosts)).minus(toDec(monthCosts)),
  ) as CostAmount
  return {
    ...sum,
    profit,
    marginPercent: marginOf(profit, sum.sales),
    beforeRunningCosts: false,
    monthCosts,
    notCarried: plain(toDec(monthCosts).minus(toDec(sum.runningCosts))) as CostAmount,
  }
}
