import type { Tx } from '@bizcost/db'
import {
  addMonths,
  businessRealProfit,
  can,
  channelFeeExpensesOf,
  channelFeesOf,
  compareDecimal,
  costPool,
  costsSpanOf,
  daysIn,
  firstDayOf,
  FIRST_MONTH_DAYS,
  feesNotCarried,
  monthCostsSoFar,
  monthOf,
  rateCostsOf,
  rateSourceOf,
  saleRate,
  soldLinesProfit,
  subtractDecimals,
  sumDecimals,
  sumRealProfit,
  type BusinessMonth,
  type BusinessRealProfit,
  type ChannelFeeExpenses,
  type ChannelFees,
  type FeeExpense,
  type PoolExpense,
  type PoolMaterialPurchase,
  type PoolRunningCost,
  type RateSource,
  type RealProfitReason,
  type RealProfitSum,
  type RunningCostFrequency,
  type SaleDeliveryCost,
  type SaleLineKind,
  type SaleLineProfit,
  type SaleRate,
  type SalesChannelKind,
} from '@bizcost/domain'
import { sql, type SQL } from 'drizzle-orm'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { passes } from '../trpc'
import { uuidArray } from './stock'

// Real profit on read (ROADMAP.md M3 Step 3; D-223; the owner's answers Q6–Q8, Q11, Q13 of D-218):
// what the reports, the Dashboard's cards and Product costs read. Nothing is stored (as D-186).
//
//   real profit = sales before VAT − materials − channel fees − delivery cost − running-cost share
//                 − the owner's time (without a team)
//
// The sales that count (Q3): finalized sales, each on its business day; one reversed on a later day
// (its own day was closed, D-227) counts on its day and is taken back on its reversal's day, in that
// day's month (its sales and the month's item sales too); one reversed on its own day is as if it was
// never finalized. Posted sales count whether or not Sales is switched on now (M9: they are what was
// sold), but only while Sales is served (released, or previewed on a local server): a released
// business sees no change before Release A.
//
// Everything is read as sums in SQL (one row per group × month × channel × line kind), so a year of
// sales costs one division per month and channel, not one per line (soldLinesProfit). The rate is one
// for the whole business (Q6, B18), and a channel's fees are its own over all branches (Q8): both are
// read business-wide, whatever branches the member is limited to; only the lines shown follow the
// member's branches.
//   - Rates (rateSourceOf): a finished month its own costs ÷ its own item sales; the running month the
//     last month that sold; a first month its costs from the first sale ÷ its sales so far, after 7
//     days of sales. The costs: costPool (running costs for the days they ran, finalized expenses
//     counted once, D-216; never an expense marked as a channel's fees or delivery, Q8; the materials no
//     product uses, Q13 A), whole or so far (monthCostsSoFar).
//   - Fees (channelFeesOf): the expenses marked as the channel's fees for the month (statements come
//     with Step 4), else the channel's commission %, else "before app fees" for a delivery app or a
//     marketplace. Marked fees with no sales of their channel that month to sit on, and what reversals
//     of earlier months' take back, come off at the business level (feesNotCarried, D-250).
//   - The business level (businessRealProfit) subtracts the month's costs over the days counted (whole
//     in a finished month, so far in the running one, from the first sale in a first month) in place
//     of the shares its sales carry, and says what they did not carry; and the app fees no line
//     carries. Not for a member limited to
//     some branches (D-231): they see their branches' sales and the shares those carry.

// ---------------------------------------------------------------------------------------------------
// Who sees what
// ---------------------------------------------------------------------------------------------------

/** Sales is served on this server (released, or previewed: D-125), whether or not it is on. */
export function salesServed(ctx: Pick<BusinessCtx, 'modules'>): boolean {
  return ctx.modules.some((m) => m.id === 'sales' && m.availability === 'released')
}

/**
 * The member sees real profit and what it is made of (Q11): Reports on and `reports.profit.view`,
 * which grants nothing without the costs switch, Product costs and every sale seen (D-190).
 */
export function profitShown(ctx: BusinessCtx): boolean {
  return passes(ctx, ['reports', 'reports.profit.view'])
}

/** The member sees the sales totals (every sale, H1). */
export function seesSalesTotals(ctx: BusinessCtx): boolean {
  return can(ctx.access.effective, 'sales.documents.view')
}

/** The member is limited to some branches (Q12): their branches only, no business-level line. */
export function branchLimited(ctx: BusinessCtx): boolean {
  return !ctx.access.locationScope.all
}

// ---------------------------------------------------------------------------------------------------
// The business, its first sale and its item sales by month
// ---------------------------------------------------------------------------------------------------

/** A sales channel as real profit reads it. */
export interface ProfitChannel {
  readonly id: string
  readonly name: string
  readonly kind: SalesChannelKind
  /** What the app keeps of each sale before VAT (Q8); null: not entered. */
  readonly feePercent: string | null
}

