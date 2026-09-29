import type { ProductDto } from '@bizcost/contracts'
import { describe, expect, it } from 'vitest'
import { checkProduct, productDraft, readOwnerMinutes } from './product-draft'

// The product form's checks, and the fields a business doesn't use: kept as stored, never cleared.

const BRANCH_A = '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f71'
const BRANCH_B = '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f72'
const SOLO = { multiLocation: false, canPickLocations: false }
const BRANCHES = { multiLocation: true, canPickLocations: true }

describe('checkProduct', () => {
  it('sends a new product with its price typed in Arabic digits', () => {
    const { errors, fields } = checkProduct(
      { ...productDraft(), name: ' Spanish Latte ', price: '١٨٫٥', description: '  ' },
      SOLO,
    )
    expect(errors).toEqual({})
    expect(fields).toEqual({
      name: 'Spanish Latte',
      type: 'product',
      unit: 'piece',
      description: null,
      defaultPrice: '18.5',
      vatCategory: 'standard',
      priceIncludesVat: false,
      locationIds: [],
    })
  })

  it('takes no price as none, and refuses a price below zero or a missing name', () => {
    expect(checkProduct({ ...productDraft(), name: 'Tea' }, SOLO).fields?.defaultPrice).toBeNull()
    const { errors, fields } = checkProduct({ ...productDraft(), price: '-1' }, SOLO)
    expect(fields).toBeNull()
    expect(errors).toEqual({
      name: { key: 'catalog.form.nameRequired' },
      price: { key: 'catalog.numbers.notNegative' },
    })
  })

  it('sends the branches chosen, or none for every branch; asks for one when "some"', () => {
    const draft = { ...productDraft(), name: 'Cake' }
    expect(checkProduct(draft, BRANCHES).fields?.locationIds).toEqual([])
    expect(
      checkProduct({ ...draft, where: 'some', locationIds: [BRANCH_B] }, BRANCHES).fields
        ?.locationIds,
    ).toEqual([BRANCH_B])
    expect(checkProduct({ ...draft, where: 'some', locationIds: [] }, BRANCHES).errors).toEqual({
      locations: { key: 'catalog.products.locations.pickOne' },
    })
  })

  it('keeps the stored branches when the member cannot see them, and sends none without branches', () => {
    const stored: ProductDto = {
      id: '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f73',
      name: 'Cake',
      description: 'Chocolate',
      type: 'product',
      unit: 'piece',
      defaultPrice: '40',
      vatCategory: 'zero_rated',
      priceIncludesVat: true,
      locationIds: [BRANCH_A],
      resaleMaterialId: null,
      archivedAt: null,
      version: 2,
    }
    const draft = productDraft(stored)
    expect(draft).toMatchObject({ where: 'some', price: '40', description: 'Chocolate' })
    const viewer = { multiLocation: true, canPickLocations: false }
    expect(checkProduct(draft, viewer, stored.locationIds).fields?.locationIds).toEqual([BRANCH_A])
    expect(checkProduct(draft, SOLO, stored.locationIds).fields?.locationIds).toEqual([])
    expect(checkProduct(draft, SOLO).fields).toMatchObject({
      vatCategory: 'zero_rated',
      priceIncludesVat: true,
    })
  })
})

describe('readOwnerMinutes (a business without a team, D-119)', () => {
  it('reads minutes in either language; empty clears them', () => {
    expect(readOwnerMinutes('10')).toEqual({ ok: true, value: '10' })
    expect(readOwnerMinutes('٧٫٥')).toEqual({ ok: true, value: '7.5' })
    expect(readOwnerMinutes('  ')).toEqual({ ok: true, value: null })
  })

  it('refuses nothing, less than nothing and more decimals than the column keeps', () => {
    expect(readOwnerMinutes('0')).toEqual({ ok: false, error: { key: 'catalog.numbers.positive' } })
    expect(readOwnerMinutes('-3')).toMatchObject({ ok: false })
    expect(readOwnerMinutes('1.1234567')).toEqual({
      ok: false,
      error: { key: 'catalog.numbers.tooManyDecimals' },
    })
    expect(readOwnerMinutes('ten')).toEqual({
      ok: false,
      error: { key: 'catalog.numbers.invalid' },
    })
  })
})
