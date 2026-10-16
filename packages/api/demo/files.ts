import { createHash } from 'node:crypto'
import {
  autoMap,
  dateOrderOf,
  findHeaderRow,
  headerFingerprintSource,
  readImportRows,
  SALE_LINE_QTY_MAX,
  type DateOrder,
  type ImportCell,
  type ImportMapping,
  type ImportRead,
} from '@bizcost/domain'
import type { DemoFileLayout, DemoImport, DemoProduct } from './costing-data'
import { addDays, daysFrom, lastMonthOf, monthStart } from './days'

// The sales files of the demo businesses (M3 Step 4), made the way the POS or app exports them and
// read the way the import screen reads them in the browser (the domain's findHeaderRow, autoMap,
// dateOrderOf and readImportRows): so `pnpm demo:seed` sends exactly what a person importing that
// file sends, and the data test can check every file reads cleanly. Amounts are worked out in fils
// (whole numbers), never in floating point.

const HEADERS: Readonly<Record<DemoFileLayout, readonly string[]>> = {
  pos: ['Business Date', 'Item', 'Qty', 'Net Sales', 'VAT', 'Total'],
  delivery_app: ['تاريخ الطلب', 'الصنف', 'الكمية', 'المبلغ'],
  marketplace: ['Order Date', 'SKU', 'Product Title', 'Quantity', 'Sales', 'Commission'],
  pos_codes: ['Date', 'Barcode', 'Description', 'Qty', 'Amount'],
}

/** The name a POS gives the tips it took (the import answers it "not something I sell"). */
export const TIPS_NAME = 'Tips'

/** Fils of a positive decimal string with at most 2 decimals. */
export function filsOf(amount: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount)
  if (!match) throw new Error(`demo data: "${amount}" is not an amount`)
  return BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'))
}

