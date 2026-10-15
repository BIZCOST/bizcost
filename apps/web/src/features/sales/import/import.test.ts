import { autoMap, headerFingerprintSource } from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import {
  decodeText,
  detectDelimiter,
  FileReadError,
  IMPORT_UNZIPPED_MAX_BYTES,
  kindOf,
  parseDelimited,
  readImportFile,
  sha256Hex,
  unzippedSize,
} from './read-file'
import { TEMPLATE_HEADERS, templateCsv, templateFileName, TEMPLATES } from './templates'
import {
  amountOf,
  chunksOf,
  columnLetter,
  daysCovered,
  mappingDto,
  namesToAddAll,
  periodError,
  profileMapping,
  readWith,
  rowsToSend,
  startOf,
  stepsFor,
  withAmount,
  withField,
} from './wizard'

// Reading a sales file in the browser and the wizard's choices (M3 Step 4): encodings (UTF-8 with or
// without its mark, UTF-16, Windows-1256), the delimiter, quoted cells, the templates' headers read in
// both languages, the steps a file needs and what is sent.

const utf8 = (text: string) => new TextEncoder().encode(text)

/** Windows-1256 bytes of «لاتيه» and digits (ل E1, ا C7, ت CA, ي ED, ه E5). */
const LATTE_1256 = [0xe1, 0xc7, 0xca, 0xed, 0xe5]

describe('decodeText', () => {
  it('reads UTF-8 with and without its byte-order mark the same', () => {
    const text = 'الصنف,الكمية\nلاتيه,120\n'
    expect(decodeText(utf8(text))).toEqual({ text, encoding: 'utf-8' })
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(text)]))).toEqual({
      text,
      encoding: 'utf-8',
    })
  })

  it('reads UTF-16 with its mark, and without it by its zero bytes', () => {
    const text = 'Item,Qty\nLatte,2\n'
    const le = new Uint8Array(text.length * 2)
    for (let i = 0; i < text.length; i++) le[i * 2] = text.charCodeAt(i)
    expect(decodeText(new Uint8Array([0xff, 0xfe, ...le]))).toEqual({ text, encoding: 'utf-16le' })
    expect(decodeText(le)).toEqual({ text, encoding: 'utf-16le' })
  })

  it('reads a Windows-1256 file the same as UTF-8', () => {
    const bytes = new Uint8Array([...LATTE_1256, 0x2c, 0x31, 0x32, 0x30, 0x0a])
    expect(decodeText(bytes)).toEqual({ text: 'لاتيه,120\n', encoding: 'windows-1256' })
    expect(parseDelimited(decodeText(bytes).text, ',')).toEqual(parseDelimited('لاتيه,120\n', ','))
  })
})

