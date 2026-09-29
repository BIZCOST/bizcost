import type { ProductCostFilter, ProductCostListInput, ProductCostSort } from '@bizcost/contracts'
import type { SensitivityCategory } from '@bizcost/domain'

// What the Product costs list shows (M2 Step 6), kept in the address so a reload or a shared link
// shows the same list: a search (`?q=`), which products (`?status=`), the order (`?sort=` and
// `?dir=`) and a filter (`?filter=`). Sorting or filtering on a value the member may not see is never
// offered (redaction: it would reveal the value, and the API refuses it as FORBIDDEN): costs need
// `cost` visible, margins `profit_margin`. A link that asks for one falls back to the name order, or
// no filter. The page offers which products and the filter as one choice, "Show" (in use, incomplete,
// sold at a loss, archived, all): a filter is always over the products in use.

export const COST_LIST_STATUSES = ['active', 'archived', 'all'] as const
export type CostListStatus = (typeof COST_LIST_STATUSES)[number]
export type SortDirection = 'asc' | 'desc'

export interface CostListParams {
  readonly search: string
  readonly status: CostListStatus
  readonly sort: ProductCostSort
  readonly direction: SortDirection
  readonly filter: ProductCostFilter | null
}

/** One choice of the "Sort by" box: a column and its direction. */
export interface SortChoice {
  readonly sort: ProductCostSort
  readonly direction: SortDirection
}

/** The "Sort by" choices, in the box's order (the most useful first). */
export const SORT_CHOICES: readonly SortChoice[] = [
  { sort: 'name', direction: 'asc' },
  { sort: 'name', direction: 'desc' },
  { sort: 'margin_percent', direction: 'asc' },
  { sort: 'margin_percent', direction: 'desc' },
  { sort: 'margin', direction: 'asc' },
  { sort: 'margin', direction: 'desc' },
  { sort: 'cost', direction: 'desc' },
  { sort: 'cost', direction: 'asc' },
  { sort: 'price', direction: 'desc' },
  { sort: 'price', direction: 'asc' },
]

/** The direction a column sorts in first (the lowest margins first: what needs a look). */
export const FIRST_DIRECTION: Readonly<Record<ProductCostSort, SortDirection>> = {
  name: 'asc',
  price: 'desc',
  cost: 'desc',
  margin: 'asc',
  margin_percent: 'asc',
}

/** What the member sees of a product's cost: its visible sensitivity categories. */
export type CostVisibility = readonly SensitivityCategory[]

/** The category a sort or a filter reads (none: every member who sees the page may use it). */
const SORT_NEEDS: Readonly<Record<ProductCostSort, SensitivityCategory | null>> = {
  name: null,
  price: null,
  cost: 'cost',
  margin: 'profit_margin',
  margin_percent: 'profit_margin',
}
const FILTER_NEEDS: Readonly<Record<ProductCostFilter, SensitivityCategory>> = {
  incomplete: 'cost',
  loss: 'profit_margin',
}

export function maySort(visible: CostVisibility, sort: ProductCostSort): boolean {
  const needs = SORT_NEEDS[sort]
  return needs === null || visible.includes(needs)
}

export function mayFilter(visible: CostVisibility, filter: ProductCostFilter): boolean {
  return visible.includes(FILTER_NEEDS[filter])
}

/** The "Sort by" choices this member may use. */
export function sortChoices(visible: CostVisibility): SortChoice[] {
  return SORT_CHOICES.filter((choice) => maySort(visible, choice.sort))
}

/** The filters this member may use (empty: no filter is offered). */
export function filterChoices(visible: CostVisibility): ProductCostFilter[] {
  return (['incomplete', 'loss'] as const).filter((filter) => mayFilter(visible, filter))
}

/** What the "Show" choice picks: the products in use, a filter of them, archived ones, or all. */
export type CostListShow = 'active' | ProductCostFilter | 'archived' | 'all'

/** The "Show" choices this member may use, in the box's order. */
export function showChoices(visible: CostVisibility): CostListShow[] {
  return ['active', ...filterChoices(visible), 'archived', 'all']
}

/** The "Show" choice of these parameters. */
export function showOf(params: Pick<CostListParams, 'status' | 'filter'>): CostListShow {
  return params.filter ?? params.status
}

/** The parameters a "Show" choice sets. */
export function showParams(show: CostListShow): Pick<CostListParams, 'status' | 'filter'> {
  return show === 'incomplete' || show === 'loss'
    ? { status: 'active', filter: show }
    : { status: show, filter: null }
}

function isOneOf<T extends string>(values: readonly T[], value: string | null): value is T {
  return value !== null && (values as readonly string[]).includes(value)
}

const SORTS: readonly ProductCostSort[] = ['name', 'price', 'cost', 'margin', 'margin_percent']

/** The list's parameters from the address, keeping only what this member may use. */
export function readCostListParams(
  params: Pick<URLSearchParams, 'get'>,
  visible: CostVisibility,
): CostListParams {
  const status = params.get('status')
  const sort = params.get('sort')
  const direction = params.get('dir')
  const filter = params.get('filter')
  // No sort in the address: the name order.
  const requested = sort ?? 'name'
  const allowed = isOneOf(SORTS, requested) && maySort(visible, requested)
  const sorted = allowed ? requested : 'name'
  const filtered =
    isOneOf(['incomplete', 'loss'], filter) && mayFilter(visible, filter)
      ? (filter as ProductCostFilter)
      : null
  return {
    search: (params.get('q') ?? '').trim(),
    // A filter is over the products in use.
    status: filtered === null && isOneOf(COST_LIST_STATUSES, status) ? status : 'active',
    sort: sorted,
    // A sort dropped takes its direction with it.
    direction: allowed && isOneOf(['asc', 'desc'], direction) ? direction : FIRST_DIRECTION[sorted],
    filter: filtered,
  }
}

/** The address's query after a change (the defaults are left out). */
export function writeCostListParams(
  params: URLSearchParams,
  next: Partial<CostListParams>,
): string {
  const query = new URLSearchParams(params.toString())
  const set = (key: string, value: string | null | undefined, fallback?: string) => {
    if (value === undefined) return
    if (value === null || value === '' || value === fallback) query.delete(key)
    else query.set(key, value)
  }
  set('q', next.search?.trim())
  set('status', next.status, 'active')
  if (next.sort !== undefined) {
    set('sort', next.sort, 'name')
    const direction = next.direction ?? FIRST_DIRECTION[next.sort]
    // The column's first direction is its default.
    set('dir', direction, FIRST_DIRECTION[next.sort])
  } else set('dir', next.direction)
  set('filter', next.filter)
  return query.toString()
}

/** productCost.list's input for these parameters (without the cursor). */
export function costListInput(params: CostListParams): ProductCostListInput {
  return {
    search: params.search || undefined,
    status: params.status,
    sort: params.sort,
    order: params.direction,
    filter: params.filter ?? undefined,
  }
}

/** Whether the list is narrowed: a search, another status or a filter. */
export function isNarrowed(params: CostListParams): boolean {
  return params.search !== '' || params.status !== 'active' || params.filter !== null
}

/** The order after a click on a column's header: its first direction, or the other one. */
export function nextSort(current: CostListParams, sort: ProductCostSort): SortChoice {
  if (current.sort !== sort) return { sort, direction: FIRST_DIRECTION[sort] }
  return { sort, direction: current.direction === 'asc' ? 'desc' : 'asc' }
}
