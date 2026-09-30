import { describe, expect, it } from 'vitest'
import { isFiltered, listInput, readExpenseFilters, writeExpenseFilters } from './expense-filters'

// The expenses list's filters live in the address (M2 Step 5).

const CATEGORY = '0190A4F2-7B5C-7C3E-9B1A-2F3C4D5E6F70'

describe('the expenses filters', () => {
  it('reads what the API accepts and leaves the rest out', () => {
    const params = new URLSearchParams(
      `status=submitted&category=${CATEGORY}&month=2026-08&from=2026-09-01&to=2026-13-01&q=%20rent%20`,
    )
    expect(readExpenseFilters(params)).toEqual({
      status: 'submitted',
      categoryId: CATEGORY.toLowerCase(),
      month: '2026-08',
      from: '2026-09-01',
      to: null,
      search: 'rent',
    })
    expect(
      readExpenseFilters(new URLSearchParams('status=paid&category=nope&month=2026-13')),
    ).toEqual({
      status: 'all',
      categoryId: null,
      month: null,
      from: null,
      to: null,
      search: '',
    })
  })

  it('writes only what differs from the defaults', () => {
    const params = new URLSearchParams('status=draft&q=old')
    expect(writeExpenseFilters(params, { status: 'all', search: ' new ' })).toBe('q=new')
    expect(writeExpenseFilters(new URLSearchParams(), { status: 'submitted' })).toBe(
      'status=submitted',
    )
  })

  it('says when the list is narrowed, and gives expense.list its input', () => {
    const none = readExpenseFilters(new URLSearchParams())
    expect(isFiltered(none)).toBe(false)
    expect(listInput(none)).toEqual({
      status: 'all',
      categoryId: undefined,
      periodMonth: undefined,
      from: undefined,
      to: undefined,
      search: undefined,
    })
    const waiting = { ...none, status: 'submitted' as const }
    expect(isFiltered(waiting)).toBe(true)
    expect(listInput(waiting)).toMatchObject({ status: 'submitted' })
    // The month the bills are for (D-194).
    const august = { ...none, month: '2026-08' }
    expect(isFiltered(august)).toBe(true)
    expect(listInput(august)).toMatchObject({ periodMonth: '2026-08' })
    expect(writeExpenseFilters(new URLSearchParams(), { month: '2026-08' })).toBe('month=2026-08')
  })
})
