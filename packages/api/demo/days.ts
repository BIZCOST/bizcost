// The days of the demo data (docs/ARCHITECTURE.md §Local setup › Demo data; D-185): every record is
// dated back from the business's today when it is first written, as days before it or as a day of
// last month (so last month always holds a whole month of the business, whatever day the seed runs).

/**
 * A record's day: `n` days before the seed day (a number), or day `lastMonthDay` of the month before
 * the seed day's month (its last day for a later day of a shorter month) moved `plus` days (negative:
 * earlier). Never after the seed day: a day past it is the seed day itself.
 */
export type DemoDay = number | { readonly lastMonthDay: number; readonly plus?: number }

/** Day `day` of last month, `plus` days after it (negative: before it). */
export const lastMonth = (day: number, plus = 0): DemoDay => ({ lastMonthDay: day, plus })

/** YYYY-MM-DD `days` days after `day` (negative: before). */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** YYYY-MM-DD of the first day of the month `months` months after the month of `day`. */
export function monthStart(day: string, months: number): string {
  const date = new Date(`${day.slice(0, 7)}-01T00:00:00Z`)
  date.setUTCMonth(date.getUTCMonth() + months)
  return date.toISOString().slice(0, 10)
}

/** The first and last day of the month before the month of `today`. */
export function lastMonthOf(today: string): { from: string; to: string } {
  return { from: monthStart(today, -1), to: addDays(monthStart(today, 0), -1) }
}

/** Whole days from `from` to `to` (YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  const at = (day: string) => new Date(`${day}T00:00:00Z`).getTime()
  return Math.round((at(to) - at(from)) / 86_400_000)
}

/** The day `when` stands for, counted from `today` (YYYY-MM-DD), never after it. */
export function dayOf(when: DemoDay, today: string): string {
  if (typeof when === 'number') return addDays(today, -when)
  const { from, to } = lastMonthOf(today)
  const last = Number(to.slice(8, 10))
  const day = Math.min(Math.max(when.lastMonthDay, 1), last)
  const date = addDays(`${from.slice(0, 8)}${String(day).padStart(2, '0')}`, when.plus ?? 0)
  return date > today ? today : date
}

/** How many days before `today` `when` is. */
export function daysAgoOf(when: DemoDay, today: string): number {
  return daysBetween(dayOf(when, today), today)
}

/** Every day from `from` to `to`, both included. */
export function daysFrom(from: string, to: string): string[] {
  const days: string[] = []
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day)
  return days
}