/** What real profit is worked out with, read once per request (rates and costs read when asked). */
export interface ProfitEnv {
  readonly businessId: string
  readonly today: string
  readonly currency: string
  readonly hasTeam: boolean
  /** Materials is on: a product sold without a recipe is incomplete (D-236). */
  readonly materialsOn: boolean
  readonly runningOn: boolean
  readonly expensesOn: boolean
  /**
   * Purchases is on and Sales is served: the materials no product uses count with the costs (Q13 A).
   * Without Sales served (a released business before Release A) they never do, as in M2 (D-250).
   */
  readonly purchasesOn: boolean
  /** The day of the first finalized sale that counts (null: none yet). */
  readonly firstSaleDay: string | null
  /** The business's item sales before VAT by month (every branch; reversals on their month). */
  readonly monthItemSales: ReadonlyMap<BusinessMonth, string>
  readonly channels: ReadonlyMap<string, ProfitChannel>
  /** Caches of the request. */
  readonly cache: {
    rates: Map<BusinessMonth, MonthRate>
    fees: Map<string, ChannelFees>
    costInputs: CostInputs | null
    channelSales: Map<BusinessMonth, Map<string, string>>
    feeExpenses: Map<BusinessMonth, ChannelFeeExpenses>
  }
}

/**
 * The finalized sales that count (alias `p`): each on its day (sign 1) and, reversed on a later day,
 * again on its reversal's day (sign −1). `days` limits the days counted; `scope` the branches.
 */
export function piecesOf(
  businessId: string,
  options: { from?: string; to?: string; scope?: readonly string[] | null } = {},
): SQL {
  const own: SQL[] = []
  const back: SQL[] = []
  if (options.from !== undefined) {
    own.push(sql`s.business_date >= ${options.from}::date`)
    back.push(sql`s.reversal_business_date >= ${options.from}::date`)
  }
  if (options.to !== undefined) {
    own.push(sql`s.business_date <= ${options.to}::date`)
    back.push(sql`s.reversal_business_date <= ${options.to}::date`)
  }
  if (options.scope) {
    const scope = sql`s.location_id = any(${uuidArray([...options.scope])})`
    own.push(scope)
    back.push(scope)
  }
  const extra = (parts: SQL[]) =>
    parts.length === 0 ? sql`` : sql` and ${sql.join(parts, sql` and `)}`
  return sql`(
    select s.id as sale_id, s.business_date as day, 1 as sign, s.channel_id, s.location_id,
           s.delivery_needed, s.delivery_cost
      from app.sales s
     where s.business_id = ${businessId} and s.deleted_at is null
       and (s.status = 'posted'
         or (s.status = 'reversed' and s.reversal_business_date > s.business_date))${extra(own)}
    union all
    select s.id, s.reversal_business_date, -1, s.channel_id, s.location_id, s.delivery_needed,
           s.delivery_cost
      from app.sales s
     where s.business_id = ${businessId} and s.deleted_at is null and s.status = 'reversed'
       and s.reversal_business_date > s.business_date${extra(back)}
  )`
}

/**
 * Today, the currency and the first sale of the business (FORBIDDEN for a business that is gone). The
 * first sale's day is the first day a finalized sale covers: a Today's sales sheet for several days
 * (Q9) counts on its last day but covers from its first (`period_from`, within the same month), so a
 * first month counts its costs from the day those sales began (D-250).
 */
async function businessFactsOf(
  tx: Tx,
  businessId: string,
): Promise<{ today: string; currency: string; firstSaleDay: string | null }> {
  const [row] = (await tx.execute(sql`
    select (now() at time zone b.timezone)::date::text as today, trim(b.currency) as currency,
           (select min(coalesce(s.period_from, s.business_date))::text from app.sales s
             where s.business_id = b.id and s.deleted_at is null
               and (s.status = 'posted'
                 or (s.status = 'reversed' and s.reversal_business_date > s.business_date))
           ) as first_sale_day
      from app.businesses b
     where b.id = ${businessId} and b.deleted_at is null
  `)) as unknown as { today: string; currency: string; first_sale_day: string | null }[]
  if (!row) throw new AppError('forbidden')
  return { today: row.today, currency: row.currency, firstSaleDay: row.first_sale_day }
}

/**
 * What real profit is worked out with (see above). Without Sales served nothing counts: no first
 * sale and no item sales (Product costs then keep their shares awaiting sales).
 */
export async function profitEnvOf(tx: Tx, ctx: BusinessCtx): Promise<ProfitEnv> {
  const businessId = ctx.businessId
  const facts = await businessFactsOf(tx, businessId)
  const served = salesServed(ctx)
  const monthItemSales = new Map<BusinessMonth, string>()
  if (served && facts.firstSaleDay !== null) {
    const rows = (await tx.execute(sql`
      select to_char(p.day, 'YYYY-MM') as month, trim_scale(sum(p.sign * l.net))::text as sales
        from ${piecesOf(businessId)} p
        join app.sale_lines l
          on l.business_id = ${businessId} and l.sale_id = p.sale_id and l.deleted_at is null
         and l.kind = 'item'
       group by 1
    `)) as unknown as { month: string; sales: string }[]
    for (const row of rows) monthItemSales.set(row.month, row.sales)
  }
  const channels = new Map<string, ProfitChannel>()
  if (served) {
    const rows = (await tx.execute(sql`
      select c.id, c.name, c.kind, trim_scale(c.fee_percent)::text as fee_percent
        from app.sales_channels c
       where c.business_id = ${businessId} and c.deleted_at is null
    `)) as unknown as {
      id: string
      name: string
      kind: SalesChannelKind
      fee_percent: string | null
    }[]
    for (const row of rows) {
      channels.set(row.id, {
        id: row.id,
        name: row.name,
        kind: row.kind,
        feePercent: row.fee_percent,
      })
    }
  }
  return {
    businessId,
    today: facts.today,
    currency: facts.currency,
    hasTeam: ctx.access.capabilities.has_team,
    materialsOn: passes(ctx, ['materials']),
    runningOn: passes(ctx, ['running_costs']),
    expensesOn: passes(ctx, ['expenses']),
    // Q13 A is a Step 3 change: a released business's month's costs stay as they were (D-250).
    purchasesOn: served && passes(ctx, ['purchases']),
    firstSaleDay: served ? facts.firstSaleDay : null,
    monthItemSales,
    channels,
    cache: {
      rates: new Map(),
      fees: new Map(),
      costInputs: null,
      channelSales: new Map(),
      feeExpenses: new Map(),
    },
  }
}

