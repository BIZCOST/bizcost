import { describe, expect, it } from 'vitest'
import {
  isFiltered,
  listInput,
  NO_FILTERS,
  readSaleFilters,
  writeSaleFilters,
} from './sale-filters'

// The Sales list's filters in the address (M3 Step 2): what the API would refuse is left out, and the
// search is in what was sold, never an amount (D-209).

const CHANNEL = '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f70'

describe('sales list filters', () => {
  it('reads none from an empty address', () => {
    const filters = readSaleFilters(new URLSearchParams())
    expect(filters).toEqual(NO_FILTERS)
    expect(isFiltered(filters)).toBe(false)
    expect(listInput(filters)).toEqual({
      status: 'all',
      source: undefined,
      channelId: undefined,
      locationId: undefined,
      from: undefined,
      to: undefined,
      search: undefined,
    })
  })

  it('reads what the API takes and leaves out the rest', () => {
    const filters = readSaleFilters(
      new URLSearchParams(
        `status=posted&kind=day_sheet&channel=${CHANNEL.toUpperCase()}&branch=x&from=2026-10-01&to=2026-10-40&q=+latte+`,
      ),
    )
    expect(filters).toEqual({
      status: 'posted',
      source: 'day_sheet',
      channelId: CHANNEL,
      locationId: null,
      from: '2026-10-01',
      to: null,
      search: 'latte',
    })
    expect(isFiltered(filters)).toBe(true)
    expect(readSaleFilters(new URLSearchParams('status=paid&kind=import')).status).toBe('all')
    expect(readSaleFilters(new URLSearchParams('kind=import')).source).toBeNull()
  })

  it('writes the changes, leaving the defaults out', () => {
    const params = new URLSearchParams('status=draft&q=latte')
    expect(writeSaleFilters(params, { status: 'all' })).toBe('q=latte')
    expect(writeSaleFilters(params, { search: '  ' })).toBe('status=draft')
    expect(writeSaleFilters(params, NO_FILTERS)).toBe('')
    expect(writeSaleFilters(new URLSearchParams(), { source: 'single', channelId: CHANNEL })).toBe(
      `kind=single&channel=${CHANNEL}`,
    )
  })
})
