import type { ExpenseListInput } from '@bizcost/contracts'
import {
  BUSINESS_MONTH_PATTERN,
  EXPENSE_STATUSES,
  isUuid,
  type ExpenseStatus,
} from '@bizcost/domain'

// The expenses list's filters (M2 Step 5), kept in the address so a reload or a shared link shows the
// same list: `?status=` (`submitted`: waiting for approval), `?category=`, `?month=` (the month the
// bills are for, `YYYY-MM`, D-194), `?from=`, `?to=` (business days) and `?q=` (what it was for, the
// number, the supplier's or the category's name). Values the address holds but the API would refuse
// are left out.

export const EXPENSE_STATUS_FILTERS = ['all', ...EXPENSE_STATUSES] as const
export type ExpenseStatusFilter = 'all' | ExpenseStatus

export interface ExpenseFilters {
  readonly status: ExpenseStatusFilter
  readonly categoryId: string | null
  /** The month the bills are for (`YYYY-MM`). */
  readonly month: string | null
  readonly from: string | null
  readonly to: string | null
  readonly search: string
}

const BUSINESS_DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

function isStatus(value: string | null): value is ExpenseStatusFilter {
  return (EXPENSE_STATUS_FILTERS as readonly (string | null)[]).includes(value)
}

function day(value: string | null): string | null {
  return value && BUSINESS_DAY.test(value) ? value : null
}

export function readExpenseFilters(params: URLSearchParams): ExpenseFilters {
  const status = params.get('status')
  const category = params.get('category')
  const month = params.get('month')
  return {
    status: isStatus(status) ? status : 'all',
    categoryId: category && isUuid(category) ? category.toLowerCase() : null,
    month: month && BUSINESS_MONTH_PATTERN.test(month) ? month : null,
    from: day(params.get('from')),
    to: day(params.get('to')),
    search: (params.get('q') ?? '').trim(),
  }
}

/** The address's query with `next` applied (defaults are left out). */
export function writeExpenseFilters(
  params: URLSearchParams,
  next: Partial<ExpenseFilters>,
): string {
  const query = new URLSearchParams(params.toString())
  const put = (name: string, value: string | null | undefined, empty: string | null = null) => {
    if (value === undefined) return
    if (value === null || value === '' || value === empty) query.delete(name)
    else query.set(name, value)
  }
  put('status', next.status, 'all')
  put('category', next.categoryId)
  put('month', next.month)
  put('from', next.from)
  put('to', next.to)
  put('q', next.search?.trim())
  return query.toString()
}

/** Whether any filter narrows the list (the first-time page shows only without one). */
export function isFiltered(filters: ExpenseFilters): boolean {
  return (
    filters.status !== 'all' ||
    filters.categoryId !== null ||
    filters.month !== null ||
    filters.from !== null ||
    filters.to !== null ||
    filters.search !== ''
  )
}

/** expense.list's input for the filters (without the cursor). */
export function listInput(filters: ExpenseFilters): ExpenseListInput {
  return {
    status: filters.status,
    categoryId: filters.categoryId ?? undefined,
    periodMonth: filters.month ?? undefined,
    from: filters.from ?? undefined,
    to: filters.to ?? undefined,
    search: filters.search || undefined,
  }
}
