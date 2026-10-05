import {
  PROFIT_PERIOD_MONTHS_MAX,
  type ProfitGroupDto,
  type ProfitMonthDto,
  type ProfitPartsDto,
  type profitSummaryInput,
  type ProfitSummaryDto,
} from '@bizcost/contracts'
import type { Tx } from '@bizcost/db'
import {
  addMonths,
  compareDecimal,
  costRatio,
  firstDayOf,
  marginConcern,
  monthOf,
  REAL_PROFIT_REASONS,
  sumDecimals,
  type BusinessMonth,
  type RealProfitSum,
} from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { assertQueryable } from '../trpc'
import {
  branchLimited,
  businessLevel,
  costsOn,
  lastDayOf,
  profitEnvOf,
  profitGroups,
  profitShown,
  ratesOf,
  type ProfitEnv,
  type ProfitGroupSums,
} from './real-profit'

// Reports → Real profit (ROADMAP.md M3 Step 3; D-223; Q6–Q8, Q11, Q14 of D-218): `profit.summary`,
// worked out on read by services/real-profit.ts. Module `reports` (planned until Release A, previewed
// on local servers, D-125) and `reports.sales.view` (the router checks them). Sales figures with that
// key (every sale seen, H1); profit, its parts, the rates, the month's costs and the completeness note
// only with `reports.profit.view` (with what it needs: the costs switch, Product costs, D-190):
// otherwise they are withheld here (null), never computed into an answer (ARCHITECTURE §Redaction),
// and tagged as well. The month's running-cost total shows to whoever sees profit (Q11 A); its
// categories never do here. A member limited to some branches sees their branches' sales at the
// shares they carry, without the business-level line (D-231): no month's costs, no "not carried", and
// no business-wide sales or costs behind the rate (the rate itself is the business's, B18).
// Grouping by branch needs branches (CAPABILITY_DISABLED, D-192). Sorting or showing by a value the
// member cannot see is FORBIDDEN before anything is read (assertQueryable).

type SummaryInput = z.output<typeof profitSummaryInput>

const NULL_PROFIT = {
  materials: null,
  fees: null,
  deliveryCost: null,
  deliveryMargin: null,
  runningCosts: null,
  ownerTime: null,
  profit: null,
  marginPercent: null,
  beforeRunningCosts: null,
  complete: null,
  reasons: null,
} as const

/** A sum as the DTO gives it: the sales figures always, the rest only when profit is shown. */
function partsOf(sum: RealProfitSum, shown: boolean): ProfitPartsDto {
  const sales = {
    sales: sum.sales,
    itemSales: sum.itemSales,
    deliveryCharged: sum.deliveryCharged,
  }
  if (!shown) return { ...sales, ...NULL_PROFIT }
  return {
    ...sales,
    materials: sum.materials,
    fees: sum.fees,
    deliveryCost: sum.deliveryCost,
    deliveryMargin: sum.deliveryMargin,
    runningCosts: sum.runningCosts,
    ownerTime: sum.ownerTime,
    profit: sum.profit,
    marginPercent: sum.marginPercent,
    beforeRunningCosts: sum.beforeRunningCosts,
    complete: sum.complete,
    reasons: [...sum.reasons],
  }
}

/** The first day after which a period is longer than PROFIT_PERIOD_MONTHS_MAX months. */
function periodEnd(from: string): string {
  const month = addMonths(monthOf(from), PROFIT_PERIOD_MONTHS_MAX)
  const day = Number(from.slice(8, 10))
  const last = Number(lastDayOf(month).slice(8, 10))
  return `${month}-${String(Math.min(day, last)).padStart(2, '0')}`
}

/** Names of the products, channels and branches a report names (as they are now). */
async function namesOf(
  tx: Tx,
  businessId: string,
  grouping: SummaryInput['groupBy'],
  keys: readonly string[],
): Promise<Map<string, { name: string; unit: string | null; kind: string | null }>> {
  const ids = keys.filter((k) => /^[0-9a-f-]{36}$/.test(k))
  const result = new Map<string, { name: string; unit: string | null; kind: string | null }>()
  if (ids.length === 0) return result
  const list = sql`${`{${ids.join(',')}}`}::text::uuid[]`
  if (grouping === 'product') {
    const rows = (await tx.execute(sql`
      select p.id, p.name, p.unit from app.products_services p
       where p.business_id = ${businessId} and p.id = any(${list})
    `)) as unknown as { id: string; name: string; unit: string }[]
    for (const r of rows) result.set(r.id, { name: r.name, unit: r.unit, kind: null })
  } else if (grouping === 'channel') {
    const rows = (await tx.execute(sql`
      select c.id, c.name, c.kind from app.sales_channels c
       where c.business_id = ${businessId} and c.id = any(${list})
    `)) as unknown as { id: string; name: string; kind: string }[]
    for (const r of rows) result.set(r.id, { name: r.name, unit: null, kind: r.kind })
  } else if (grouping === 'branch') {
    const rows = (await tx.execute(sql`
      select l.id, l.name from app.locations l
       where l.business_id = ${businessId} and l.id = any(${list})
    `)) as unknown as { id: string; name: string }[]
    for (const r of rows) result.set(r.id, { name: r.name, unit: null, kind: null })
  }
  return result
}