/** A decimal string of `fils`. */
export function amountOfFils(fils: bigint): string {
  const sign = fils < 0n ? '-' : ''
  const abs = fils < 0n ? -fils : fils
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`
}

/** `fils` × `percent` ÷ 100, to the fil (half up); `percent` a decimal string. */
export function percentOf(fils: bigint, percent: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(percent)
  if (!match) throw new Error(`demo data: "${percent}" is not a percentage`)
  const scaled = BigInt(match[1]!) * 10_000n + BigInt((match[2] ?? '').padEnd(4, '0'))
  return (fils * scaled + 500_000n) / 1_000_000n
}

/** An amount with 5 % VAT in it, before its VAT (to the fil, half up). */
export function beforeVatFils(withVat: bigint): bigint {
  return (withVat * 200n + 105n) / 210n
}

/**
 * How many of item `index` were sold on `day`: about `perDay`, more at the weekend (Saturday and
 * Sunday in the UAE) and a little more on Friday, varying from day to day; 0 on some days of an item
 * sold less than once a day.
 */
export function soldOn(day: string, index: number, perDay: number): number {
  const date = new Date(`${day}T00:00:00Z`)
  const weekday = date.getUTCDay()
  const week = weekday === 0 || weekday === 6 ? 1.25 : weekday === 5 ? 1.1 : 0.95
  const wobble = 1 + (((date.getUTCDate() * 7 + index * 5) % 9) - 4) / 25
  return Math.round(perDay * week * wobble)
}

/** The days a file covers: last month's every day, or this month's up to the day before `today`. */
export function importDays(imp: Pick<DemoImport, 'month'>, today: string): string[] {
  if (imp.month === 'last') {
    const { from, to } = lastMonthOf(today)
    return daysFrom(from, to)
  }
  const first = monthStart(today, 0)
  const yesterday = addDays(today, -1)
  return yesterday < first ? [] : daysFrom(first, yesterday)
}

/** A day as a file writes it: ISO for the POS and the marketplace, dd/mm/yyyy for the others. */
function written(day: string, layout: DemoFileLayout): string {
  if (layout === 'pos' || layout === 'marketplace') return day
  return `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`
}

export interface DemoFileRow {
  readonly day: string
  readonly name: string
  readonly code: string | null
  readonly qty: number
  /** As the file gives it (with VAT when the layout's amounts have it). */
  readonly amount: bigint
}

export interface DemoFile {
  /** As the person picked it. */
  readonly name: string
  /** As a spreadsheet reads it: its header row, then its rows. */
  readonly cells: ImportCell[][]
  /** Its bytes, as a CSV export writes them. */
  readonly text: string
  readonly rows: readonly DemoFileRow[]
}

const csvCell = (cell: ImportCell) => {
  const text = cell === null ? '' : String(cell)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/**
 * The file of `imp` on `today` (null when it covers no day: this month's on a month's 1st). Each day
 * gives a row per item sold that day; the products give the default names and prices.
 */
export function salesFile(
  imp: DemoImport,
  products: ReadonlyMap<string, DemoProduct>,
  today: string,
): DemoFile | null {
  const days = importDays(imp, today)
  if (days.length === 0) return null
  const rows: DemoFileRow[] = []
  const cells: ImportCell[][] = [[...HEADERS[imp.layout]]]
  for (const day of days) {
    imp.items.forEach((item, index) => {
      const product = products.get(item.product)
      if (!product) throw new Error(`demo data: ${imp.key} sells no product "${item.product}"`)
      const qty = soldOn(day, index, item.perDay)
      if (qty <= 0) return
      const name = item.name ?? product.name
      const code = item.code ?? null
      const amount = filsOf(item.price ?? product.price) * BigInt(qty)
      rows.push({ day, name, code, qty, amount })
      cells.push(rowCells(imp, day, name, code, qty, amount))
    })
    // Tips on about one day in two, a little different each day.
    if (imp.tips && Number(day.slice(8, 10)) % 2 === 0) {
      const tips = (filsOf(imp.tips) * BigInt(8 + (Number(day.slice(8, 10)) % 5))) / 10n
      rows.push({ day, name: TIPS_NAME, code: null, qty: 1, amount: tips })
      cells.push([
        written(day, imp.layout),
        TIPS_NAME,
        '1',
        amountOfFils(tips),
        '0.00',
        amountOfFils(tips),
      ])
    }
  }
  const text = `${cells.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`
  return { name: `${imp.file}-${days[0]}-${days.at(-1)}.csv`, cells, text, rows }
}

function rowCells(
  imp: DemoImport,
  day: string,
  name: string,
  code: string | null,
  qty: number,
  amount: bigint,
): ImportCell[] {
  const date = written(day, imp.layout)
  switch (imp.layout) {
    case 'pos': {
      const net = beforeVatFils(amount)
      return [
        date,
        name,
        String(qty),
        amountOfFils(net),
        amountOfFils(amount - net),
        amountOfFils(amount),
      ]
    }
    case 'delivery_app':
      return [date, name, String(qty), amountOfFils(amount)]
    case 'marketplace': {
      const fee = percentOf(amount, imp.feePercent ?? '0')
      return [date, code, name, String(qty), amountOfFils(amount), amountOfFils(fee)]
    }
    case 'pos_codes':
      return [date, code, name, String(qty), amountOfFils(amount)]
  }
}

/** SHA-256 of a text, in hex. */
export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

export interface DemoFileRead {
  readonly headerRow: number
  readonly mapping: ImportMapping
  readonly dateOrder: DateOrder
  readonly read: ImportRead
  /** SHA-256 of the file's bytes and of its headers (the layout it is remembered by). */
  readonly fileHash: string
  readonly fingerprint: string
}

/**
 * The file read as the import screen reads it: the header row found, the columns mapped automatically
 * (without VAT registration a column before VAT is simply the sales), the days' order the file shows
 * (dd/mm when it cannot tell), and "Do these amounts include VAT?" answered Yes when it is asked: the
 * amounts customers paid.
 */
export function readSalesFile(file: DemoFile, vatRegistered: boolean): DemoFileRead {
  const headerRow = findHeaderRow(file.cells) ?? 0
  let mapping = autoMap(
    file.cells[headerRow] ?? [],
    file.cells.slice(headerRow + 1, headerRow + 201),
  )
  if (!vatRegistered && mapping.net !== undefined) {
    const { net, ...rest } = mapping
    mapping = { ...rest, total: net }
  }
  const dates =
    mapping.date === undefined
      ? []
      : file.cells.slice(headerRow + 1).map((r) => r[mapping.date!] ?? null)
  const dateOrder = dateOrderOf(dates).order
  const read = readImportRows(file.cells, {
    mapping,
    headerRow,
    dateOrder,
    vatRegistered,
    amountsIncludeVat: true,
    period: null,
    minorUnit: 2,
    qtyMax: SALE_LINE_QTY_MAX,
  })
  return {
    headerRow,
    mapping,
    dateOrder,
    read,
    fileHash: sha256(file.text),
    fingerprint: sha256(headerFingerprintSource(file.cells[headerRow] ?? [])),
  }
}
