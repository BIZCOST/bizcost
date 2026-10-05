import { describe, expect, it } from 'vitest'
import {
  deviceToday,
  groupChoices,
  periodDays,
  periodEnd,
  profitInput,
  readProfitParams,
  showChoices,
  sortChoices,
  sortValue,
  writeProfitParams,
} from './profit-params'

const OWNER = { profitShown: true, branches: true }
const SALES_ONLY = { profitShown: false, branches: false }
const read = (query: string, access = OWNER) => readProfitParams(new URLSearchParams(query), access)

describe('Real profit in the address', () => {
  it('starts on this month, by product, the best sellers first, every group', () => {
    expect(read('')).toEqual({
      period: 'this_month',
      from: '',
      to: '',
      by: 'product',
      sort: 'sales',
      order: 'desc',
      show: 'all',
    })
  })

  it('reads a period, a grouping, an order and a choice', () => {
    expect(
      read('period=custom&from=2026-09-01&to=2026-09-30&by=day&sort=profit_asc&show=loss'),
    ).toEqual({
      period: 'custom',
      from: '2026-09-01',
      to: '2026-09-30',
      by: 'day',
      sort: 'profit',
      order: 'asc',
      show: 'loss',
    })
  })

  it('never offers profit or margin to a member who sees only sales: the link falls back', () => {
    const params = read('by=month&sort=margin_percent_desc&show=low_margin', SALES_ONLY)
    expect(params).toMatchObject({ by: 'month', sort: 'key', order: 'asc', show: 'all' })
    expect(sortChoices('product', SALES_ONLY).map(sortValue)).toEqual([
      'sales_desc',
      'sales_asc',
      'key_asc',
    ])
    expect(showChoices(SALES_ONLY)).toEqual(['all'])
    expect(showChoices(OWNER)).toEqual(['all', 'loss', 'low_margin', 'incomplete'])
  })

  it('groups by branch only with branches', () => {
    expect(read('by=branch', SALES_ONLY).by).toBe('product')
    expect(read('by=branch').by).toBe('branch')
    expect(groupChoices(SALES_ONLY)).toEqual(['month', 'week', 'product', 'channel', 'day'])
    expect(groupChoices(OWNER)).toEqual(['month', 'week', 'product', 'channel', 'branch', 'day'])
  })

  it('drops the days of a period that is not chosen, and a new grouping starts in its own order', () => {
    const base = new URLSearchParams('period=custom&from=2026-09-01&to=2026-09-30&sort=sales_asc')
    expect(writeProfitParams(base, { period: 'last_month' })).toBe(
      'period=last_month&sort=sales_asc',
    )
    expect(writeProfitParams(new URLSearchParams('sort=sales_asc'), { by: 'day' })).toBe('by=day')
    expect(writeProfitParams(new URLSearchParams('by=day'), { sort: 'key', order: 'asc' })).toBe(
      'by=day',
    )
    expect(writeProfitParams(new URLSearchParams('by=day'), { sort: 'key', order: 'desc' })).toBe(
      'by=day&sort=key_desc',
    )
    expect(writeProfitParams(new URLSearchParams('show=loss'), { show: 'all' })).toBe('')
  })
})

describe('the days of a period', () => {
  const today = '2026-10-05'

  it('as of the business’s today', () => {
    expect(periodDays({ period: 'this_month', from: '', to: '' }, today)).toEqual({
      from: '2026-10-01',
      to: today,
    })
    expect(periodDays({ period: 'last_month', from: '', to: '' }, today)).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    })
    expect(periodDays({ period: 'last_3_months', from: '', to: '' }, today)).toEqual({
      from: '2026-08-01',
      to: today,
    })
    expect(periodDays({ period: 'last_12_months', from: '', to: '' }, today)).toEqual({
      from: '2025-11-01',
      to: today,
    })
    expect(periodDays({ period: 'this_year', from: '', to: '' }, today)).toEqual({
      from: '2026-01-01',
      to: today,
    })
    // February of a leap year.
    expect(periodDays({ period: 'last_month', from: '', to: '' }, '2028-03-10')).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    })
  })

  it('chosen days: in order, not after today, at most 12 months (as the API refuses)', () => {
    const custom = (from: string, to: string) => periodDays({ period: 'custom', from, to }, today)
    expect(custom('2026-09-10', '2026-09-01')).toEqual({ problem: 'order' })
    expect(custom('2026-10-06', '2026-10-09')).toEqual({ problem: 'future' })
    expect(custom('2025-10-05', '2026-10-05')).toEqual({ problem: 'tooLong' })
    expect(custom('2025-10-06', '2026-10-05')).toEqual({ from: '2025-10-06', to: '2026-10-05' })
    expect(custom('', '2026-10-05')).toBeNull()
    expect(periodEnd('2026-01-31')).toBe('2027-01-31')
    expect(periodEnd('2027-02-28')).toBe('2028-02-28')
  })

  it('asks for the report only once its days are known and valid', () => {
    expect(profitInput(read(''), null)).toBeNull()
    expect(profitInput(read('period=custom&from=2026-09-10&to=2026-09-01'), today)).toBeNull()
    expect(profitInput(read('by=week&show=incomplete'), today)).toEqual({
      from: '2026-10-01',
      to: today,
      groupBy: 'week',
      sort: 'key',
      order: 'asc',
      show: 'incomplete',
    })
  })

  it('today as this device reads it', () => {
    expect(deviceToday(new Date(2026, 9, 5, 23, 59))).toBe('2026-10-05')
  })
})
