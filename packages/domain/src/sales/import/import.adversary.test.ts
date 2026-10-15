import { describe, expect, it } from 'vitest'
import { SALE_LINE_QTY_MAX } from '../keys'
import { autoMap, findHeaderRow, type ImportCell } from './headers'
import { matchIndexOf, matchName } from './match'
import { readImportRows, type ImportReadOptions } from './read'

// Import correctness, adversarial (M3 Step 4): files the step's own corpus does not hold. Each test
// states what must hold; a failing one is a defect of the reader, not of the test.

const read = (rows: ImportCell[][], options: Partial<ImportReadOptions> = {}) => {
  const headerRow = findHeaderRow(rows)!
  const mapping = options.mapping ?? autoMap(rows[headerRow]!)
  return readImportRows(rows, {
    headerRow,
    dateOrder: 'dmy',
    vatRegistered: false,
    amountsIncludeVat: null,
    period: null,
    minorUnit: 2,
    qtyMax: SALE_LINE_QTY_MAX,
    ...options,
    mapping,
  })
}

describe('a Shopify orders export as Shopify writes it', () => {
  // Order-level columns (Subtotal, Shipping, Taxes, Total) are filled on an order's first row only;
  // the line-item columns are filled on every row.
  const rows: ImportCell[][] = [
    [
      'Name',
      'Email',
      'Financial Status',
      'Paid at',
      'Currency',
      'Subtotal',
      'Shipping',
      'Taxes',
      'Total',
      'Created at',
      'Lineitem quantity',
      'Lineitem name',
      'Lineitem price',
      'Lineitem sku',
      'Billing Name',
    ],
    [
      '#1001',
      'a@example.com',
      'paid',
      '2026-10-03 10:12:00 +0400',
      'AED',
      '150.00',
      '0.00',
      '0.00',
      '150.00',
      '2026-10-03 10:12:00 +0400',
      '1',
      'Desk lamp',
      '120.00',
      'LMP',
      'A customer',
    ],
    ['#1001', '', '', '', '', '', '', '', '', '', '2', 'Bulb', '15.00', 'BLB', ''],
  ]

  it('gives each line item its own amount, never the order subtotal on its first line', () => {
    const result = read(rows)
    expect(result.problem).toBeNull()
    expect(result.items.map((i) => [i.name, i.qty, i.amount])).toEqual([
      ['Desk lamp', '1', '120.00'],
      ['Bulb', '2', '30.00'],
    ])
  })
})

describe('refund lines', () => {
  it('a refund line written with a positive quantity and a negative amount takes the quantity back', () => {
    const result = read([
      ['Date', 'Item', 'Qty', 'Net sales'],
      ['08/10/2026', 'Latte', '2', '24.00'],
      ['08/10/2026', 'Latte', '1', '-12.00'],
    ])
    // 2 sold, 1 refunded: 1 latte for 12.00 (its frozen cost is that of 1, not 3).
    expect(result.items).toEqual([
      expect.objectContaining({ qty: '1', amount: '12.00', refunds: '12.00' }),
    ])
  })

  it('a price × qty refund line with both negative is a refund, not a sale', () => {
    const result = read([
      ['Date', 'Item', 'Qty', 'Price'],
      ['08/10/2026', 'Latte', '2', '12.00'],
      ['08/10/2026', 'Latte', '-1', '-12.00'],
    ])
    expect(result.items).toEqual([
      expect.objectContaining({ qty: '1', amount: '12.00', refunds: '12.00' }),
    ])
  })
})

describe('the fee column', () => {
  it('an empty fee column makes no statement (a 0.00 one would replace the channel % with nothing)', () => {
    const result = read([
      ['Order date', 'SKU', 'Product title', 'Quantity', 'Total', 'Commission'],
      ['01/10/2026', 'PLA-1', 'Phone stand', '2', '90.00', null],
      ['02/10/2026', 'PLA-1', 'Phone stand', '1', '45.00', ''],
    ])
    expect(result.problem).toBeNull()
    expect(result.fees).toBeNull()
  })

  it('fees written as deductions ("-13.50") are what the app kept, as the statement file reads them', () => {
    const result = read([
      ['Order date', 'SKU', 'Product title', 'Quantity', 'Total', 'Commission'],
      ['01/10/2026', 'PLA-1', 'Phone stand', '2', '90.00', '-13.50'],
      ['02/10/2026', 'PLA-1', 'Phone stand', '1', '45.00', '-6.75'],
    ])
    expect(result.fees).toBe('20.25')
  })
})

describe('total rows', () => {
  it('skips «إجمالي المبيعات» as it skips "Total sales"', () => {
    const english = read([
      ['Date', 'Item', 'Qty', 'Net sales'],
      ['08/10/2026', 'Latte', '40', '720.00'],
      ['', 'Total sales', '40', '720.00'],
    ])
    expect(english.totalRows).toBe(1)
    const arabic = read([
      ['التاريخ', 'الصنف', 'الكمية', 'صافي المبيعات'],
      ['08/10/2026', 'لاتيه', '40', '720.00'],
      // Its empty day is copied down from the row above, so without the skip it is an item of the
      // day worth the whole file: "Add all as new" would count the day twice.
      ['', 'إجمالي المبيعات', '40', '720.00'],
    ])
    expect(arabic.totalRows).toBe(1)
    expect(arabic.items.map((i) => i.name)).toEqual(['لاتيه'])
  })

  it('skips a daily total row ("Total for 08/10/2026", «إجمالي اليوم»)', () => {
    const result = read([
      ['Date', 'Item', 'Qty', 'Net sales'],
      ['08/10/2026', 'Latte', '40', '720.00'],
      ['', 'Total for 08/10/2026', '40', '720.00'],
      ['09/10/2026', 'Latte', '10', '180.00'],
      ['', 'إجمالي اليوم', '10', '180.00'],
    ])
    expect(result.totalRows).toBe(2)
    expect(result.items.map((i) => [i.day, i.name, i.amount])).toEqual([
      ['2026-10-08', 'Latte', '720.00'],
      ['2026-10-09', 'Latte', '180.00'],
    ])
  })
})

describe('days', () => {
  it('a "Day" column of day numbers is never read as days of January 1900', () => {
    const result = read([
      ['Day', 'Item', 'Qty', 'Net sales'],
      [1, 'Latte', 40, 720],
      [2, 'Latte', 30, 540],
    ])
    for (const item of result.items) expect(item.day >= '2000-01-01').toBe(true)
  })
})

describe('matchName', () => {
  it("an item code's own answer wins over the answer saved for its name", () => {
    // Retail: "Milk" is sold in two sizes, told apart by their codes. The answers were saved for
    // both codes (and, as saleImport.match does, for the shared name: the last answer given).
    const index = matchIndexOf(
      [
        { kind: 'name', key: 'milk', target: 'product', productId: 'milk-2l' },
        { kind: 'code', key: '111', target: 'product', productId: 'milk-1l' },
        { kind: 'code', key: '222', target: 'product', productId: 'milk-2l' },
      ],
      [],
    )
    expect(matchName({ name: 'Milk', code: '111' }, index)).toMatchObject({
      state: 'matched',
      productId: 'milk-1l',
    })
  })
})
