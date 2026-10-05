// The books-closed date on the document screens (D-114 rule 6, D-137, D-143, D-205): nothing dated on or
// before it can be finalized or reversed, and nothing is ever dated after today. The screens say so
// next to the date before the person taps Finalize, instead of after.

/** The day after `day` (YYYY-MM-DD). */
export function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

/**
 * Why a document dated `businessDate` can't be finalized because of the closed books: `today` when
 * they are closed up to today (no day can be picked: it waits for tomorrow or open books),
 * `earlier` when a later day can be picked; null when the books don't stop it.
 */
export function closedFor(
  businessDate: string,
  today: string,
  closedThrough: string | null,
): 'today' | 'earlier' | null {
  if (closedThrough === null || businessDate === '' || businessDate > closedThrough) return null
  return closedThrough >= today ? 'today' : 'earlier'
}

/** The first day a document can be dated to be finalized (undefined when the books are open). */
export function firstOpenDay(today: string, closedThrough: string | null): string | undefined {
  if (closedThrough === null || closedThrough >= today) return undefined
  return nextDay(closedThrough)
}