/** Both cost modules off: nothing is shared (`off`, D-202). */
export function costsOn(env: ProfitEnv): boolean {
  return env.runningOn || env.expensesOn
}

/** The latest month before `month` whose item sales came to more than zero (Q6: `last_month`). */
export function lastSoldMonthOf(env: ProfitEnv, month: BusinessMonth): BusinessMonth | null {
  let found: BusinessMonth | null = null
  for (const [m, sales] of env.monthItemSales) {
    if (m < month && compareDecimal(sales, '0') > 0 && (found === null || m > found)) found = m
  }
  return found
}

// ---------------------------------------------------------------------------------------------------
// The month's costs
// ---------------------------------------------------------------------------------------------------

/** The running costs, finalized expenses and purchases of unused materials the costs are made of. */
export interface CostInputs {
  /** The months they were read for (each costPool reads 11 more on either side for expenses). */
  readonly from: BusinessMonth
  readonly to: BusinessMonth
  readonly running: readonly (PoolRunningCost & { categoryName: string })[]
  readonly expenses: readonly (PoolExpense & { categoryName: string })[]
  readonly materials: readonly (PoolMaterialPurchase & { materialName: string })[]
}

interface RunningRow extends Record<string, unknown> {
  id: string
  name: string
  category_id: string
  category_name: string
  amount: string
  frequency: RunningCostFrequency
  starts_on: string
  ends_on: string | null
}

interface ExpenseRow extends Record<string, unknown> {
  category_id: string
  category_name: string
  running_cost_id: string | null
  pays: PoolExpense['pays']
  cost: string
  month: string
  reversed_in: string | null
}

interface MaterialRow extends Record<string, unknown> {
  material_id: string
  material_name: string
  cost: string
  month: string
  reversed_in: string | null
}

/** Whether every running cost was ever entered (removed ones aside: D-202's "Enter your running costs"). */
export async function runningCostsEntered(tx: Tx, businessId: string): Promise<boolean> {
  const [row] = (await tx.execute(sql`
    select exists (select 1 from app.running_costs r
      where r.business_id = ${businessId} and r.deleted_at is null) as entered
  `)) as unknown as { entered: boolean }[]
  return row?.entered === true
}

/**
 * The materials some product or service uses (alias-free subquery of `material_id`): a recipe line of
 * a product not removed (archived ones too: their sales froze them), what one is bought ready to sell
 * as (D-117), or what a finalized sale that counts froze (D-250): once a sale carries a material as its
 * own cost, that material's purchases are goods for sale, never also the month's costs, even after it
 * leaves every recipe (what is left of them is stock, counted with stock counts in Phase 4). Any other
 * material bought counts with the month's costs (Q13 A).
 */
export function usedMaterials(businessId: string): SQL {
  return sql`(
    select l.material_id
      from app.recipe_lines l
      join app.recipes r
        on r.business_id = l.business_id and r.id = l.recipe_id and r.deleted_at is null
      join app.products_services p
        on p.business_id = r.business_id and p.id = r.product_id and p.deleted_at is null
     where l.business_id = ${businessId} and l.deleted_at is null
    union
    select p.resale_material_id
      from app.products_services p
     where p.business_id = ${businessId} and p.deleted_at is null
       and p.resale_material_id is not null
    union
    select x.material_id
      from app.sale_line_materials x
      join app.sales s
        on s.business_id = x.business_id and s.id = x.sale_id and s.deleted_at is null
     where x.business_id = ${businessId} and x.deleted_at is null
       and (s.status = 'posted'
         or (s.status = 'reversed' and s.reversal_business_date > s.business_date))
  )`
}

/**
 * The costs of the months `from` … `to` are made of (see CostInputs): every running cost (Running
 * Costs on), the finalized expenses of the months a period holding them can span and the reversals
 * counted in them (Expenses on), and the purchases, returns and credit notes of materials no product
 * or service uses (no recipe line of a product not removed, not what one is bought ready to sell as:
 * Q13 A) dated in those months or reversed in them (Purchases on). Read once per request, widened when
 * a later question needs more months.
 */
