import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { computeSale } from '../../documents/sale'
import { toDec } from '../../numbers/decimal'
import { SALE_LINE_QTY_MAX } from '../keys'
import {
  autoMap,
  findHeaderRow,
  headerFingerprintSource,
  headerKey,
  isTotalRow,
  mappingError,
  type ImportCell,
  type ImportMapping,
} from './headers'
import { importDayLines } from './lines'
import { aliasKeyOfCode, looksNotSold, matchIndexOf, matchName, suggestionsFor } from './match'
import { readImportRows, vatQuestionAsked, type ImportReadOptions } from './read'
import { dateOrderOf, importDate, importNumber, serialDate } from './values'

// The readers of M3 Step 4 over a corpus of real-looking, anonymized files (the plan's Tests): a
// Loyverse-like summary with no date column, a Foodics/Square-like line file with refunds, a
// Shopify-like file with order fields only on the first row, a noon-like file with a fee column,
// Arabic headers with Arabic-Indic digits, Excel serial days, "Total" rows and modifiers kept as text.

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

describe('headers', () => {
  it('folds a header the way people read it', () => {
    expect(headerKey('Net Sales (AED)')).toBe('net sales')
    expect(headerKey('  Qty. ')).toBe('qty')
    expect(headerKey('Item_Name')).toBe('item name')
    expect(headerKey('الكمية')).toBe('الكميه')
    expect(headerKey('صافي المبيعات (د.إ)')).toBe('صافي المبيعات')
    expect(headerKey('Total AED')).toBe('total')
  })

  it('finds the header row below title lines and maps English and Arabic names', () => {
    const rows: ImportCell[][] = [
      ['Item sales summary'],
      ['Branch: Marina', null],
      [],
      ['Item', 'SKU', 'Items sold', 'Gross sales', 'Net sales', 'Customer name'],
      ['Latte', 'LAT-1', 3, 54, 54, 'Someone'],
    ]
    expect(findHeaderRow(rows)).toBe(3)
    expect(autoMap(rows[3]!)).toEqual({ name: 0, code: 1, qty: 2, net: 4 })
    const arabic: ImportCell[] = ['الصنف', 'الكمية', 'الإجمالي', 'الضريبة', 'التاريخ']
    expect(autoMap(arabic)).toEqual({ name: 0, qty: 1, total: 2, tax: 3, date: 4 })
  })

  it('maps a Shopify-like export: the line item, never the order "Name" or the customer', () => {
    const headers: ImportCell[] = [
      'Name',
      'Email',
      'Created at',
      'Lineitem quantity',
      'Lineitem name',
      'Lineitem price',
      'Lineitem sku',
      'Billing Name',
      'Billing Phone',
    ]
    const mapping = autoMap(headers)
    expect(mapping.name).toBe(4)
    expect(mapping.qty).toBe(3)
    expect(mapping.price).toBe(5)
    expect(mapping.code).toBe(6)
    expect(mapping.date).toBe(2)
    expect(Object.values(mapping)).not.toContain(7)
    expect(Object.values(mapping)).not.toContain(8)
  })

  it('needs a name and exactly one amount, each column once', () => {
    expect(mappingError({ qty: 1 })).toBe('name_missing')
    expect(mappingError({ name: 0 })).toBe('amount_missing')
    expect(mappingError({ name: 0, net: 1, total: 2 })).toBe('amounts_twice')
    expect(mappingError({ name: 0, net: 0 })).toBe('column_twice')
    expect(mappingError({ name: 0, total: 1 })).toBeNull()
  })

  it('fingerprints a layout by its folded headers, not their spelling', () => {
    expect(headerFingerprintSource(['Item', 'Qty.', 'Net Sales'])).toBe(
      headerFingerprintSource([' item ', 'QTY', 'net sales (AED)']),
    )
    expect(headerFingerprintSource(['Item', 'Qty'])).not.toBe(
      headerFingerprintSource(['Qty', 'Item']),
    )
  })

  it('skips total rows but not an item that only starts with the word', () => {
    const mapping: ImportMapping = { name: 0, total: 1 }
    expect(isTotalRow(['Total', 300], mapping)).toBe(true)
    expect(isTotalRow(['المجموع', 300], mapping)).toBe(true)
    expect(isTotalRow(['Grand Total (AED)', 300], mapping)).toBe(true)
    expect(isTotalRow(['Total 08/10/2026', 300], mapping)).toBe(true)
    expect(isTotalRow(['Total Care Kit', 30], mapping)).toBe(false)
  })
})

