import { isUuid } from '@bizcost/domain'

// Which sheet Today's sales shows (M3 Step 2; Q9), kept in the address so a reload, the browser's
// Back or a link from the Sales list opens the same one: `?date=` (its day; for several days, the
// last), `?from=` (several days: the first, before `date` in the same month), `?channel=` and
// `?branch=`. Today and no channel or branch (the business's only channel, the default branch) are
// left out. A day after today is never asked for: it reads as today.

export interface SheetParams {
  readonly businessDate: string
  readonly periodFrom: string | null
  readonly channelId: string | null
  readonly locationId: string | null
}

/** "These sales are for": today, another day, or several days within one month. */
export type SheetDays = 'today' | 'day' | 'days'

const BUSINESS_DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

function day(value: string | null): string | null {
  return value && BUSINESS_DAY.test(value) ? value : null
}

function id(value: string | null): string | null {
  return value && isUuid(value) ? value.toLowerCase() : null
}

/** The day before `day` (YYYY-MM-DD). */
export function previousDay(value: string): string {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

/** Whether `from`–`to` is a sheet for several days: before `to`, in the same month. */
export function isPeriod(from: string, to: string): boolean {
  return from < to && from.slice(0, 7) === to.slice(0, 7)
}

export function readSheetParams(params: URLSearchParams, today: string): SheetParams {
  const date = day(params.get('date'))
  const businessDate = date && date <= today ? date : today
  const from = day(params.get('from'))
  return {
    businessDate,
    periodFrom: from && isPeriod(from, businessDate) ? from : null,
    channelId: id(params.get('channel')),
    locationId: id(params.get('branch')),
  }
}

/** The address's query for `next` (today, no period, channel or branch left out). */
export function writeSheetParams(next: SheetParams, today: string): string {
  const query = new URLSearchParams()
  if (next.businessDate !== today || next.periodFrom) query.set('date', next.businessDate)
  if (next.periodFrom) query.set('from', next.periodFrom)
  if (next.channelId) query.set('channel', next.channelId)
  if (next.locationId) query.set('branch', next.locationId)
  return query.toString()
}

/** Which of "today / another day / several days" the sheet is. */
export function sheetDays(params: SheetParams, today: string): SheetDays {
  if (params.periodFrom) return 'days'
  return params.businessDate === today ? 'today' : 'day'
}

/**
 * The days a choice starts with: today; yesterday (another day); this month up to today, or last
 * month on the 1st (several days, which need two days of one month).
 */
export function daysFor(
  choice: SheetDays,
  today: string,
): Pick<SheetParams, 'businessDate' | 'periodFrom'> {
  if (choice === 'today') return { businessDate: today, periodFrom: null }
  if (choice === 'day') return { businessDate: previousDay(today), periodFrom: null }
  const first = `${today.slice(0, 7)}-01`
  if (first < today) return { businessDate: today, periodFrom: first }
  const lastMonthEnd = previousDay(first)
  return { businessDate: lastMonthEnd, periodFrom: `${lastMonthEnd.slice(0, 7)}-01` }
}

/** The sheet's address under the business's Sales. */
export function sheetHref(businessId: string, params: SheetParams, today: string): string {
  const query = writeSheetParams(params, today)
  return `/b/${businessId}/sales/today${query ? `?${query}` : ''}`
}