export async function costInputsOf(
  tx: Tx,
  env: ProfitEnv,
  from: BusinessMonth,
  to: BusinessMonth,
): Promise<CostInputs> {
  const cached = env.cache.costInputs
  if (cached && cached.from <= from && cached.to >= to) return cached
  const lo = cached && cached.from < from ? cached.from : from
  const hi = cached && cached.to > to ? cached.to : to
  const businessId = env.businessId
  const running = env.runningOn
    ? ((await tx.execute(sql`
        select r.id, r.name, r.category_id, c.name as category_name,
               trim_scale(r.amount)::text as amount, r.frequency, r.starts_on::text as starts_on,
               r.ends_on::text as ends_on
          from app.running_costs r
          join app.cost_categories c on c.business_id = r.business_id and c.id = r.category_id
         where r.business_id = ${businessId} and r.deleted_at is null
      `)) as unknown as RunningRow[])
    : []
  const expenses = env.expensesOn
    ? ((await tx.execute(sql`
        select e.category_id, c.name as category_name, e.running_cost_id, e.pays,
               trim_scale(e.cost_total)::text as cost,
               to_char(e.period_month, 'YYYY-MM') as month,
               case when e.status = 'reversed'
                    then to_char(coalesce(e.reversal_period_month, e.period_month), 'YYYY-MM')
               end as reversed_in
          from app.expenses e
          join app.cost_categories c on c.business_id = e.business_id and c.id = e.category_id
         where e.business_id = ${businessId} and e.deleted_at is null
           and e.status in ('posted', 'reversed')
           and (e.period_month between ${firstDayOf(addMonths(lo, -11))}::date
                                   and ${firstDayOf(addMonths(hi, 11))}::date
             or (e.status = 'reversed'
               and coalesce(e.reversal_period_month, e.period_month)
                   between ${firstDayOf(lo)}::date and ${firstDayOf(hi)}::date))
      `)) as unknown as ExpenseRow[])
    : []
  const fromDay = firstDayOf(lo)
  const toDay = `${hi}-${String(daysIn(hi)).padStart(2, '0')}`
  const materials = env.purchasesOn
    ? ((await tx.execute(sql`
        with used as ${usedMaterials(businessId)}
        select pl.material_id, m.name as material_name, trim_scale(pl.cost)::text as cost,
               to_char(pu.business_date, 'YYYY-MM') as month,
               case when pu.status = 'reversed' then to_char(pu.reversal_date, 'YYYY-MM') end
                 as reversed_in
          from app.purchase_lines pl
          join app.purchases pu
            on pu.business_id = pl.business_id and pu.id = pl.purchase_id and pu.deleted_at is null
          join app.materials m on m.business_id = pl.business_id and m.id = pl.material_id
         where pl.business_id = ${businessId} and pl.deleted_at is null and pl.kind = 'material'
           and pu.status in ('posted', 'reversed') and pl.cost is not null
           and pl.material_id not in (select u.material_id from used u)
           and (pu.business_date between ${fromDay}::date and ${toDay}::date
             or (pu.status = 'reversed'
               and pu.reversal_date between ${fromDay}::date and ${toDay}::date))
        union all
        select pl.material_id, m.name, trim_scale(-rl.cost)::text,
               to_char(pr.business_date, 'YYYY-MM'),
               case when pr.status = 'reversed' then to_char(pr.reversal_date, 'YYYY-MM') end
          from app.purchase_return_lines rl
          join app.purchase_returns pr
            on pr.business_id = rl.business_id and pr.id = rl.return_id and pr.deleted_at is null
          join app.purchase_lines pl
            on pl.business_id = rl.business_id and pl.id = rl.purchase_line_id
          join app.materials m on m.business_id = pl.business_id and m.id = pl.material_id
         where rl.business_id = ${businessId} and rl.deleted_at is null
           and pr.status in ('posted', 'reversed') and rl.cost is not null
           and pl.material_id not in (select u.material_id from used u)
           and (pr.business_date between ${fromDay}::date and ${toDay}::date
             or (pr.status = 'reversed'
               and pr.reversal_date between ${fromDay}::date and ${toDay}::date))
      `)) as unknown as MaterialRow[])
    : []
  const inputs: CostInputs = {
    from: lo,
    to: hi,
    running: running.map((r) => ({
      id: r.id,
      name: r.name,
      categoryId: r.category_id,
      categoryName: r.category_name,
      amount: r.amount,
      frequency: r.frequency,
      startsOn: r.starts_on,
      endsOn: r.ends_on,
    })),
    expenses: expenses.map((e) => ({
      categoryId: e.category_id,
      categoryName: e.category_name,
      runningCostId: e.running_cost_id,
      pays: e.pays,
      cost: e.cost,
      month: e.month,
      reversedIn: e.reversed_in,
    })),
    materials: materials.map((m) => ({
      materialId: m.material_id,
      materialName: m.material_name,
      cost: m.cost,
      month: m.month,
      reversedIn: m.reversed_in,
    })),
  }
  env.cache.costInputs = inputs
  return inputs
}

/** The months `source` divides the costs of (its month, or those its days run over). */
function sourceMonths(source: RateSource): BusinessMonth[] {
  if (source.from === null || source.to === null) return [source.month]
  const months: BusinessMonth[] = []
  for (let m = monthOf(source.from); m <= monthOf(source.to); m = addMonths(m, 1)) months.push(m)
  return months
}