describe('values', () => {
  it.each([
    ['AED 2,268.00', '2268'],
    ['د.إ ٢٬٢٦٨٫٠٠', '2268'],
    ['٢٬٢٦٨٫٠٠ د.إ', '2268'],
    ['(12.00)', '-12'],
    ['12.50-', '-12.5'],
    ['Dhs 1,234.5', '1234.5'],
    ['−3', '-3'],
    ['  ', null],
  ])('reads %s', (text, value) => {
    expect(importNumber(text)).toEqual({ ok: true, value })
  })

  it('refuses what is not a number, never guessing a decimal comma', () => {
    expect(importNumber('1,5')).toEqual({ ok: false, error: 'invalid' })
    expect(importNumber('N/A')).toEqual({ ok: false, error: 'invalid' })
  })

  it('reads spreadsheet numbers as a spreadsheet shows them', () => {
    expect(importNumber(0.1 + 0.2)).toEqual({ ok: true, value: '0.3' })
    expect(importNumber(18.9)).toEqual({ ok: true, value: '18.9' })
    expect(importNumber(2268)).toEqual({ ok: true, value: '2268' })
  })

  it('reads days: dd/mm by default, ISO, names, serials, with the time dropped', () => {
    expect(importDate('08/10/2026', 'dmy')).toEqual({
      ok: true,
      date: '2026-10-08',
      ambiguous: true,
    })
    expect(importDate('08/10/2026', 'mdy')).toEqual({
      ok: true,
      date: '2026-08-10',
      ambiguous: true,
    })
    expect(importDate('25/10/2026', 'mdy')).toEqual({
      ok: true,
      date: '2026-10-25',
      ambiguous: false,
    })
    expect(importDate('2026-10-08T14:32:00Z', 'dmy')).toEqual({
      ok: true,
      date: '2026-10-08',
      ambiguous: false,
    })
    expect(importDate('08/10/2026 2:32 PM', 'dmy')).toMatchObject({ ok: true, date: '2026-10-08' })
    expect(importDate('8 Oct 2026', 'dmy')).toMatchObject({ ok: true, date: '2026-10-08' })
    expect(importDate('Oct 8, 2026', 'dmy')).toMatchObject({ ok: true, date: '2026-10-08' })
    expect(importDate('٠٨/١٠/٢٠٢٦', 'dmy')).toMatchObject({ ok: true, date: '2026-10-08' })
    expect(importDate('8 أكتوبر 2026', 'dmy')).toMatchObject({ ok: true, date: '2026-10-08' })
    expect(importDate(46303, 'dmy')).toEqual({ ok: true, date: '2026-10-08', ambiguous: false })
    expect(importDate(46303.6, 'dmy')).toMatchObject({ date: '2026-10-08' })
    expect(importDate('31/02/2026', 'dmy')).toEqual({ ok: false, error: 'invalid' })
    expect(importDate('', 'dmy')).toEqual({ ok: false, error: 'missing' })
  })

  it('counts serial days as spreadsheets do, 29 Feb 1900 included', () => {
    expect(serialDate(1)).toBe('1900-01-01')
    expect(serialDate(59)).toBe('1900-02-28')
    expect(serialDate(61)).toBe('1900-03-01')
    expect(serialDate(45658)).toBe('2025-01-01')
  })

  it('says which order a file writes its days in, or that it cannot tell', () => {
    expect(dateOrderOf(['03/04/2026', '25/04/2026'])).toEqual({ order: 'dmy', ambiguous: false })
    expect(dateOrderOf(['04/03/2026', '04/25/2026'])).toEqual({ order: 'mdy', ambiguous: false })
    expect(dateOrderOf(['03/04/2026', '05/04/2026'])).toEqual({ order: 'dmy', ambiguous: true })
    expect(dateOrderOf(['2026-04-03', 46303])).toEqual({ order: 'dmy', ambiguous: false })
  })
})

