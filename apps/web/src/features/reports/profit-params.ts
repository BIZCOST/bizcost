import {
  PROFIT_GROUPS,
  PROFIT_PERIOD_MONTHS_MAX,
  PROFIT_SHOWS,
  type ProfitGroup,
  type ProfitShow,
  type ProfitSort,
  type ProfitSummaryInput,
} from '@bizcost/contracts'
import { addMonths, daysIn, firstDayOf, monthOf } from '@bizcost/domain'

// What Reports → Real profit shows (M3 Step 3), kept in the address so a reload or a shared link shows
// the same report: the period (`?period=`, and `?from=` / `?to=` for chosen dates), how it is grouped
// (`?by=`), the order (`?sort=`) and which groups (`?show=`). Sorting or showing by profit or margin is
// never offered to a member who does not see profit (the API refuses it as FORBIDDEN: it would reveal
// the values), and grouping by branch only to a business with branches (CAPABILITY_DISABLED). A link
// that asks for one falls back to the default.

export const PROFIT_PERIODS = [
  'this_month',
  'last_month',
  'last_3_months',
  'last_12_months',
  'this_year',
  'custom',
] as const
export type ProfitPeriod = (typeof PROFIT_PERIODS)[number]

/** The groupings in the page's order (the plan's: month, week, product, channel, branch, day). */
export const GROUP_ORDER: readonly ProfitGroup[] = [
  'month',
  'week',
  'product',
  'channel',
  'branch',
  'day',
]

export type SortOrder = 'asc' | 'desc'

/** One choice of "Sort by": what it sorts on and the direction. */
export interface ProfitSortChoice {
  readonly sort: ProfitSort
  readonly order: SortOrder
}

export interface ProfitParams {
  readonly period: ProfitPeriod
  /** The chosen days (`custom` only; '' while not chosen). */
  readonly from: string
  readonly to: string
  readonly by: ProfitGroup
  readonly sort: ProfitSort
  readonly order: SortOrder
  readonly show: ProfitShow
}