/** The business's item sales before VAT over the days `from` … `to` (every branch). */
async function itemSalesBetween(
  tx: Tx,
  businessId: string,
  from: string,
  to: string,
): Promise<string> {
  const [row] = (await tx.execute(sql`
    select coalesce(trim_scale(sum(p.sign * l.net))::text, '0') as sales
      from ${piecesOf(businessId, { from, to })} p
      join app.sale_lines l
        on l.business_id = ${businessId} and l.sale_id = p.sale_id and l.deleted_at is null
       and l.kind = 'item'
  `)) as unknown as { sales: string }[]
  return row?.sales ?? '0'
}

/** The rate a month's sales carry (Q6), with what it is divided from. */
export interface MonthRate {
  readonly month: BusinessMonth
  readonly source: RateSource | null
  readonly rate: SaleRate
  /** `before_running_costs`: the day it shows (7 days of sales from the source's first day). */
  readonly showsOn: string | null
}

const DAY_MS = 86_400_000
const plusDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)

/**
 * The rate the sales of each of `months` carry (Q6, one rate for the whole business): rateSourceOf,
 * the costs it divides (rateCostsOf) and the item sales of the same days, divided once (saleRate).
 * Cached for the request. Months after today are not asked.
 */
export async function ratesOf(
  tx: Tx,
  env: ProfitEnv,
  months: readonly BusinessMonth[],
): Promise<ReadonlyMap<BusinessMonth, MonthRate>> {
  const missing = [...new Set(months)].filter((m) => !env.cache.rates.has(m))
  if (missing.length > 0) {
    const sources = new Map(
      missing.map((month) => [
        month,
        rateSourceOf(month, env.today, env.firstSaleDay, lastSoldMonthOf(env, month)),
      ]),
    )
    const shown = [...sources.values()].filter(
      (s): s is RateSource => s !== null && s.shown && costsOn(env),
    )
    const touched = shown.flatMap(sourceMonths)
    const inputs =
      touched.length > 0
        ? await costInputsOf(
            tx,
            env,
            touched.reduce((a, b) => (a < b ? a : b)),
            touched.reduce((a, b) => (a > b ? a : b)),
          )
        : null
    for (const [month, source] of sources) {
      let costs: string | null = null
      let sales: string | null = null
      if (source !== null && source.shown && costsOn(env) && inputs !== null) {
        costs = rateCostsOf(source, inputs.running, inputs.expenses, inputs.materials)
        sales =
          source.from === null || source.to === null
            ? (env.monthItemSales.get(source.month) ?? '0')
            : await itemSalesBetween(tx, env.businessId, source.from, source.to)
      }
      const rate = saleRate({ on: costsOn(env), source, costs, sales })
      env.cache.rates.set(month, {
        month,
        source,
        rate,
        showsOn:
          rate.state === 'before_running_costs' && source?.from
            ? plusDays(source.from, FIRST_MONTH_DAYS - 1)
            : null,
      })
    }
  }
  return new Map(months.map((m) => [m, env.cache.rates.get(m)!]))
}

/**
 * The business's costs over the days `from` … `to` of `month` (both within it): the whole month's
 * pool when they are its every day, else so far (monthCostsSoFar). Null when both modules are off.
 */
export async function monthCostsBetween(
  tx: Tx,
  env: ProfitEnv,
  month: BusinessMonth,
  from: string,
  to: string,
): Promise<string | null> {
  if (!costsOn(env)) return null
  const inputs = await costInputsOf(tx, env, month, month)
  const whole = from === firstDayOf(month) && to === lastDayOf(month)
  return whole
    ? costPool(month, inputs.running, inputs.expenses, inputs.materials).total
    : monthCostsSoFar(month, from, to, inputs.running, inputs.expenses, inputs.materials).total
}