describe('readImportRows: the corpus', () => {
  it('a Loyverse-like summary with no date column, Arabic headers and Arabic-Indic digits', () => {
    const rows: ImportCell[][] = [
      ['ملخص المبيعات حسب الصنف'],
      ['الصنف', 'الكمية', 'الإجمالي'],
      ['لاتيه إسباني', '١٢٠', '٢٬٢٦٨٫٠٠'],
      ['كرواسون', '٢٥', '٢٣٦٫٢٥'],
      ['المجموع', '١٤٥', '٢٬٥٠٤٫٢٥'],
    ]
    const result = read(rows, {
      vatRegistered: true,
      amountsIncludeVat: true,
      period: { from: '2026-10-08', to: '2026-10-08' },
    })
    expect(result.problem).toBeNull()
    expect(result.shape).toBe('summary')
    expect(result.amountsIncludeVat).toBe(true)
    expect(result.totalRows).toBe(1)
    expect(result.items).toEqual([
      {
        day: '2026-10-08',
        name: 'لاتيه إسباني',
        code: null,
        qty: '120',
        amount: '2268.00',
        refunds: '0.00',
        rows: 1,
      },
      {
        day: '2026-10-08',
        name: 'كرواسون',
        code: null,
        qty: '25',
        amount: '236.25',
        refunds: '0.00',
        rows: 1,
      },
    ])
  })

  it('asks "Do these amounts include VAT?" only of a VAT-registered business without a tax column', () => {
    expect(vatQuestionAsked({ name: 0, total: 1 }, true)).toBe(true)
    expect(vatQuestionAsked({ name: 0, total: 1 }, false)).toBe(false)
    expect(vatQuestionAsked({ name: 0, total: 1, tax: 2 }, true)).toBe(false)
    expect(vatQuestionAsked({ name: 0, net: 1 }, true)).toBe(false)
    const rows: ImportCell[][] = [
      ['Item', 'Total'],
      ['Latte', '18.90'],
    ]
    const unanswered = read(rows, {
      vatRegistered: true,
      period: { from: '2026-10-08', to: '2026-10-08' },
    })
    expect(unanswered.problem).toBe('vat_answer_missing')
  })

  it('a Foodics/Square-like line file with refunds, modifiers kept as text and a total row', () => {
    const rows: ImportCell[][] = [
      ['Date', 'Receipt', 'Item', 'Modifiers', 'Qty', 'Net sales', 'Tax', 'Customer phone'],
      ['08/10/2026', 'R-1', 'Latte', 'Oat milk, extra shot', '2', '36.00', '1.80', '0501234567'],
      ['08/10/2026', 'R-2', 'Latte', '', '1', '18.00', '0.90', ''],
      ['08/10/2026', 'R-3', 'Latte', '', '-1', '-18.00', '-0.90', ''],
      ['09/10/2026', 'R-4', 'Croissant', '', '3', '27.00', '1.35', ''],
      ['', '', 'Total', '', '5', '63.00', '3.15', ''],
    ]
    const result = read(rows)
    expect(result.problem).toBeNull()
    expect(result.shape).toBe('lines')
    expect(result.period).toEqual({ from: '2026-10-08', to: '2026-10-09' })
    expect(result.items).toEqual([
      {
        day: '2026-10-08',
        name: 'Latte',
        code: null,
        qty: '2',
        amount: '36.00',
        refunds: '18.00',
        rows: 3,
      },
      {
        day: '2026-10-09',
        name: 'Croissant',
        code: null,
        qty: '3',
        amount: '27.00',
        refunds: '0.00',
        rows: 1,
      },
    ])
    // Only the mapped columns are read: the phone and the modifiers go nowhere.
    expect(JSON.stringify(result)).not.toContain('0501234567')
    expect(JSON.stringify(result)).not.toContain('Oat milk')
  })

  it('a Shopify-like file: the order day only on its first row is copied down', () => {
    const rows: ImportCell[][] = [
      [
        'Name',
        'Created at',
        'Lineitem quantity',
        'Lineitem name',
        'Lineitem price',
        'Billing Name',
      ],
      ['#1001', '2026-10-03 10:12:00 +0400', '1', 'Desk lamp', '120.00', 'A customer'],
      ['#1001', '', '2', 'Bulb', '15.00', ''],
      ['#1002', '2026-10-04 09:00:00 +0400', '1', 'Bulb', '15.00', 'Another'],
    ]
    const result = read(rows)
    expect(result.problem).toBeNull()
    expect(result.items.map((i) => [i.day, i.name, i.qty, i.amount])).toEqual([
      ['2026-10-03', 'Desk lamp', '1', '120.00'],
      ['2026-10-03', 'Bulb', '2', '30.00'],
      ['2026-10-04', 'Bulb', '1', '15.00'],
    ])
  })

  it('a noon-like file with a fee column: the fees are summed for the statement', () => {
    const rows: ImportCell[][] = [
      ['Order date', 'SKU', 'Product title', 'Quantity', 'Total', 'Commission'],
      ['01/10/2026', 'PLA-1', 'Phone stand', '2', '90.00', '13.50'],
      ['02/10/2026', 'PLA-1', 'Phone stand', '1', '45.00', '6.75'],
      ['02/10/2026', 'PLA-2', 'Cable clip', '4', '40.00', '6.00'],
    ]
    const result = read(rows)
    expect(result.problem).toBeNull()
    expect(result.fees).toBe('26.25')
    expect(result.items.map((i) => [i.day, i.code, i.amount])).toEqual([
      ['2026-10-01', 'PLA-1', '90.00'],
      ['2026-10-02', 'PLA-1', '45.00'],
      ['2026-10-02', 'PLA-2', '40.00'],
    ])
  })

  it('Excel serial days and numbers, a total row at the end', () => {
    const rows: ImportCell[][] = [
      ['Date', 'Item', 'Qty', 'Net sales'],
      [46303, 'Latte', 40, 720],
      [46303, 'Croissant', 25, 225],
      [null, 'Total', 65, 945],
    ]
    const result = read(rows)
    expect(result.problem).toBeNull()
    expect(result.totalRows).toBe(1)
    expect(result.items.map((i) => [i.day, i.name, i.qty, i.amount])).toEqual([
      ['2026-10-08', 'Latte', '40', '720.00'],
      ['2026-10-08', 'Croissant', '25', '225.00'],
    ])
  })

  it('a total less its tax column is before VAT, and a price is × qty', () => {
    const withTax = read(
      [
        ['Date', 'Item', 'Qty', 'Total', 'VAT'],
        ['08/10/2026', 'Latte', '2', '37.80', '1.80'],
      ],
      {
        vatRegistered: true,
      },
    )
    expect(withTax.amountsIncludeVat).toBe(false)
    expect(withTax.items[0]?.amount).toBe('36.00')
    const byPrice = read([
      ['Date', 'Item', 'Qty', 'Unit price'],
      ['08/10/2026', 'Latte', '3', '18.00'],
    ])
    expect(byPrice.items[0]?.amount).toBe('54.00')
  })

  it('reports each row it leaves out with its row and column', () => {
    const rows: ImportCell[][] = [
      ['Date', 'Item', 'Qty', 'Net sales'],
      ['08/10/2026', 'Latte', '2', 'N/A'],
      ['32/10/2026', 'Latte', '2', '36'],
      ['08/10/2026', '', '2', '36'],
      ['08/10/2026', 'Latte', '2', '36'],
    ]
    const result = read(rows)
    expect(result.rowsRead).toBe(1)
    expect(result.rowsLeftOut).toBe(3)
    expect(result.errors).toEqual([
      { row: 2, column: 3, code: 'number_invalid' },
      { row: 3, column: 0, code: 'date_invalid' },
      { row: 4, column: 1, code: 'name_missing' },
    ])
  })

  it('a file covers one month at most', () => {
    const rows: ImportCell[][] = [
      ['Date', 'Item', 'Net sales'],
      ['30/09/2026', 'Latte', '18'],
      ['01/10/2026', 'Latte', '18'],
    ]
    expect(read(rows).problem).toBe('period_over_month')
  })

  it('a summary needs its days', () => {
    expect(
      read([
        ['Item', 'Net sales'],
        ['Latte', '18'],
      ]).problem,
    ).toBe('period_missing')
  })
})

