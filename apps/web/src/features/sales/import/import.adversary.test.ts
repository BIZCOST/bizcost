import { createImportInput } from '@bizcost/contracts'
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { decodeText, detectDelimiter, parseDelimited, readImportFile } from './read-file'
import { mappingDto, readWith, rowsToSend, startOf } from './wizard'

// Import correctness, adversarial (M3 Step 4): files as exports write them, read the way the wizard
// reads them. Each test states what must hold; a failing one is a defect of the reader.

type Rows = Parameters<typeof startOf>[0]

/** What the wizard makes of a file's rows with its automatic choices. */
function readAuto(rows: Rows, period: { from: string; to: string } | null = null) {
  const start = startOf(rows)
  return {
    start,
    read: readWith(rows, {
      headerRow: start.headerRow,
      mapping: start.mapping,
      dateOrder: start.dateOrder,
      vatRegistered: false,
      amountsIncludeVat: null,
      period,
    }),
  }
}

describe('spreadsheets', () => {
  it('reads the days of a workbook in the 1904 date system (Excel for Mac) as Excel shows them', async () => {
    // 8 Oct 2026 is serial 46303 in the 1900 system and 44841 in the 1904 one.
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Date', 'Item', 'Qty', 'Net sales'],
      [{ t: 'n', v: 44841, z: 'dd/mm/yyyy' } as unknown as string, 'Latte', 2, 36],
    ])
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, sheet, 'Sales')
    book.Workbook = { WBProps: { date1904: true } }
    const bytes = XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    const file = await readImportFile(new File([bytes], 'mac.xlsx'))
    const { read } = readAuto(file.rows)
    expect(read.items.map((i) => i.day)).toEqual(['2026-10-08'])
  })

  it('reads an ".xls" export that is an HTML table (as many back offices save it)', async () => {
    const html =
      '<html><body><table><tr><td>Date</td><td>Item</td><td>Qty</td><td>Net sales</td></tr>' +
      '<tr><td>08/10/2026</td><td>Latte</td><td>2</td><td>36.00</td></tr></table></body></html>'
    const file = await readImportFile(new File([new TextEncoder().encode(html)], 'report.xls'))
    const { read } = readAuto(file.rows)
    expect(read.items.map((i) => [i.day, i.name, i.amount])).toEqual([
      ['2026-10-08', 'Latte', '36.00'],
    ])
  })
})

describe('text files', () => {
  // Reviewed (D-260): a decimal comma is never guessed (D-254: "1,5" may be 1.5 or 15), so such a
  // file is refused, never misread: every row is left out and named with its column, as "not a number".
  it('refuses a semicolon file whose amounts use a decimal comma, naming each row and column', () => {
    const text = 'Date;Item;Qty;Net sales\n08/10/2026;Latte;2;36,00\n08/10/2026;Croissant;3;27,50\n'
    const rows = parseDelimited(text, detectDelimiter(text))
    const { read } = readAuto(rows)
    expect(read.problem).toBe('no_rows')
    expect(read.items).toEqual([])
    expect(read.errors).toEqual([
      { row: 2, column: 3, code: 'number_invalid' },
      { row: 3, column: 3, code: 'number_invalid' },
    ])
  })

  it('reads UTF-16 without its mark when the file is mostly Arabic', () => {
    const text = 'التاريخ,الصنف,الكمية,الإجمالي\n08/10/2026,لاتيه إسباني,2,36\n'
    const bytes = new Uint8Array(text.length * 2)
    for (let i = 0; i < text.length; i++) {
      bytes[i * 2] = text.charCodeAt(i) & 0xff
      bytes[i * 2 + 1] = text.charCodeAt(i) >> 8
    }
    expect(decodeText(bytes)).toEqual({ text, encoding: 'utf-16le' })
  })
})

describe('what is sent', () => {
  it('a marketplace file whose fee column holds deductions ("-13.50") can be sent', () => {
    const rows: Rows = [
      ['Order date', 'SKU', 'Product title', 'Quantity', 'Total', 'Commission'],
      ['01/10/2026', 'PLA-1', 'Phone stand', '2', '90.00', '-13.50'],
      ['02/10/2026', 'PLA-1', 'Phone stand', '1', '45.00', '-6.75'],
    ]
    const { start, read } = readAuto(rows)
    expect(read.problem).toBeNull()
    // As the wizard's send() builds it for a member who sees costs.
    const parsed = createImportInput.safeParse({
      id: '01a10cc0-633f-7420-90fa-833bf8c502f8',
      channelId: '01a10cc0-633f-7420-90fa-833bf8c502f9',
      locationId: null,
      fileName: 'noon.csv',
      fileHash: 'a'.repeat(64),
      fingerprint: 'b'.repeat(64),
      shape: read.shape,
      periodFrom: read.period!.from,
      periodTo: read.period!.to,
      mapping: mappingDto(rows, start.headerRow, start.mapping, start.dateOrder),
      amountsIncludeVat: read.amountsIncludeVat,
      rowsRead: read.rowsRead,
      rowsLeftOut: read.rowsLeftOut,
      errors: read.errors,
      feesTotal: read.fees,
      rowCount: rowsToSend(read).length,
    })
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
  })
})