export function lastDayOf(month: BusinessMonth): string {
  return `${month}-${String(daysIn(month)).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------------------------------
// Channel fees (Q8)
// ---------------------------------------------------------------------------------------------------

const FEES_EXPECTED: ReadonlySet<SalesChannelKind> = new Set(['delivery_app', 'marketplace'])

/** Each channel's item sales before VAT in `month` (every branch). */
async function channelSalesOf(
  tx: Tx,
  env: ProfitEnv,
  month: BusinessMonth,
): Promise<Map<string, string>> {
  const cached = env.cache.channelSales.get(month)
  if (cached) return cached
  const rows = (await tx.execute(sql`
    select p.channel_id, trim_scale(sum(p.sign * l.net))::text as sales
      from ${piecesOf(env.businessId, { from: firstDayOf(month), to: lastDayOf(month) })} p
      join app.sale_lines l
        on l.business_id = ${env.businessId} and l.sale_id = p.sale_id and l.deleted_at is null
       and l.kind = 'item'
     group by 1
  `)) as unknown as { channel_id: string; sales: string }[]
  const result = new Map(rows.map((r) => [r.channel_id, r.sales] as const))
  env.cache.channelSales.set(month, result)
  return result
}

/**
 * The expenses marked as each channel's fees for `month`, and what reversals of earlier months' take
 * back in it (Expenses on; channelFeeExpensesOf).
 */
async function feeExpensesOf(
  tx: Tx,
  env: ProfitEnv,
  month: BusinessMonth,
): Promise<ChannelFeeExpenses> {
  const cached = env.cache.feeExpenses.get(month)
  if (cached) return cached
  let result: ChannelFeeExpenses = channelFeeExpensesOf(month, [])
  if (env.expensesOn) {
    const rows = (await tx.execute(sql`
      select e.channel_id, trim_scale(e.cost_total)::text as cost,
             to_char(e.period_month, 'YYYY-MM') as month,
             case when e.status = 'reversed'
                  then to_char(coalesce(e.reversal_period_month, e.period_month), 'YYYY-MM')
             end as reversed_in
        from app.expenses e
       where e.business_id = ${env.businessId} and e.deleted_at is null
         and e.status in ('posted', 'reversed') and e.pays = 'channel_fees'
         and (e.period_month = ${firstDayOf(month)}::date
           or (e.status = 'reversed'
             and coalesce(e.reversal_period_month, e.period_month) = ${firstDayOf(month)}::date))
    `)) as unknown as {
      channel_id: string
      cost: string
      month: string
      reversed_in: string | null
    }[]
    const fees: FeeExpense[] = rows.map((r) => ({
      channelId: r.channel_id,
      cost: r.cost,
      month: r.month,
      reversedIn: r.reversed_in,
    }))
    result = channelFeeExpensesOf(month, fees)
  }
  env.cache.feeExpenses.set(month, result)
  return result
}

/**
 * A channel's fees for its sales of `month` (Q8): the expenses marked as its fees for the month over
 * its item sales of the month; else its commission %; else "before app fees" for a delivery app or a
 * marketplace, nothing for the others.
 */
export async function channelFeesFor(
  tx: Tx,
  env: ProfitEnv,
  channelId: string,
  month: BusinessMonth,
): Promise<ChannelFees> {
  const key = `${channelId}|${month}`
  const cached = env.cache.fees.get(key)
  if (cached) return cached
  const channel = env.channels.get(channelId)
  const marked = (await feeExpensesOf(tx, env, month)).marked.get(channelId)
  const fees = channelFeesOf({
    feesExpected: channel ? FEES_EXPECTED.has(channel.kind) : false,
    commissionPercent: channel?.feePercent ?? null,
    statement: null,
    expenses:
      marked === undefined
        ? null
        : { fees: marked, sales: (await channelSalesOf(tx, env, month)).get(channelId) ?? '0' },
  })
  env.cache.fees.set(key, fees)
  return fees
}

// ---------------------------------------------------------------------------------------------------
// Sold lines as sums, and a report of them
// ---------------------------------------------------------------------------------------------------

/** How a report groups its lines. */
export type ProfitGrouping = 'month' | 'week' | 'day' | 'product' | 'channel' | 'branch' | 'all'

function groupKeyOf(grouping: ProfitGrouping): { line: SQL; sale: SQL } {
  switch (grouping) {
    case 'month':
      return { line: sql`to_char(p.day, 'YYYY-MM')`, sale: sql`to_char(p.day, 'YYYY-MM')` }
    case 'week':
      return {
        line: sql`to_char(date_trunc('week', p.day), 'YYYY-MM-DD')`,
        sale: sql`to_char(date_trunc('week', p.day), 'YYYY-MM-DD')`,
      }
    case 'day':
      return { line: sql`p.day::text`, sale: sql`p.day::text` }
    case 'product':
      // What is not a product: delivery charged ('delivery') and other charges ('charge').
      return { line: sql`coalesce(l.product_id::text, l.kind)`, sale: sql`'delivery'` }
    case 'channel':
      return { line: sql`p.channel_id::text`, sale: sql`p.channel_id::text` }
    case 'branch':
      return { line: sql`p.location_id::text`, sale: sql`p.location_id::text` }
    case 'all':
      return { line: sql`'all'`, sale: sql`'all'` }
  }
}

interface BucketRow extends Record<string, unknown> {
  key: string
  month: string
  channel_id: string
  kind: SaleLineKind
  net: string
  qty: string | null
  materials: string | null
  material_rows: number
  unpriced_rows: number
  without_recipe: number
  owner_time: string | null
  rate_not_set: number
  /** Σ of the lines' sizes (abs net) and, below, of those each reason concerns (completeness). */
  size: string
  net_unpriced: string | null
  net_no_recipe: string | null
  net_rate_not_set: string | null
  net_no_delivery_cost: string | null
  net_line_complete: string | null
}

interface DeliveryRow extends Record<string, unknown> {
  key: string
  entered: string | null
  reversed: string | null
  not_entered: number
}

/** A group's lines and deliveries, as sums. */
export interface ProfitGroupSums {
  readonly key: string
  /** Per month × channel × kind, worked out (soldLinesProfit). */
  readonly pieces: readonly (SaleLineProfit & { month: BusinessMonth })[]
  readonly deliveries: readonly SaleDeliveryCost[]
  /** Item quantity sold (by product). */
  readonly quantity: string
  readonly sum: RealProfitSum
  /**
   * Completeness (H2): the sales its lines concern (each line's size, a sale taken back on a later
   * day by its own lines: never offsetting another's), those whose lines are complete, and the sales
   * each reason concerns.
   */
  readonly considered: string
  readonly completeSales: string
  readonly missing: ReadonlyMap<RealProfitReason, string>
}

const zero = '0'
const orZero = (value: string | null | undefined) => value ?? zero

/**
 * The finalized sales of the days `from` … `to` (within the member's branches: `scope`), grouped and
 * worked out part by part: each group's lines as sums per month × channel × kind with the rate of
 * their month and the fees of their channel that month, and its deliveries. Rates and fees are the
 * business's (every branch).
 */
export async function profitGroups(
  tx: Tx,
  env: ProfitEnv,
  options: {
    from: string
    to: string
    grouping: ProfitGrouping
    scope: readonly string[] | null
  },
): Promise<ProfitGroupSums[]> {
  if (env.firstSaleDay === null) return []
  const businessId = env.businessId
  const pieces = piecesOf(businessId, {
    from: options.from,
    to: options.to,
    scope: options.scope,
  })
  const key = groupKeyOf(options.grouping)
  // Completeness (H2, D-250): each line by its own facts and its sale's delivery cost (a delivery
  // needed whose cost is not typed leaves the whole sale incomplete, as the total says, whether or
  // not a delivery was charged). Counted on each line's size (abs), whatever the piece's sign: a sale
  // taken back on a later day concerns its own lines, never offsets another's, so the share stays
  // within 0–100 % and nothing missing is negative.
  const noDeliveryCost = sql`(p.sign = 1 and p.delivery_needed and p.delivery_cost is null)`
  const lineComplete = sql`coalesce(m.unpriced, 0) = 0
    and not (${env.materialsOn} and l.kind = 'item' and l.cost_basis = 'none'
             and pr.type = 'product' and pr.resale_material_id is null)
    and not (l.time_minutes is not null and l.time_cost is null)
    and not ${noDeliveryCost}`
  const buckets = (await tx.execute(sql`
    with p as ${pieces},
    m as (
      select x.sale_line_id, count(*)::int as rows,
             count(*) filter (where x.cost is null)::int as unpriced, sum(x.cost) as priced
        from app.sale_line_materials x
       where x.business_id = ${businessId} and x.deleted_at is null
         and x.sale_id in (select p.sale_id from p)
       group by x.sale_line_id
    )
    select ${key.line} as key, to_char(p.day, 'YYYY-MM') as month, p.channel_id::text as channel_id,
           l.kind,
           trim_scale(sum(p.sign * l.net))::text as net,
           trim_scale(sum(p.sign * l.qty) filter (where l.kind = 'item'))::text as qty,
           trim_scale(sum(p.sign * m.priced))::text as materials,
           coalesce(sum(m.rows), 0)::int as material_rows,
           coalesce(sum(m.unpriced), 0)::int as unpriced_rows,
           (count(*) filter (where ${env.materialsOn} and l.kind = 'item'
              and l.cost_basis = 'none' and pr.type = 'product'
              and pr.resale_material_id is null))::int as without_recipe,
           trim_scale(sum(p.sign * l.time_cost))::text as owner_time,
           (count(*) filter (where l.time_minutes is not null and l.time_cost is null))::int
             as rate_not_set,
           trim_scale(sum(abs(l.net)))::text as size,
           trim_scale(sum(abs(l.net)) filter (where m.unpriced > 0))::text as net_unpriced,
           trim_scale(sum(abs(l.net)) filter (where ${env.materialsOn} and l.kind = 'item'
              and l.cost_basis = 'none' and pr.type = 'product'
              and pr.resale_material_id is null))::text as net_no_recipe,
           trim_scale(sum(abs(l.net))
             filter (where l.time_minutes is not null and l.time_cost is null))::text
             as net_rate_not_set,
           trim_scale(sum(abs(l.net)) filter (where ${noDeliveryCost}))::text
             as net_no_delivery_cost,
           trim_scale(sum(abs(l.net)) filter (where ${lineComplete}))::text as net_line_complete
      from p
      join app.sale_lines l
        on l.business_id = ${businessId} and l.sale_id = p.sale_id and l.deleted_at is null
      left join m on m.sale_line_id = l.id
      left join app.products_services pr
        on pr.business_id = l.business_id and pr.id = l.product_id
     group by 1, 2, 3, 4
  `)) as unknown as BucketRow[]
  const deliveries = (await tx.execute(sql`
    with p as ${pieces}
    select ${key.sale} as key,
           trim_scale(sum(p.delivery_cost) filter (where p.sign = 1))::text as entered,
           trim_scale(sum(p.delivery_cost) filter (where p.sign = -1))::text as reversed,
           (count(*) filter (where p.sign = 1 and p.delivery_cost is null))::int as not_entered
      from p
     where p.delivery_needed
     group by 1
  `)) as unknown as DeliveryRow[]

  const months = [...new Set(buckets.map((b) => b.month))]
  const rates = await ratesOf(tx, env, months)
  const byKey = new Map<string, BucketRow[]>()
  for (const bucket of buckets) {
    const list = byKey.get(bucket.key)
    if (list) list.push(bucket)
    else byKey.set(bucket.key, [bucket])
  }
  const deliveryByKey = new Map(deliveries.map((d) => [d.key, d] as const))
  const keys = new Set([...byKey.keys(), ...deliveryByKey.keys()])
  const groups: ProfitGroupSums[] = []
  for (const groupKey of keys) {
    const rows = byKey.get(groupKey) ?? []
    const worked: (SaleLineProfit & { month: BusinessMonth })[] = []
    let considered = '0'
    let completeSales = '0'
    const missing = new Map<RealProfitReason, string>()
    const addMissing = (reason: RealProfitReason, amount: string | null) => {
      if (amount === null) return
      missing.set(reason, sumDecimals([missing.get(reason) ?? zero, amount]))
    }
    for (const row of rows) {
      const fees =
        row.kind === 'item'
          ? await channelFeesFor(tx, env, row.channel_id, row.month)
          : ({ state: 'none' } as const)
      const rate = rates.get(row.month)!.rate
      const piece = soldLinesProfit({
        kind: row.kind,
        net: row.net,
        materials: row.materials,
        materialRows: row.material_rows,
        unpricedRows: row.unpriced_rows,
        withoutRecipe: row.without_recipe,
        ownerTime: row.owner_time,
        rateNotSet: row.rate_not_set,
        fees,
        rate,
      })
      worked.push({ ...piece, month: row.month })
      // Completeness (H2): each line by its own facts, and an item line before app fees, on the
      // lines' sizes (see lineComplete).
      considered = sumDecimals([considered, row.size])
      const feesMissing = row.kind === 'item' && fees.state === 'not_entered'
      if (feesMissing) addMissing('fees_not_entered', row.size)
      else completeSales = sumDecimals([completeSales, orZero(row.net_line_complete)])
      addMissing('no_recipe', row.net_no_recipe)
      addMissing('unpriced_materials', row.net_unpriced)
      addMissing('hourly_rate_not_set', row.net_rate_not_set)
      addMissing('delivery_cost_not_entered', row.net_no_delivery_cost)
    }
    const delivery = deliveryByKey.get(groupKey)
    const costs: SaleDeliveryCost[] = []
    if (delivery) {
      if (delivery.entered !== null) costs.push({ state: 'entered', cost: delivery.entered })
      if (delivery.reversed !== null) costs.push({ state: 'reversed', cost: delivery.reversed })
      if (delivery.not_entered > 0) costs.push({ state: 'not_entered' })
    }
    groups.push({
      key: groupKey,
      pieces: worked,
      deliveries: costs,
      quantity: sumDecimals(rows.map((r) => orZero(r.qty))),
      sum: sumRealProfit(worked, costs),
      considered,
      completeSales,
      missing,
    })
  }
  return groups
}

/**
 * The app fees of `month`'s days `from` … `to` that no sold line carries (feesNotCarried, D-250): the
 * expenses marked as a channel's fees for the month when that channel's item sales of the month (every
 * branch) come to zero or less, less what reversals of earlier months' take back in it.
 */
async function feesNotCarriedOf(
  tx: Tx,
  env: ProfitEnv,
  month: BusinessMonth,
  from: string,
  to: string,
): Promise<string> {
  const fees = await feeExpensesOf(tx, env, month)
  if (fees.marked.size === 0 && compareDecimal(fees.takenBack, '0') === 0) return zero
  return feesNotCarried(month, from, to, fees, await channelSalesOf(tx, env, month))
}

/** A month of the business level: its costs, what its sales did not carry, and the fees no line did. */
export interface LevelMonth {
  readonly costs: string | null
  readonly notCarried: string | null
  readonly feesNotCarried: string | null
}

/**
 * The business level of the days `from` … `to` (Q6, D-223): every group added, less, month by month,
 * the month's costs over its days counted (costsSpanOf: whole once it is over, so far while it runs,
 * from the first sale in a first month; nothing before the first sale) in place of the shares its
 * sales carry, and the app fees marked for the month that no sold line carries (D-250). Also each
 * month's costs and what its sales did not carry. Null costs with both modules off.
 */
export async function businessLevel(
  tx: Tx,
  env: ProfitEnv,
  groups: readonly ProfitGroupSums[],
  from: string,
  to: string,
): Promise<{
  total: BusinessRealProfit
  months: ReadonlyMap<BusinessMonth, LevelMonth>
}> {
  const all = sumRealProfit(
    groups.flatMap((g) => g.pieces),
    groups.flatMap((g) => g.deliveries),
  )
  const months = new Map<BusinessMonth, LevelMonth>()
  if (!costsOn(env)) return { total: businessRealProfit(all, { state: 'off' }), months }
  const carried = new Map<BusinessMonth, string>()
  for (const piece of groups.flatMap((g) => g.pieces)) {
    if (piece.runningCosts?.amount) {
      carried.set(
        piece.month,
        sumDecimals([carried.get(piece.month) ?? zero, piece.runningCosts.amount]),
      )
    }
  }
  let costs = '0'
  let fees = '0'
  for (let month = monthOf(from); month <= monthOf(to); month = addMonths(month, 1)) {
    const span = costsSpanOf(month, env.today, env.firstSaleDay)
    if (span === null) continue
    const dayFrom = span.from > from ? span.from : from
    const dayTo = span.to < to ? span.to : to
    if (dayFrom > dayTo) continue
    const own = (await monthCostsBetween(tx, env, month, dayFrom, dayTo)) ?? zero
    const ownFees = await feesNotCarriedOf(tx, env, month, dayFrom, dayTo)
    costs = sumDecimals([costs, own])
    fees = sumDecimals([fees, ownFees])
    months.set(month, {
      costs: own,
      notCarried: subtractDecimals(own, carried.get(month) ?? zero),
      feesNotCarried: ownFees,
    })
  }
  return {
    total: businessRealProfit(all, { state: 'on', costs, feesNotCarried: fees }),
    months,
  }
}