describe('matchName', () => {
  const products = [
    { id: 'p1', name: 'Spanish Latte' },
    { id: 'p2', name: 'Croissant' },
    { id: 'p3', name: 'لاتيه إسباني' },
  ]

  it('matches by the saved answer, the code, then the name as people read it', () => {
    const index = matchIndexOf(
      [
        { kind: 'name', key: 'spanish latte l', target: 'product', productId: 'p1' },
        { kind: 'code', key: 'cro-1', target: 'product', productId: 'p2' },
        { kind: 'name', key: 'tips', target: 'skip', productId: null },
      ],
      products,
    )
    expect(matchName({ name: 'Spanish Latte L', code: null }, index)).toEqual({
      state: 'matched',
      via: 'alias',
      target: 'product',
      productId: 'p1',
    })
    expect(matchName({ name: 'Butter croissant', code: 'CRO-1' }, index)).toMatchObject({
      via: 'code',
      productId: 'p2',
    })
    expect(matchName({ name: 'لاتيه اسباني', code: null }, index)).toMatchObject({
      via: 'name',
      productId: 'p3',
    })
    expect(matchName({ name: 'TIPS', code: null }, index)).toMatchObject({ target: 'skip' })
  })

  it('never puts a second item code of a name on the product another code was answered with (D-262)', () => {
    // File 1 sold "Juice" only as J-250, added as new: a product named "Juice" and the code's answer.
    const juice = [...products, { id: 'p250', name: 'Juice' }]
    const answered = matchIndexOf(
      [{ kind: 'code', key: aliasKeyOfCode('J-250'), target: 'product', productId: 'p250' }],
      juice,
    )
    expect(matchName({ name: 'Juice', code: 'J-250' }, answered)).toMatchObject({
      via: 'code',
      productId: 'p250',
    })
    // File 2 sells "Juice" as J-500: another size, never matched by the name alone.
    expect(matchName({ name: 'Juice', code: 'J-500' }, answered)).toEqual({
      state: 'unmatched',
      suggestions: [{ id: 'p250', name: 'Juice' }],
    })
    expect(matchName({ name: 'Juice', code: 'J-500' }, answered, { suggest: false })).toEqual({
      state: 'unmatched',
      suggestions: [],
    })
    // Nor by an answer saved for the name (a file without codes answered "Juice" with it).
    const both = matchIndexOf(
      [
        { kind: 'name', key: 'juice', target: 'product', productId: 'p250' },
        { kind: 'code', key: aliasKeyOfCode('J-250'), target: 'product', productId: 'p250' },
      ],
      juice,
    )
    expect(matchName({ name: 'Juice', code: 'J-500' }, both)).toMatchObject({ state: 'unmatched' })
    // A file without codes still reads the name; so does a code when no code is answered with it.
    expect(matchName({ name: 'Juice', code: null }, both)).toMatchObject({
      via: 'alias',
      productId: 'p250',
    })
    expect(matchName({ name: 'Juice', code: 'J-500' }, matchIndexOf([], juice))).toMatchObject({
      via: 'name',
      productId: 'p250',
    })
    // A code answered as not sold names no product: the name still matches.
    const skipped = matchIndexOf(
      [{ kind: 'code', key: aliasKeyOfCode('TIP-1'), target: 'skip', productId: null }],
      juice,
    )
    expect(matchName({ name: 'Juice', code: 'J-500' }, skipped)).toMatchObject({
      via: 'name',
      productId: 'p250',
    })
  })

  it('offers "Did you mean …?" for a name not found', () => {
    const index = matchIndexOf([], products)
    expect(matchName({ name: 'Spanish Latte L', code: null }, index)).toEqual({
      state: 'unmatched',
      suggestions: [{ id: 'p1', name: 'Spanish Latte' }],
    })
    expect(matchName({ name: 'Spanish Latte · Large', code: null }, index)).toMatchObject({
      suggestions: [{ id: 'p1' }],
    })
    expect(matchName({ name: 'Brownie', code: null }, index)).toEqual({
      state: 'unmatched',
      suggestions: [],
    })
  })
})

