import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { STARTER_COST_CATEGORIES } from './keys'
import {
  addMonths,
  BILLED_NEXT_MONTH_CATEGORIES,
  defaultPeriodMonth,
  firstDayOf,
  firstOpenMonth,
  monthOf,
  periodMonthAllowed,
  periodMonthClosed,
} from './period'

// The month an expense is for (the owner's request of 2026-09-30).

describe('the month an expense is for', () => {
  it("defaults to the month before the bill for a category billed the month after (September's electricity, billed in October)", () => {
    expect(defaultPeriodMonth('2026-10-03', true)).toBe('2026-09')
    expect(defaultPeriodMonth('2026-01-15', true)).toBe('2025-12')
    expect(defaultPeriodMonth('2026-10-03', false)).toBe('2026-10')
  })

  it('names the utilities of the starter list as billed the month after', () => {
    expect(BILLED_NEXT_MONTH_CATEGORIES).toEqual(['electricity', 'water', 'internet', 'phone'])
    for (const key of BILLED_NEXT_MONTH_CATEGORIES) expect(STARTER_COST_CATEGORIES).toContain(key)
  })

  it('may be up to 12 months before the bill and 1 month after it', () => {
    expect(periodMonthAllowed('2025-10', '2026-10-31')).toBe(true)
    expect(periodMonthAllowed('2025-09', '2026-10-31')).toBe(false)
    expect(periodMonthAllowed('2026-11', '2026-10-01')).toBe(true)
    expect(periodMonthAllowed('2026-12', '2026-10-01')).toBe(false)
    expect(periodMonthAllowed('2027-01', '2026-12-31')).toBe(true)
    // No date has a year 0 (D-200): the month before January of year 1 is not a month.
    expect(periodMonthAllowed('0000-12', '0001-01-15')).toBe(false)
    for (const bad of ['2026-13', '2026-00', '2026-1', '26-01', '2026-01-01', '', '0000-01'])
      expect(periodMonthAllowed(bad, '2026-01-10'), bad).toBe(false)
  })

  it('moves months across years, both ways', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(addMonths('2025-12', 1)).toBe('2026-01')
    expect(addMonths('2026-10', -12)).toBe('2025-10')
    expect(addMonths('2026-10', 15)).toBe('2028-01')
    expect(monthOf('2026-09-30')).toBe('2026-09')
    expect(firstDayOf('2026-09')).toBe('2026-09-01')
  })

  it('addMonths(n) then addMonths(-n) is the same month, and the default is always allowed', () => {
    const month = fc
      .record({
        year: fc.integer({ min: 2000, max: 2100 }),
        index: fc.integer({ min: 1, max: 12 }),
      })
      .map(({ year, index }) => `${year}-${String(index).padStart(2, '0')}`)
    fc.assert(
      fc.property(month, fc.integer({ min: -60, max: 60 }), (m, n) => {
        expect(addMonths(addMonths(m, n), -n)).toBe(m)
        expect(addMonths(m, n) > m).toBe(n > 0)
      }),
    )
    fc.assert(
      fc.property(month, fc.integer({ min: 1, max: 28 }), fc.boolean(), (m, day, billed) => {
        const date = `${m}-${String(day).padStart(2, '0')}`
        expect(periodMonthAllowed(defaultPeriodMonth(date, billed), date)).toBe(true)
      }),
    )
  })
})

describe('closed months (D-114 rule 6, D-200)', () => {
  it('a month is closed once the books are closed through its last day', () => {
    expect(firstOpenMonth(null)).toBeNull()
    expect(firstOpenMonth('2026-08-31')).toBe('2026-09')
    expect(firstOpenMonth('2026-08-15')).toBe('2026-08')
    expect(firstOpenMonth('2026-12-31')).toBe('2027-01')
    expect(firstOpenMonth('2028-02-29')).toBe('2028-03')
    expect(periodMonthClosed('2026-08', '2026-08-31')).toBe(true)
    expect(periodMonthClosed('2026-07', '2026-08-31')).toBe(true)
    // Closed only in part: its open days still take bills.
    expect(periodMonthClosed('2026-08', '2026-08-30')).toBe(false)
    expect(periodMonthClosed('2026-09', '2026-08-31')).toBe(false)
    expect(periodMonthClosed('2026-01', null)).toBe(false)
  })

  it('the default month is never closed while an open month fits the bill', () => {
    // Last month's electricity, billed today, after the month-end close: this month.
    expect(defaultPeriodMonth('2026-09-30', true, '2026-08-31')).toBe('2026-09')
    // Not closed yet: the month before.
    expect(defaultPeriodMonth('2026-09-30', true, '2026-07-31')).toBe('2026-08')
    expect(defaultPeriodMonth('2026-09-30', true, '2026-08-30')).toBe('2026-08')
    expect(defaultPeriodMonth('2026-09-30', false, '2026-08-31')).toBe('2026-09')
    // A bill dated in the closed period keeps the plain default (it is not finalized anyway).
    expect(defaultPeriodMonth('2026-03-10', false, '2026-12-31')).toBe('2026-03')
  })

  it('a default that moves is still allowed, and open', () => {
    const day = fc
      .record({
        year: fc.integer({ min: 2000, max: 2100 }),
        month: fc.integer({ min: 1, max: 12 }),
        day: fc.integer({ min: 1, max: 28 }),
      })
      .map(
        ({ year, month, day }) =>
          `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      )
    fc.assert(
      fc.property(day, day, fc.boolean(), (date, closed, billed) => {
        const month = defaultPeriodMonth(date, billed, closed)
        expect(periodMonthAllowed(month, date)).toBe(true)
        // Whenever the bill's own day is open, so is its default month.
        if (date > closed) expect(periodMonthClosed(month, closed)).toBe(false)
      }),
    )
  })
})
