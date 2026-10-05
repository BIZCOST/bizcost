import type { DaySheetDto, SaleDto } from '@bizcost/contracts'
import { describe, expect, it } from 'vitest'
import { checkSheet, sheetDraft, sheetItems, stepQty } from './day-sheet-draft'

// Today's sales as typed (M3 Step 2; Q9): one row a product, − / + or a typed quantity (Arabic-Indic
// digits too), the price filled in, and the running amounts by the domain's sale maths (D-220).

type SheetProduct = DaySheetDto['data']['products'][number]

const LATTE = '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f01'
const CROISSANT = '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f02'
const GONE = '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f03'

function sheetProduct(productId: string, name: string, price: string | null): SheetProduct {
  return {
    productId,
    name,
    type: 'product',
    unit: 'piece',
    price,
    priceIncludesVat: false,
    vatCategory: 'standard',
  }
}

const PRODUCTS = [
  sheetProduct(LATTE, 'Spanish Latte', '18'),
  sheetProduct(CROISSANT, 'Croissant', '9'),
]
const VAT = { currency: 'AED', vatRegistered: true } as const

describe("Today's sales rows", () => {
  it("adds up a café's sheet typed in Arabic-Indic digits: 945.00 before VAT, VAT 47.25, 992.25", () => {
    const items = sheetItems(PRODUCTS, null)
    const draft = sheetDraft(items, PRODUCTS, null)
    expect(draft[LATTE]).toMatchObject({ qty: '', price: '18' })
    const typed = {
      ...draft,
      [LATTE]: { ...draft[LATTE]!, qty: '٤٠', price: '١٨٫٠٠' },
      [CROISSANT]: { ...draft[CROISSANT]!, qty: '٢٥' },
    }
    const check = checkSheet(items, typed, VAT)
    expect(check.valid).toBe(true)
    expect(check.amounts).toMatchObject({ net: '945.00', vat: '47.25', total: '992.25' })
    expect(check.lineAmounts.get(LATTE)?.subtotal).toBe('720.00')
    expect(check.lines).toEqual([
      { kind: 'item', id: draft[LATTE]!.lineId, productId: LATTE, qty: '40', unitPrice: '18' },
      {
        kind: 'item',
        id: draft[CROISSANT]!.lineId,
        productId: CROISSANT,
        qty: '25',
        unitPrice: '9',
      },
    ])
  })

  it('counts nothing for a row left empty or at zero, and no VAT without VAT registration', () => {
    const items = sheetItems(PRODUCTS, null)
    const draft = sheetDraft(items, PRODUCTS, null)
    const check = checkSheet(
      items,
      {
        ...draft,
        [LATTE]: { ...draft[LATTE]!, qty: '0' },
        [CROISSANT]: { ...draft[CROISSANT]!, qty: '3' },
      },
      { currency: 'AED', vatRegistered: false },
    )
    expect(check.lines.map((line) => (line.kind === 'item' ? line.productId : null))).toEqual([
      CROISSANT,
    ])
    expect(check.amounts).toMatchObject({ net: '27.00', vat: '0.00', total: '27.00' })
    expect(checkSheet(items, draft, VAT)).toMatchObject({ lines: [], amounts: null, valid: true })
  })

  it('says what is wrong with a row, and saves nothing until it reads', () => {
    const items = sheetItems(PRODUCTS, null)
    const draft = sheetDraft(items, PRODUCTS, null)
    const check = checkSheet(
      items,
      {
        ...draft,
        [LATTE]: { ...draft[LATTE]!, qty: 'two' },
        [CROISSANT]: { ...draft[CROISSANT]!, qty: '2', price: '' },
      },
      VAT,
    )
    expect(check.valid).toBe(false)
    expect(check.errors[LATTE]?.qty?.key).toBe('catalog.numbers.invalid')
    expect(check.errors[CROISSANT]?.price?.key).toBe('catalog.numbers.required')
    expect(check.lines).toEqual([])
    // More than a sale's line may hold.
    const huge = checkSheet(
      items,
      { ...draft, [LATTE]: { ...draft[LATTE]!, qty: '1000000001' } },
      VAT,
    )
    expect(huge.errors[LATTE]?.qty?.key).toBe('catalog.numbers.tooLarge')
  })

  it('steps a quantity by one, never below zero (zero shows empty)', () => {
    expect(stepQty('', 1)).toBe('1')
    expect(stepQty('٢', 1)).toBe('3')
    expect(stepQty('1.5', 1)).toBe('2.5')
    expect(stepQty('1', -1)).toBe('')
    expect(stepQty('', -1)).toBe('')
    expect(stepQty('abc', 1)).toBe('1')
  })

  it('opens a stored sheet as it was saved, keeping a product no longer listed', () => {
    const sheet = {
      lines: [
        {
          id: '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f11',
          kind: 'item',
          productId: LATTE,
          description: 'Spanish Latte',
          qty: '12',
          unit: 'piece',
          unitPrice: '17.5',
          priceIncludesVat: false,
          vatCategory: 'standard',
        },
        {
          id: '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f12',
          kind: 'item',
          productId: GONE,
          description: 'Old muffin',
          qty: '2',
          unit: 'piece',
          unitPrice: '7',
          priceIncludesVat: false,
          vatCategory: 'standard',
        },
      ],
    } as unknown as SaleDto
    const items = sheetItems(PRODUCTS, sheet)
    expect(items.map((item) => [item.name, item.gone])).toEqual([
      ['Spanish Latte', false],
      ['Croissant', false],
      ['Old muffin', true],
    ])
    const draft = sheetDraft(items, PRODUCTS, sheet)
    expect(draft[LATTE]).toEqual({
      lineId: '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f11',
      qty: '12',
      price: '17.5',
    })
    expect(draft[GONE]).toMatchObject({ qty: '2', price: '7' })
    expect(draft[CROISSANT]).toMatchObject({ qty: '', price: '9' })
  })
})
