import { describe, expect, it } from 'vitest'
import {
  isFiltered,
  listInput,
  readPurchaseFilters,
  writePurchaseFilters,
} from './purchase-filters'

// The purchases list's filters in the address: read back as the API takes them, and anything the
// API would refuse left out.

const SUPPLIER = '0190A4F2-7B5C-7C3E-9B1A-2F3C4D5E6F70'

describe('purchase filters', () => {
  it('reads the address', () => {
    const filters = readPurchaseFilters(
      new URLSearchParams(
        `status=posted&supplier=${SUPPLIER}&from=2026-09-01&to=2026-09-30&q= INV `,
      ),
    )
    expect(filters).toEqual({
      status: 'posted',
      supplierId: SUPPLIER.toLowerCase(),
      from: '2026-09-01',
      to: '2026-09-30',
      search: 'INV',
    })
    expect(isFiltered(filters)).toBe(true)
    expect(listInput(filters)).toEqual({
      status: 'posted',
      supplierId: SUPPLIER.toLowerCase(),
      from: '2026-09-01',
      to: '2026-09-30',
      search: 'INV',
    })
  })

  it('leaves out what the API would refuse', () => {
    const filters = readPurchaseFilters(
      new URLSearchParams('status=deleted&supplier=nope&from=2026-13-01&to=yesterday'),
    )
    expect(filters).toEqual({ status: 'all', supplierId: null, from: null, to: null, search: '' })
    expect(isFiltered(filters)).toBe(false)
    expect(listInput(filters)).toEqual({
      status: 'all',
      supplierId: undefined,
      from: undefined,
      to: undefined,
      search: undefined,
    })
  })

  it('writes only what differs from the defaults, keeping the rest', () => {
    const params = new URLSearchParams('q=milk&status=draft')
    expect(writePurchaseFilters(params, { status: 'all' })).toBe('q=milk')
    expect(writePurchaseFilters(params, { from: '2026-09-01' })).toBe(
      'q=milk&status=draft&from=2026-09-01',
    )
    expect(writePurchaseFilters(params, { search: '  ', status: 'all' })).toBe('')
  })
})
