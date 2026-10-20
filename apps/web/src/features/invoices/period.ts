// A statement's periods (M3 Step 8; Q27): this month to today, last month whole, the last three
// months, this year; a business day is YYYY-MM-DD.

export type Preset = 'thisMonth' | 'lastMonth' | 'last3' | 'thisYear'
export const PRESETS: readonly Preset[] = ['thisMonth', 'lastMonth', 'last3', 'thisYear']
export const DAY = /^\d{4}-\d{2}-\d{2}$/

/** The first and last day of a preset period ending at the latest today. */
export function periodOf(preset: Preset, today: string): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number) as [number, number]
  const first = (year: number, month: number) => {
    const date = new Date(Date.UTC(year, month - 1, 1))
    return date.toISOString().slice(0, 10)
  }
  const last = (year: number, month: number) => {
    const date = new Date(Date.UTC(year, month, 0))
    return date.toISOString().slice(0, 10)
  }
  switch (preset) {
    case 'thisMonth':
      return { from: first(y, m), to: today }
    case 'lastMonth':
      return { from: first(y, m - 1), to: last(y, m - 1) }
    case 'last3':
      return { from: first(y, m - 2), to: today }
    case 'thisYear':
      return { from: `${y}-01-01`, to: today }
  }
}
