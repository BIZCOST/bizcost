import type { StarterCostCategory } from './keys'

// The month an expense is for (the owner's request of 2026-09-30): a bill is often issued after the
// month it covers (this month's electricity comes next month), so an expense says which month it is
// for, apart from its bill's date. Months are `YYYY-MM` on the wire and the first day of the month in
// the database (`expenses.period_month`). Real profit (Phase 3) counts each bill in its month.

/** A month, `YYYY-MM`. */
export type BusinessMonth = string

/** `YYYY-MM` with a month from 01 to 12, from year 0001 (no date has a year 0, D-200). */
export const BUSINESS_MONTH_PATTERN = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/

/**
 * The starter categories whose bills usually come after the month they are for: a new expense in one
 * of them is for the month before its bill's date unless the person says otherwise
 * (`cost_categories.billed_next_month`, set for them when a business is set up; any category can be
 * marked so).
 */
export const BILLED_NEXT_MONTH_CATEGORIES: readonly StarterCostCategory[] = [
  'electricity',
  'water',
  'internet',
  'phone',
]

/** How far the month may be from the bill's month: up to 12 months before it and 1 after it. */
export const PERIOD_MONTHS_BEFORE = 12
export const PERIOD_MONTHS_AFTER = 1

/** The month of a business day (`YYYY-MM-DD` → `YYYY-MM`). */
export function monthOf(day: string): BusinessMonth {
  return day.slice(0, 7)
}

/** `month` moved by `count` months (negative: back). */
export function addMonths(month: BusinessMonth, count: number): BusinessMonth {
  const [year, index] = [Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1]
  const total = year * 12 + index + count
  const moved = Math.floor(total / 12)
  const within = total - moved * 12
  return `${String(moved).padStart(4, '0')}-${String(within + 1).padStart(2, '0')}`
}

/** The first day of a month, as the database stores it (`YYYY-MM-01`). */
export function firstDayOf(month: BusinessMonth): string {
  return `${month}-01`
}

/** The day after a business day (`YYYY-MM-DD`). */
function dayAfter(day: string): string {
  const next = new Date(`${day}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString().slice(0, 10)
}

/**
 * The first month the books leave open (D-114 rule 6, D-200): a month is closed once the books are
 * closed through its last day, so it is the month of the day after the books-closed date. Null while
 * the books are open. A month closed only in part stays open (its closed days are checked by the day).
 */
export function firstOpenMonth(closedThrough: string | null): BusinessMonth | null {
  return closedThrough === null ? null : monthOf(dayAfter(closedThrough))
}

/** Whether the books are closed through the last day of `month`: nothing more counts in it. */
export function periodMonthClosed(month: BusinessMonth, closedThrough: string | null): boolean {
  const open = firstOpenMonth(closedThrough)
  return open !== null && month < open
}

/**
 * The month a new expense is for when the person does not say: the month before its bill's date for a
 * category billed the month after, else the bill's own month. Never a closed month (`closedThrough`,
 * D-200): then the first open month, while that still fits the bill's date (a bill dated in the closed
 * period cannot be finalized anyway, and keeps the plain default).
 */
export function defaultPeriodMonth(
  businessDate: string,
  billedNextMonth: boolean,
  closedThrough: string | null = null,
): BusinessMonth {
  const month = monthOf(businessDate)
  const plain = billedNextMonth ? addMonths(month, -1) : month
  const open = firstOpenMonth(closedThrough)
  if (open === null || plain >= open || !periodMonthAllowed(open, businessDate)) return plain
  return open
}

/** Whether `month` is within 12 months before and 1 month after the bill's month. */
export function periodMonthAllowed(month: BusinessMonth, businessDate: string): boolean {
  if (!BUSINESS_MONTH_PATTERN.test(month)) return false
  const billed = monthOf(businessDate)
  return (
    month >= addMonths(billed, -PERIOD_MONTHS_BEFORE) &&
    month <= addMonths(billed, PERIOD_MONTHS_AFTER)
  )
}