/** What the member may use: profit (reports.profit.view with what it needs) and branches. */
export interface ProfitAccess {
  readonly profitShown: boolean
  readonly branches: boolean
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

/** Months, weeks and days read in time order; products, channels and branches by name or figures. */
export function isTimeGroup(by: ProfitGroup): boolean {
  return by === 'month' || by === 'week' || by === 'day'
}

/** The groupings this member may pick (by branch only with branches). */
export function groupChoices(access: ProfitAccess): ProfitGroup[] {
  return GROUP_ORDER.filter((by) => by !== 'branch' || access.branches)
}

/**
 * The "Sort by" choices for a grouping, the most useful first: time groups oldest or newest first,
 * the others by sales, then by name; profit and margin only for a member who sees them.
 */
export function sortChoices(by: ProfitGroup, access: ProfitAccess): ProfitSortChoice[] {
  const time = isTimeGroup(by)
  const choices: ProfitSortChoice[] = time
    ? [
        { sort: 'key', order: 'asc' },
        { sort: 'key', order: 'desc' },
        { sort: 'sales', order: 'desc' },
        { sort: 'sales', order: 'asc' },
      ]
    : [
        { sort: 'sales', order: 'desc' },
        { sort: 'sales', order: 'asc' },
        { sort: 'key', order: 'asc' },
      ]
  if (access.profitShown) {
    choices.push(
      { sort: 'profit', order: 'desc' },
      { sort: 'profit', order: 'asc' },
      { sort: 'margin_percent', order: 'desc' },
      { sort: 'margin_percent', order: 'asc' },
    )
  }
  return choices
}

/** The "Show" choices: every group, or (seeing profit) those at a loss, a low margin, incomplete. */
export function showChoices(access: ProfitAccess): ProfitShow[] {
  return access.profitShown ? [...PROFIT_SHOWS] : ['all']
}

/** The order a grouping starts in: time in order, the others the best sellers first. */
export function defaultSort(by: ProfitGroup): ProfitSortChoice {
  return isTimeGroup(by) ? { sort: 'key', order: 'asc' } : { sort: 'sales', order: 'desc' }
}

/** A choice of "Sort by" as one value of the box and the address ("sales_desc"). */
export function sortValue(choice: ProfitSortChoice): string {
  return `${choice.sort}_${choice.order}`
}

function sortOf(value: string | null): ProfitSortChoice | null {
  const match = value ? /^(key|sales|profit|margin_percent)_(asc|desc)$/.exec(value) : null
  return match ? { sort: match[1] as ProfitSort, order: match[2] as SortOrder } : null
}

const isPeriod = (value: string | null): value is ProfitPeriod =>
  (PROFIT_PERIODS as readonly (string | null)[]).includes(value)
const isGroup = (value: string | null): value is ProfitGroup =>
  (PROFIT_GROUPS as readonly (string | null)[]).includes(value)
const isShow = (value: string | null): value is ProfitShow =>
  (PROFIT_SHOWS as readonly (string | null)[]).includes(value)

/** The report the address asks for, with what this member may not use falling back to the default. */
export function readProfitParams(search: URLSearchParams, access: ProfitAccess): ProfitParams {
  const periodValue = search.get('period')
  const period = isPeriod(periodValue) ? periodValue : 'this_month'
  const day = (key: string) => {
    const value = search.get(key) ?? ''
    return DAY.test(value) ? value : ''
  }
  const byValue = search.get('by')
  const by =
    isGroup(byValue) && groupChoices(access).includes(byValue) ? byValue : ('product' as const)
  const asked = sortOf(search.get('sort'))
  const allowed = sortChoices(by, access)
  const sort =
    asked && allowed.some((c) => c.sort === asked.sort && c.order === asked.order)
      ? asked
      : defaultSort(by)
  const showValue = search.get('show')
  const show = isShow(showValue) && showChoices(access).includes(showValue) ? showValue : 'all'
  return {
    period,
    from: period === 'custom' ? day('from') : '',
    to: period === 'custom' ? day('to') : '',
    by,
    sort: sort.sort,
    order: sort.order,
    show,
  }
}

/**
 * The address with `next` applied (the defaults left out). A new grouping starts in its own order
 * (time in order, the others by sales) unless an order is given with it.
 */
export function writeProfitParams(search: URLSearchParams, next: Partial<ProfitParams>): string {
  const params = new URLSearchParams(search.toString())
  const set = (key: string, value: string | undefined, fallback: string) => {
    if (value === undefined) return
    if (value === fallback || value === '') params.delete(key)
    else params.set(key, value)
  }
  set('period', next.period, 'this_month')
  if (next.period !== undefined && next.period !== 'custom') {
    params.delete('from')
    params.delete('to')
  }
  set('from', next.from, '')
  set('to', next.to, '')
  set('by', next.by, 'product')
  if (next.by !== undefined && next.sort === undefined) params.delete('sort')
  if (next.sort !== undefined) {
    const by = next.by ?? (params.get('by') as ProfitGroup | null) ?? 'product'
    const value = sortValue({ sort: next.sort, order: next.order ?? 'asc' })
    set('sort', value, sortValue(defaultSort(by)))
  }
  set('show', next.show, 'all')
  return params.toString()
}

/** The first day after which a period from `from` is longer than 12 months (the API's rule). */
export function periodEnd(from: string): string {
  const month = addMonths(monthOf(from), PROFIT_PERIOD_MONTHS_MAX)
  const day = Math.min(Number(from.slice(8, 10)), daysIn(month))
  return `${month}-${String(day).padStart(2, '0')}`
}

export type PeriodProblem = 'order' | 'tooLong' | 'future'

/** The days a period covers, as of the business's `today`, or why the chosen days can't be shown. */
export function periodDays(
  params: Pick<ProfitParams, 'period' | 'from' | 'to'>,
  today: string,
): { from: string; to: string } | { problem: PeriodProblem } | null {
  const month = monthOf(today)
  switch (params.period) {
    case 'this_month':
      return { from: firstDayOf(month), to: today }
    case 'last_month': {
      const last = addMonths(month, -1)
      return { from: firstDayOf(last), to: `${last}-${String(daysIn(last)).padStart(2, '0')}` }
    }
    case 'last_3_months':
      return { from: firstDayOf(addMonths(month, -2)), to: today }
    case 'last_12_months':
      return { from: firstDayOf(addMonths(month, -11)), to: today }
    case 'this_year':
      return { from: `${today.slice(0, 4)}-01-01`, to: today }
    case 'custom': {
      if (!DAY.test(params.from) || !DAY.test(params.to)) return null
      if (params.to < params.from) return { problem: 'order' }
      if (params.from > today) return { problem: 'future' }
      if (params.to >= periodEnd(params.from)) return { problem: 'tooLong' }
      return { from: params.from, to: params.to }
    }
  }
}

/** The first days a custom period starts with: this month so far. */
export function customStart(today: string): { from: string; to: string } {
  return { from: firstDayOf(monthOf(today)), to: today }
}

/** `profit.summary`'s input for the report, or null while its days are not known or not valid. */
export function profitInput(params: ProfitParams, today: string | null): ProfitSummaryInput | null {
  if (today === null) return null
  const days = periodDays(params, today)
  if (days === null || 'problem' in days) return null
  return {
    from: days.from,
    to: days.to,
    groupBy: params.by,
    sort: params.sort,
    order: params.order,
    show: params.show,
  }
}

/**
 * Today as this device reads it (YYYY-MM-DD in its own time zone), for a business whose today the
 * API does not give this page: the API counts up to its own today whatever `to` says.
 */
export function deviceToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}