describe('importDayLines', () => {
  it('one line per product, a charge and delivery charged; tips skipped', () => {
    const lines = importDayLines(
      [
        { target: 'product', productId: 'p1', qty: '120', amount: '2160.00' },
        { target: 'product', productId: 'p2', qty: '3', amount: '10.00' },
        { target: 'skip', productId: null, qty: '1', amount: '25.00' },
        { target: 'charge', productId: null, qty: '1', amount: '30.00' },
        { target: 'delivery', productId: null, qty: '2', amount: '14.00' },
      ],
      2,
    )
    expect(lines.returned).toEqual([])
    expect(lines.sold).toEqual([
      {
        kind: 'item',
        productId: 'p1',
        qty: '120',
        unitPrice: '18',
        discountAmount: null,
        amount: '2160.00',
      },
      {
        kind: 'item',
        productId: 'p2',
        qty: '3',
        unitPrice: '3.3334',
        discountAmount: null,
        amount: '10.00',
      },
      {
        kind: 'charge',
        productId: null,
        qty: '1',
        unitPrice: '30',
        discountAmount: null,
        amount: '30.00',
      },
      {
        kind: 'delivery',
        productId: null,
        qty: '1',
        unitPrice: '14',
        discountAmount: null,
        amount: '14.00',
      },
    ])
  })

  it('more refunded than sold goes on the refund', () => {
    const lines = importDayLines(
      [
        { target: 'product', productId: 'p1', qty: '1', amount: '18.00' },
        { target: 'product', productId: 'p1', qty: '-2', amount: '-36.00' },
        { target: 'product', productId: 'p2', qty: '2', amount: '18.00' },
      ],
      2,
    )
    expect(lines.sold.map((l) => [l.productId, l.qty])).toEqual([['p2', '2']])
    expect(lines.returned).toEqual([
      {
        kind: 'item',
        productId: 'p1',
        qty: '-1',
        unitPrice: '18',
        discountAmount: null,
        amount: '18.00',
      },
    ])
  })

  it('keeps every amount exactly, through computeSale', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.boolean(),
        (units, fils, inclusive) => {
          const amount = (fils / 100).toString()
          const [line] = importDayLines(
            [{ target: 'product', productId: 'p', qty: String(units), amount }],
            2,
          ).sold
          if (!line) return fils === 0
          const sale = computeSale(
            {
              vatRegistered: true,
              lines: [
                {
                  kind: 'item',
                  qty: line.qty as never,
                  unitPrice: line.unitPrice as never,
                  priceIncludesVat: inclusive,
                  vatCategory: 'standard',
                  discount: line.discountAmount ? { amount: line.discountAmount as never } : null,
                },
              ],
            },
            'AED',
          )
          const gross = inclusive ? sale.total : sale.net
          return toDec(gross).equals(toDec(amount))
        },
      ),
    )
  })
})