describe('detectDelimiter and parseDelimited', () => {
  it('finds the delimiter the lines use alike, past a title line', () => {
    expect(detectDelimiter('Sales report, October\nItem;Qty;Total\nLatte;2;36,00\n')).toBe(';')
    expect(detectDelimiter('Item\tQty\nLatte\t2\n')).toBe('\t')
    expect(detectDelimiter('Item,Qty\nLatte,2\n')).toBe(',')
    expect(detectDelimiter('one cell\n')).toBe(',')
  })

  it('keeps quoted delimiters, doubled quotes and line breaks in a cell', () => {
    expect(
      parseDelimited('Item,Note\r\n"Latte, large","say ""hi""\nthen go"\r\n,\r\n', ','),
    ).toEqual([
      ['Item', 'Note'],
      ['Latte, large', 'say "hi"\nthen go'],
      [null, null],
    ])
  })

  it('knows a spreadsheet by its first bytes, a text file by its name', () => {
    expect(kindOf('x.xlsx', new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe('xlsx')
    expect(kindOf('x.xls', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toBe('xls')
    expect(kindOf('sales.CSV', utf8('a,b'))).toBe('csv')
    expect(kindOf('photo.png', new Uint8Array([0x89, 0x50]))).toBeNull()
    expect(kindOf('fake.xlsx', utf8('a,b'))).toBeNull()
  })

  it('hashes the file the same every time (the same file twice is refused)', async () => {
    const a = await sha256Hex(utf8('Item,Qty\n'))
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(await sha256Hex(utf8('Item,Qty\n'))).toBe(a)
    expect(await sha256Hex(utf8('Item,Qty \n'))).not.toBe(a)
  })
})

describe('templates', () => {
  it('start with a byte-order mark and their headers in the language asked', () => {
    expect(templateCsv('daily', 'en')).toBe('\ufeffDate,Item,Item code,Quantity,Sales\r\n')
    expect(templateCsv('lines', 'ar').startsWith('\ufeffالتاريخ,رقم الطلب,الصنف')).toBe(true)
    expect(templateFileName('statement', 'ar')).toBe('bizcost-channel-statement-ar.csv')
  })

  it.each(['daily', 'lines'] as const)(
    'a %s template is mapped the same from its English and Arabic headers',
    (kind) => {
      const en = autoMap(TEMPLATE_HEADERS[kind].en)
      expect(autoMap(TEMPLATE_HEADERS[kind].ar)).toEqual(en)
      expect(Object.keys(en).length).toBe(TEMPLATE_HEADERS[kind].en.length)
    },
  )

  it('has every template in both languages with as many headers', () => {
    for (const kind of TEMPLATES) {
      expect(TEMPLATE_HEADERS[kind].ar).toHaveLength(TEMPLATE_HEADERS[kind].en.length)
    }
  })
})

describe('the wizard', () => {
  const rows = [
    ['Item sales'],
    ['Item', 'Qty', 'Total'],
    ['Latte', '2', '37.80'],
    ['Total', '2', '37.80'],
  ]

  it('starts from the header row and the columns found from their names', () => {
    expect(startOf(rows)).toEqual({
      headerRow: 1,
      mapping: { name: 0, qty: 1, total: 2 },
      dateOrder: 'dmy',
      ambiguousDays: false,
    })
  })

  it('asks for the days only of a summary, and about VAT only when the file cannot say', () => {
    expect(stepsFor({ name: 0, total: 2 }, true)).toEqual(['file', 'columns', 'period', 'vat'])
    expect(stepsFor({ name: 0, total: 2, date: 3 }, false)).toEqual(['file', 'columns'])
    expect(stepsFor({ name: 0, net: 2 }, true)).toEqual(['file', 'columns', 'period'])
    expect(stepsFor({ name: 0, total: 2, tax: 1, date: 4 }, true)).toEqual(['file', 'columns'])
  })

  it('keeps one amount column and gives each column one field', () => {
    const mapping = withAmount({ name: 0, total: 2 }, 2, 'net')
    expect(mapping).toEqual({ name: 0, net: 2 })
    expect(amountOf(mapping)).toEqual({ kind: 'net', column: 2 })
    expect(withField(mapping, 'qty', 2)).toEqual({ name: 0, qty: 2 })
    expect(withField(mapping, 'code', null)).toEqual({ name: 0, net: 2 })
  })

  it('names columns as spreadsheets do', () => {
    expect([0, 1, 25, 26, 27, 701, 702].map(columnLetter)).toEqual([
      'A',
      'B',
      'Z',
      'AA',
      'AB',
      'ZZ',
      'AAA',
    ])
  })

  it('uses a saved layout only when its columns fit the file', () => {
    const profile = {
      mapping: {
        headerRow: 1,
        columns: { name: 0, qty: 1, total: 2 },
        headers: {},
        dateOrder: 'mdy' as const,
      },
    }
    expect(profileMapping(profile, rows)).toEqual({
      headerRow: 1,
      mapping: { name: 0, qty: 1, total: 2 },
      dateOrder: 'mdy',
    })
    expect(
      profileMapping({ mapping: { ...profile.mapping, columns: { name: 7, total: 2 } } }, rows),
    ).toBeNull()
  })

  it('sends the file read into day × item rows, numbered from 0, in chunks', () => {
    const read = readWith(rows, {
      headerRow: 1,
      mapping: { name: 0, qty: 1, total: 2 },
      dateOrder: 'dmy',
      vatRegistered: true,
      amountsIncludeVat: true,
      period: { from: '2026-10-08', to: '2026-10-08' },
    })
    expect(read.problem).toBeNull()
    expect(rowsToSend(read)).toEqual([
      {
        position: 0,
        businessDate: '2026-10-08',
        name: 'Latte',
        code: null,
        qty: '2',
        amount: '37.80',
        refunds: '0.00',
        fileRows: 1,
      },
    ])
    expect(mappingDto(rows, 1, { name: 0, qty: 1, total: 2 }, 'dmy')).toEqual({
      headerRow: 1,
      columns: { name: 0, qty: 1, total: 2 },
      headers: { name: 'Item', qty: 'Qty', total: 'Total' },
      dateOrder: 'dmy',
    })
    expect(chunksOf([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(headerFingerprintSource(rows[1]!)).toBe('item\u001fqty\u001ftotal')
  })

  it('checks a summary days: in order, one month, never after today', () => {
    expect(periodError('2026-10-01', '2026-10-08', '2026-10-08')).toBeNull()
    expect(periodError('2026-10-09', '2026-10-08', '2026-10-09')).toBe('order')
    expect(periodError('2026-09-30', '2026-10-01', '2026-10-09')).toBe('month')
    expect(periodError('2026-10-01', '2026-10-10', '2026-10-09')).toBe('future')
    expect(periodError('', '2026-10-01', '2026-10-09')).toBe('missing')
  })

  it('says a file named .xlsx that is not one is unreadable, never "choose an Excel file" (D-261)', async () => {
    const codeOf = (name: string, text: string) =>
      readImportFile(new File([utf8(text)], name)).then(
        () => null,
        (error: unknown) => (error instanceof FileReadError ? error.code : 'other'),
      )
    expect(await codeOf('broken.xlsx', 'this is not a workbook')).toBe('unreadable')
    expect(await codeOf('notes.pdf', '%PDF-1.7')).toBe('not_supported')
    // An ".xls" that is plain text (tab-separated, as some back offices save it) is read as text.
    const tsv = await readImportFile(
      new File([utf8('Date\tItem\tQty\n08/10/2026\tLatte\t2\n')], 'export.xls'),
    )
    expect([tsv.kind, tsv.delimiter, tsv.rows[1]]).toEqual([
      'csv',
      '\t',
      ['08/10/2026', 'Latte', '2'],
    ])
  })

  it('refuses a .xlsx whose parts claim to unzip past the bound, before unzipping it (D-261)', async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Item', 'Qty', 'Total'],
      ['Latte', 1, 18],
    ])
    const book = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(book, sheet, 'Sales')
    const bytes = new Uint8Array(
      XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer,
    )
    expect(unzippedSize(bytes)).toBeGreaterThan(0)
    expect(unzippedSize(bytes)).toBeLessThan(IMPORT_UNZIPPED_MAX_BYTES)
    expect((await readImportFile(new File([bytes], 'ok.xlsx'))).rows[1]).toEqual(['Latte', 1, 18])
    // The same workbook whose first part claims 2 GB once unzipped (as a zip bomb's would).
    const bomb = bytes.slice()
    const view = new DataView(bomb.buffer)
    const first = bomb.findIndex(
      (_, i) => i + 4 <= bomb.length && view.getUint32(i, true) === 0x02014b50,
    )
    view.setUint32(first + 24, 0x7fffffff, true)
    expect(unzippedSize(bomb)).toBeGreaterThan(IMPORT_UNZIPPED_MAX_BYTES)
    await expect(readImportFile(new File([bomb], 'bomb.xlsx'))).rejects.toMatchObject({
      code: 'too_large',
    })
    expect(unzippedSize(utf8('not a zip at all'))).toBe(Infinity)
  })

  it('counts the days a summary covers, never one day for 1–30 Sep (D-261)', () => {
    expect(daysCovered([{ businessDate: '2026-09-30', periodFrom: '2026-09-01' }])).toBe(30)
    expect(
      daysCovered([
        { businessDate: '2026-10-01', periodFrom: null },
        { businessDate: '2026-10-02', periodFrom: null },
        { businessDate: '2026-10-02', periodFrom: null },
      ]),
    ).toBe(2)
    expect(daysCovered([])).toBe(0)
  })

  it('reads a time written in UTC as the business’s day (D-261)', () => {
    const rows = [
      ['Created at', 'Item', 'Net sales'],
      ['2026-09-30T21:30:00Z', 'Latte', '18'],
      ['2026-10-01T08:00:00+04:00', 'Latte', '18'],
    ]
    const choice = {
      headerRow: 0,
      mapping: { date: 0, name: 1, total: 2 },
      dateOrder: 'dmy' as const,
      vatRegistered: false,
      amountsIncludeVat: null,
      period: null,
    }
    expect(readWith(rows, { ...choice, timeZone: 'Asia/Dubai' }).items.map((i) => i.day)).toEqual([
      '2026-10-01',
    ])
    // Without the zone (it could not be read), the day is as written.
    expect(readWith(rows.slice(0, 2), choice).items.map((i) => i.day)).toEqual(['2026-09-30'])
  })

  it('"Add as new products" leaves out names that look like a product, a tip or a charge (D-261)', () => {
    const unmatched = (name: string, suggestions: { id: string; name: string }[] | null) => ({
      name,
      match: { state: 'unmatched' as const, suggestions },
    })
    const { add, left } = namesToAddAll([
      unmatched('Pistachio cake', []),
      unmatched('Spanish Latte L', [{ id: 'p1', name: 'Spanish Latte' }]),
      unmatched('بقشيش', []),
      unmatched('Service charge 10%', []),
      unmatched('Shipping', []),
      unmatched('Mango juice', null),
      { name: 'Croissant', match: { state: 'matched' as const } },
    ])
    expect(add.map((n) => n.name)).toEqual(['Pistachio cake'])
    expect(left.map((n) => n.name)).toEqual([
      'Spanish Latte L',
      'بقشيش',
      'Service charge 10%',
      'Shipping',
      'Mango juice',
    ])
  })
})