/** The days a time group covers within the period. */
function daysOf(
  grouping: SummaryInput['groupBy'],
  key: string,
  from: string,
  to: string,
): { from: string | null; to: string | null } {
  const clip = (a: string, b: string) => ({ from: a < from ? from : a, to: b > to ? to : b })
  if (grouping === 'month') return clip(firstDayOf(key), lastDayOf(key))
  if (grouping === 'day') return { from: key, to: key }
  if (grouping === 'week') {
    const end = new Date(Date.parse(`${key}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10)
    return clip(key, end)
  }
  return { from: null, to: null }
}

/** `profit.summary` (see above). */
export function profitSummary(ctx: BusinessCtx, input: SummaryInput): Promise<ProfitSummaryDto> {
  const shown = profitShown(ctx)
  // Sorting or showing by profit, margins or what is missing needs them seen (D-209): FORBIDDEN.
  const needsProfit =
    input.sort === 'profit' || input.sort === 'margin_percent' || input.show !== 'all'
  if (needsProfit) {
    assertQueryable(ctx, [{ name: input.sort, category: 'profit_margin' }])
    if (!shown) throw new AppError('forbidden', { message: `cannot query on ${input.sort}` })
  }
  if (input.groupBy === 'branch' && !ctx.access.capabilities.multi_location) {
    throw new AppError('capability_disabled')
  }
  if (input.to >= periodEnd(input.from)) {
    throw new AppError('validation', {
      message: `to: at most ${PROFIT_PERIOD_MONTHS_MAX} months after from`,
    })
  }
  return ctx.tx(async (tx) => {
    const env = await profitEnvOf(tx, ctx)
    if (input.from > env.today) throw new AppError('future_date')
    const to = input.to > env.today ? env.today : input.to
    return summarize(tx, ctx, env, { ...input, to }, shown)
  })
}

async function summarize(
  tx: Tx,
  ctx: BusinessCtx,
  env: ProfitEnv,
  input: SummaryInput,
  shown: boolean,
): Promise<ProfitSummaryDto> {
  const limited = branchLimited(ctx)
  const locations = ctx.access.locationScope
  const scope = locations.all ? null : [...locations.ids]
  const groups = await profitGroups(tx, env, {
    from: input.from,
    to: input.to,
    grouping: input.groupBy,
    scope,
  })
  const names = await namesOf(
    tx,
    env.businessId,
    input.groupBy,
    groups.map((g) => g.key),
  )
  // The business level: only for a member who sees profit (it is made of costs), never for one
  // limited to branches, nor before anything was sold.
  const level = shown && !limited && env.firstSaleDay !== null
  const business = level ? await businessLevel(tx, env, groups, input.from, input.to) : null
  const months: BusinessMonth[] = []
  for (let m = monthOf(input.from); m <= monthOf(input.to); m = addMonths(m, 1)) months.push(m)
  const rates = await ratesOf(tx, env, months)

  let rows: (ProfitGroupDto & { sortName: string })[] = groups.map((group) => {
    const named = names.get(group.key)
    const days = daysOf(input.groupBy, group.key, input.from, input.to)
    return {
      ...partsOf(group.sum, shown),
      key: group.key,
      name: named?.name ?? null,
      from: days.from,
      to: days.to,
      quantity: input.groupBy === 'product' && named ? group.quantity : null,
      unit: named?.unit ?? null,
      channelKind: named?.kind ?? null,
      sortName: (named?.name ?? group.key).toLowerCase(),
    }
  })
  if (input.show === 'loss')
    rows = rows.filter((r) => marginConcern(r.marginPercent ?? null) === 'loss')
  if (input.show === 'low_margin')
    rows = rows.filter((r) => marginConcern(r.marginPercent ?? null) !== null)
  if (input.show === 'incomplete') rows = rows.filter((r) => r.complete === false)
  const sign = input.order === 'asc' ? 1 : -1
  const timeGroup = input.groupBy === 'month' || input.groupBy === 'week' || input.groupBy === 'day'
  rows.sort((a, b) => {
    const value = (row: ProfitGroupDto): string | null =>
      input.sort === 'sales'
        ? row.sales
        : input.sort === 'profit'
          ? (row.profit ?? null)
          : input.sort === 'margin_percent'
            ? (row.marginPercent ?? null)
            : null
    if (input.sort !== 'key') {
      const x = value(a)
      const y = value(b)
      if (x !== null && y !== null) {
        const order = compareDecimal(x, y)
        if (order !== 0) return sign * order
      } else if (x !== null || y !== null) {
        return x === null ? 1 : -1
      }
    }
    // By the group itself: time in order, names as people read them (what is not a product last).
    if (timeGroup)
      return (input.sort === 'key' ? sign : 1) * (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    const byName =
      (a.name === null ? 1 : 0) - (b.name === null ? 1 : 0) || a.sortName.localeCompare(b.sortName)
    return (
      (input.sort === 'key' ? sign : 1) * (byName || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    )
  })

  const plain = business?.total ?? sumAll(groups)
  const total = {
    ...partsOf(plain, shown),
    monthCosts: shown && business ? business.total.monthCosts : null,
    notCarried: shown && business ? business.total.notCarried : null,
    feesNotCarried: shown && business ? business.total.feesNotCarried : null,
  }
  const monthRows: ProfitMonthDto[] = months.map((month) => {
    const rate = rates.get(month)!
    const own = business?.months.get(month)
    const source = rate.source
    const from = month === monthOf(input.from) ? input.from : firstDayOf(month)
    const to = month === monthOf(input.to) ? input.to : lastDayOf(month)
    const withheld = !shown
    return {
      month,
      from,
      to,
      state: withheld ? null : rate.rate.state,
      basis: withheld ? null : (source?.basis ?? null),
      rateMonth: withheld ? null : (source?.month ?? null),
      rateFrom: withheld ? null : (source?.from ?? null),
      rateTo: withheld ? null : (source?.to ?? null),
      showsOn: withheld ? null : rate.showsOn,
      // The business-wide costs and item sales behind the rate: not to a member limited to branches.
      rateCosts: withheld || limited ? null : rate.rate.costs,
      rateSales: withheld || limited ? null : rate.rate.sales,
      rate: withheld ? null : rate.rate.rate,
      costs: withheld || !own ? null : own.costs,
      notCarried: withheld || !own ? null : own.notCarried,
    }
  })
  return {
    data: {
      from: input.from,
      to: input.to,
      groupBy: input.groupBy,
      currency: env.currency,
      today: env.today,
      profitShown: shown,
      businessLevel: business !== null && costsOn(env),
      groups: rows.map(({ sortName: _sortName, ...row }) => row),
      total,
      months: monthRows,
      completeness: shown ? completenessOf(groups) : null,
    },
    meta: { redacted: [] },
  }
}

/** Every group added (a member limited to branches: no month's costs). */
function sumAll(groups: readonly ProfitGroupSums[]): RealProfitSum {
  const sales = sumDecimals(groups.map((g) => g.sum.sales))
  const profit = sumDecimals(groups.map((g) => g.sum.profit))
  const reasons = new Set(groups.flatMap((g) => g.sum.reasons))
  const ordered = REAL_PROFIT_REASONS.filter((r) => reasons.has(r))
  const add = (pick: (s: RealProfitSum) => string) => sumDecimals(groups.map((g) => pick(g.sum)))
  return {
    sales: sales as RealProfitSum['sales'],
    itemSales: add((s) => s.itemSales) as RealProfitSum['itemSales'],
    materials: add((s) => s.materials) as RealProfitSum['materials'],
    fees: add((s) => s.fees) as RealProfitSum['fees'],
    deliveryCharged: add((s) => s.deliveryCharged) as RealProfitSum['deliveryCharged'],
    deliveryCost: add((s) => s.deliveryCost) as RealProfitSum['deliveryCost'],
    deliveryMargin: add((s) => s.deliveryMargin) as RealProfitSum['deliveryMargin'],
    runningCosts: add((s) => s.runningCosts) as RealProfitSum['runningCosts'],
    ownerTime: add((s) => s.ownerTime) as RealProfitSum['ownerTime'],
    profit: profit as RealProfitSum['profit'],
    marginPercent: percentOf(profit, sales),
    beforeRunningCosts: groups.some((g) => g.sum.beforeRunningCosts),
    reasons: ordered,
    complete: ordered.length === 0,
  }
}

/** part × 100 ÷ whole, divided once (12 decimals); null when the whole is zero or less. */
function percentOf(part: string, whole: string): string | null {
  return costRatio([part, '100'], [whole])
}

/**
 * "96 % of sales have complete costs", and what is missing (H2: withheld like profit). On the sales
 * the lines concern (each line's size: a sale taken back on a later day by its own lines, never
 * offsetting another's, D-250), so the share is within 0–100 % and no amount missing is negative.
 */
function completenessOf(groups: readonly ProfitGroupSums[]) {
  const sales = sumDecimals(groups.map((g) => g.considered))
  const completeSales = sumDecimals(groups.map((g) => g.completeSales))
  const missing = REAL_PROFIT_REASONS.flatMap((reason) => {
    const amounts = groups.flatMap((g) => {
      const value = g.missing.get(reason)
      return value === undefined ? [] : [value]
    })
    return amounts.length === 0 ? [] : [{ reason, sales: sumDecimals(amounts) }]
  })
  return {
    sales,
    completeSales,
    percent: percentOf(completeSales, sales),
    missing,
  }
}