describe('the review fixes (D-260)', () => {
  it('a time with its offset from UTC is the business day in its time zone', () => {
    expect(importDate('2026-09-30T21:30:00Z', 'dmy', 'Asia/Dubai')).toMatchObject({
      ok: true,
      date: '2026-10-01',
    })
    expect(importDate('30/09/2026 11:30 PM +00:00', 'dmy', 'Asia/Dubai')).toMatchObject({
      date: '2026-10-01',
    })
    expect(importDate('2026-10-03 10:12:00 +0400', 'dmy', 'Asia/Dubai')).toMatchObject({
      date: '2026-10-03',
    })
    // Without an offset, or without the business's zone, the day is as written.
    expect(importDate('30/09/2026 23:30', 'dmy', 'Asia/Dubai')).toMatchObject({
      date: '2026-09-30',
    })
    expect(importDate('2026-09-30T21:30:00Z', 'dmy')).toMatchObject({ date: '2026-09-30' })
    const lines = read(
      [
        ['Created at', 'Item', 'Net sales'],
        ['2026-09-30T21:30:00Z', 'Latte', '18'],
      ],
      { timeZone: 'Asia/Dubai' },
    )
    expect(lines.items.map((i) => i.day)).toEqual(['2026-10-01'])
  })

  it('never reads a day before 2000 (a column of day numbers is not January 1900)', () => {
    expect(importDate(1, 'dmy')).toEqual({ ok: false, error: 'invalid' })
    expect(importDate('01/01/1999', 'dmy')).toEqual({ ok: false, error: 'invalid' })
    expect(importDate(36526, 'dmy')).toMatchObject({ ok: true, date: '2000-01-01' })
    const days = read([
      ['Day', 'Item', 'Qty', 'Net sales'],
      [1, 'Latte', 40, 720],
    ])
    expect(days.problem).toBe('no_rows')
    expect(days.errors).toEqual([{ row: 2, column: 0, code: 'date_invalid' }])
  })

  it("skips a line file's total row with no day of its own, keeps an item that starts with the word", () => {
    const mapping: ImportMapping = { date: 0, name: 1, net: 2 }
    expect(isTotalRow(['', 'Total for 08/10/2026', 720], mapping)).toBe(true)
    expect(isTotalRow(['', 'إجمالي اليوم', 720], mapping)).toBe(true)
    expect(isTotalRow(['', 'الإجمالي العام', 720], mapping)).toBe(true)
    expect(isTotalRow(['08/10/2026', 'Total Care Kit', 30], mapping)).toBe(false)
    expect(isTotalRow(['', 'Total Care Kit', 30], { name: 1, net: 2 })).toBe(false)
  })

  it('an empty fee column makes no statement; fees as deductions are what the app kept', () => {
    const rows = (fees: ImportCell[]): ImportCell[][] => [
      ['Order date', 'Product title', 'Total', 'Commission'],
      ['01/10/2026', 'Phone stand', '90.00', fees[0]!],
      ['02/10/2026', 'Phone stand', '45.00', fees[1]!],
    ]
    expect(read(rows([null, ''])).fees).toBeNull()
    expect(read(rows(['-13.50', '-6.75'])).fees).toBe('20.25')
    // A commission given back on a refund line counts against what was kept.
    expect(read(rows(['-13.50', '6.75'])).fees).toBe('6.75')
  })

  it('a refund with a negative quantity beside an amount left unsigned takes both back', () => {
    const result = read([
      ['Date', 'Item', 'Qty', 'Net sales'],
      ['08/10/2026', 'Latte', '3', '54.00'],
      ['08/10/2026', 'Latte', '-1', '18.00'],
    ])
    expect(result.items).toEqual([
      expect.objectContaining({ qty: '2', amount: '36.00', refunds: '18.00' }),
    ])
  })

  it('an amount column left blank on an order’s later rows is the order’s, not the line’s', () => {
    const headers: ImportCell[] = ['Order', 'Date', 'Item', 'Qty', 'Net sales', 'Amount', 'VAT']
    const rows: ImportCell[][] = [
      ['A-1', '08/10/2026', 'Latte', '1', '30.00', '18.00', '1.50'],
      ['A-1', '', 'Croissant', '1', '', '12.00', ''],
    ]
    // The order's "Net sales" (and its VAT) are left out: "Amount" is the line's.
    expect(autoMap(headers, rows)).toEqual({ order: 0, date: 1, name: 2, qty: 3, total: 5 })
    // Without the rows, the column before VAT is the first choice, as before.
    expect(autoMap(headers)).toMatchObject({ net: 4, tax: 6 })
  })

  it('an item code’s answer comes first; "Did you mean" only when asked', () => {
    const index = matchIndexOf(
      [
        { kind: 'name', key: 'milk', target: 'product', productId: 'milk-2l' },
        { kind: 'code', key: '111', target: 'product', productId: 'milk-1l' },
      ],
      [{ id: 'p1', name: 'Spanish Latte' }],
    )
    expect(matchName({ name: 'Milk', code: '111' }, index)).toMatchObject({
      via: 'code',
      productId: 'milk-1l',
    })
    expect(matchName({ name: 'Milk', code: '333' }, index)).toMatchObject({
      via: 'alias',
      productId: 'milk-2l',
    })
    expect(matchName({ name: 'Spanish Latte L', code: null }, index, { suggest: false })).toEqual({
      state: 'unmatched',
      suggestions: [],
    })
    expect(suggestionsFor('Spanish Latte L', index)).toEqual([{ id: 'p1', name: 'Spanish Latte' }])
  })

  it('knows the names that are not sold, so "Add all as new" never makes them products', () => {
    expect(looksNotSold('Tips')).toBe('skip')
    expect(looksNotSold('بقشيش')).toBe('skip')
    expect(looksNotSold('Tip (cash)')).toBe('skip')
    expect(looksNotSold('Service charge 10%')).toBe('charge')
    expect(looksNotSold('رسوم خدمة')).toBe('charge')
    expect(looksNotSold('Delivery fee')).toBe('delivery')
    expect(looksNotSold('رسوم التوصيل')).toBe('delivery')
    expect(looksNotSold('Tiramisu')).toBeNull()
    expect(looksNotSold('Spanish Latte')).toBeNull()
  })
})
