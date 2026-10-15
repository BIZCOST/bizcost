import { nameKey } from '../../catalog/names'
import { Dec, fixed, plain, roundHalfUp, toDec } from '../../numbers/decimal'
import { QUANTITY_SCALE } from '../../numbers/kinds'
import {
  cellText,
  headerKey,
  isTotalRow,
  mappingError,
  shapeOf,
  type ImportCell,
  type ImportMapping,
  type ImportShape,
  type MappingError,
} from './headers'
import { importDate, importNumber, type DateOrder, type ImportDateResult } from './values'

// A sales file read into what is imported (M3 Step 4, `aggregateDaily`; it runs in the browser): its
// rows below the header row, totals and empty rows skipped, summed into day × item totals (a line
// file: one per day and item; a summary: its items over the days the person named, on their last
// day). Order-level fields left blank on an order's later rows (its day) are copied down from its
// first row. The amounts are made one kind: before VAT (a `net` column, or a `total` less its `tax`
// column) or as the customer paid (a `total` or `price` column without tax, which for a
// VAT-registered business includes VAT when the person says so: "Do these amounts include VAT?").
// A refund row takes back its quantity and its amount together, whichever of them the file writes as
// negative. An optional fee column is summed into the channel's statement for the file's days (B9):
// what the app kept, however the file signs it, and no statement when none of its cells holds a value.
// Each row that cannot be read is left out and reported with its row and column. A file covers one
// month at most: the running-cost rate is monthly (D-202, Q9).

/** Why a row is left out. */
export const IMPORT_ROW_ERRORS = [
  'name_missing',
  'date_missing',
  'date_invalid',
  'number_invalid',
  'qty_too_large',
] as const
export type ImportRowErrorCode = (typeof IMPORT_ROW_ERRORS)[number]

export interface ImportRowError {
  /** The file's row (1 for its first). */
  readonly row: number
  /** The column (0 for its first); null for the row as a whole. */
  readonly column: number | null
  readonly code: ImportRowErrorCode
}

/** At most this many row errors are kept (each with its row and column); the rest are counted. */
export const IMPORT_ERRORS_KEPT = 50

/** What makes a whole file unreadable (the person changes the columns, the days or the answer). */
export type ImportProblem =
  MappingError | 'no_rows' | 'period_missing' | 'period_over_month' | 'vat_answer_missing'

/** One item of one day: its name as first read, its code, and what the file's rows of it add up to. */
export interface ImportItem {
  /** YYYY-MM-DD: the row's day, or a summary's last day. */
  readonly day: string
  readonly name: string
  readonly code: string | null
  /** Σ quantity (refunds negative), 6 decimals at most. */
  readonly qty: string
  /** Σ amount, in the file's kind (amountsIncludeVat), to the currency's minor unit; refunds negative. */
  readonly amount: string
  /** What its refund rows took back (Σ of the negative amounts, as a positive amount). */
  readonly refunds: string
  /** How many of the file's rows it adds up. */
  readonly rows: number
}

export interface ImportRead {
  readonly shape: ImportShape
  /** The days the file covers: a line file's first and last, a summary's as named. */
  readonly period: { readonly from: string; readonly to: string } | null
  readonly items: readonly ImportItem[]
  /**
   * What the fee column says the app kept (|Σ|; null without one, or when none of its cells holds a
   * value): the channel's statement for the period.
   */
  readonly fees: string | null
  /** Whether `amount` includes VAT. */
  readonly amountsIncludeVat: boolean
  /** Rows read into the items (or the fees). */
  readonly rowsRead: number
  /** Rows left out for an error. */
  readonly rowsLeftOut: number
  /** "Total" rows skipped. */
  readonly totalRows: number
  readonly errors: readonly ImportRowError[]
  /** The file cannot be imported as it is (null: it can). */
  readonly problem: ImportProblem | null
}

export interface ImportReadOptions {
  readonly mapping: ImportMapping
  /** The header row's index; data starts below it. */
  readonly headerRow: number
  readonly dateOrder: DateOrder
  readonly vatRegistered: boolean
  /** The person's answer to "Do these amounts include VAT?" (null: not asked or not answered). */
  readonly amountsIncludeVat: boolean | null
  /** A summary's days (its sales post on the last one); ignored for a line file. */
  readonly period: { readonly from: string; readonly to: string } | null
  /** The currency's minor unit (2 for AED). */
  readonly minorUnit: number
  /** The most a quantity may be (SALE_LINE_QTY_MAX). */
  readonly qtyMax: string
  /**
   * The business's time zone (IANA): a time written with its offset from UTC is the business's day
   * at that moment. Null (the default): a time after the day is dropped as written.
   */
  readonly timeZone?: string | null
}

/**
 * "Do these amounts include VAT?" is asked only of a VAT-registered business whose file has neither a
 * column before VAT nor a tax column to take off (the plan's step 4).
 */
export function vatQuestionAsked(mapping: ImportMapping, vatRegistered: boolean): boolean {
  return vatRegistered && mapping.net === undefined && mapping.tax === undefined
}

/** Whether the read amounts include VAT, or null while the question is not answered. */
export function amountsIncludeVatOf(
  mapping: ImportMapping,
  vatRegistered: boolean,
  answer: boolean | null,
): boolean | null {
  if (!vatQuestionAsked(mapping, vatRegistered)) return false
  return answer
}

const ZERO = '0'

/** How many distinct texts of numbers and of days a read keeps what it read of (each). */
const TEXTS_KEPT = 50_000

/** -|d| (zero stays zero). */
const negative = (d: ReturnType<typeof toDec>) => (d.isZero() ? d : d.abs().negated())

interface Sum {
  day: string
  name: string
  code: string | null
  qty: ReturnType<typeof toDec>
  amount: ReturnType<typeof toDec>
  refunds: ReturnType<typeof toDec>
  rows: number
}

/** Reads a file's rows (see above). */
export function readImportRows(
  rows: readonly (readonly ImportCell[])[],
  options: ImportReadOptions,
): ImportRead {
  const { mapping } = options
  const shape = shapeOf(mapping)
  const empty = (problem: ImportProblem): ImportRead => ({
    shape,
    period: null,
    items: [],
    fees: null,
    amountsIncludeVat: false,
    rowsRead: 0,
    rowsLeftOut: 0,
    totalRows: 0,
    errors: [],
    problem,
  })
  const mappingProblem = mappingError(mapping)
  if (mappingProblem) return empty(mappingProblem)
  const includesVat = amountsIncludeVatOf(mapping, options.vatRegistered, options.amountsIncludeVat)
  if (includesVat === null) return empty('vat_answer_missing')
  if (shape === 'summary' && options.period === null) return empty('period_missing')

  const sums = new Map<string, Sum>()
  const errors: ImportRowError[] = []
  let errorCount = 0
  let rowsRead = 0
  let totalRows = 0
  // The fee column's sum: null until one of its cells holds a value (an empty column is no statement).
  const fee: { sum: ReturnType<typeof toDec> | null } = { sum: null }
  const addFee = (value: string) => {
    fee.sum = (fee.sum ?? toDec(ZERO)).plus(toDec(value))
  }
  let lastDay: string | null = null
  let lastOrder: string | null = null
  const fail = (row: number, column: number | null, code: ImportRowErrorCode) => {
    errorCount++
    if (errors.length < IMPORT_ERRORS_KEPT) errors.push({ row: row + 1, column, code })
  }
  // A file repeats its amounts and days on many rows: each text is read once (up to a bound).
  const numbersRead = new Map<string, ReturnType<typeof importNumber>>()
  const numberAt = (row: readonly ImportCell[], column: number | undefined) => {
    if (column === undefined) return { ok: true, value: null } as const
    const cell = row[column]
    if (typeof cell !== 'string') return importNumber(cell)
    let read = numbersRead.get(cell)
    if (read === undefined) {
      read = importNumber(cell)
      if (numbersRead.size < TEXTS_KEPT) numbersRead.set(cell, read)
    }
    return read
  }
  const daysRead = new Map<string, ImportDateResult>()
  const dateAt = (cell: ImportCell | undefined) => {
    if (typeof cell !== 'string')
      return importDate(cell, options.dateOrder, options.timeZone ?? null)
    let read = daysRead.get(cell)
    if (read === undefined) {
      read = importDate(cell, options.dateOrder, options.timeZone ?? null)
      if (daysRead.size < TEXTS_KEPT) daysRead.set(cell, read)
    }
    return read
  }
  const qtyMax = toDec(options.qtyMax)
  // A file names each item on many rows: each text is folded once.
  const cached = (fold: (text: string) => string) => {
    const seen = new Map<string, string>()
    return (text: string) => {
      let key = seen.get(text)
      if (key === undefined) {
        key = fold(text)
        seen.set(text, key)
      }
      return key
    }
  }
  const headerKeyOf = cached(headerKey)
  const nameKeyOf = cached(nameKey)

  for (let index = options.headerRow + 1; index < rows.length; index++) {
    const row = rows[index] ?? []
    if (row.every((cell) => cellText(cell) === '')) continue
    if (isTotalRow(row, mapping, headerKeyOf)) {
      totalRows++
      continue
    }
    const order = mapping.order === undefined ? null : cellText(row[mapping.order]) || null
    const baseName = cellText(row[mapping.name!])
    const variant = mapping.variant === undefined ? '' : cellText(row[mapping.variant])
    const name = variant === '' ? baseName : baseName === '' ? '' : `${baseName} · ${variant}`
    const code = mapping.code === undefined ? null : cellText(row[mapping.code]) || null

    // The numbers of the row.
    const qtyRead = numberAt(row, mapping.qty)
    const netRead = numberAt(row, mapping.net)
    const totalRead = numberAt(row, mapping.total)
    const taxRead = numberAt(row, mapping.tax)
    const priceRead = numberAt(row, mapping.price)
    const feeRead = numberAt(row, mapping.fee)
    const bad = (
      [
        [mapping.qty, qtyRead],
        [mapping.net, netRead],
        [mapping.total, totalRead],
        [mapping.tax, taxRead],
        [mapping.price, priceRead],
        [mapping.fee, feeRead],
      ] as const
    ).find(([, read]) => !read.ok)
    if (bad) {
      fail(index, bad[0] ?? null, 'number_invalid')
      continue
    }
    const value = (read: typeof qtyRead) => (read.ok ? read.value : null)
    const amountGiven =
      value(netRead) !== null || value(totalRead) !== null || value(priceRead) !== null

    // The day: a line file's own (copied down from the row above within the same order, or from
    // the row above when the file has no order column); a summary's last day.
    let day: string | null = null
    if (shape === 'summary') {
      day = options.period!.to
    } else {
      const read = dateAt(row[mapping.date!])
      if (read.ok) day = read.date
      else if (read.error === 'invalid') {
        fail(index, mapping.date!, 'date_invalid')
        continue
      } else if (lastDay !== null && (order === null || order === lastOrder)) {
        day = lastDay
      }
    }

    if (name === '') {
      if (!amountGiven && value(qtyRead) === null) {
        // A row with nothing sold on it: only its fee counts (an order-level fee row).
        if (value(feeRead) !== null) {
          addFee(value(feeRead)!)
          rowsRead++
        }
        continue
      }
      fail(index, mapping.name!, 'name_missing')
      continue
    }
    if (day === null) {
      fail(index, mapping.date ?? null, 'date_missing')
      continue
    }

    // The quantity (1 when the file says none) and the amount of the row.
    let qty = toDec(value(qtyRead) ?? '1')
    if (qty.abs().gt(qtyMax)) {
      fail(index, mapping.qty ?? null, 'qty_too_large')
      continue
    }
    let amount: ReturnType<typeof toDec>
    let refund: boolean
    if (mapping.price !== undefined) {
      // A price × qty row is a refund when either is negative: what it takes back is |price| × |qty|.
      const price = toDec(value(priceRead) ?? ZERO)
      refund = price.lt(0) || qty.lt(0)
      amount = price
        .abs()
        .times(qty.abs())
        .minus(toDec(value(taxRead) ?? ZERO).abs())
    } else {
      amount =
        mapping.net !== undefined
          ? toDec(value(netRead) ?? ZERO)
          : toDec(value(totalRead) ?? ZERO).minus(toDec(value(taxRead) ?? ZERO))
      refund = amount.lt(0) || qty.lt(0)
    }
    // A refund row takes back both its quantity and its amount, however the file signs them (a
    // positive quantity beside a negative amount, a negative one beside an amount left unsigned, or
    // both negative).
    if (refund) {
      qty = negative(qty)
      amount = negative(amount)
    }

    if (value(feeRead) !== null) addFee(value(feeRead)!)
    const key = `${day}\u0000${nameKeyOf(name)}\u0000${code === null ? '' : nameKeyOf(code)}`
    const sum = sums.get(key)
    if (sum) {
      sum.qty = sum.qty.plus(qty)
      sum.amount = sum.amount.plus(amount)
      if (amount.lt(0)) sum.refunds = sum.refunds.minus(amount)
      sum.rows++
    } else {
      sums.set(key, {
        day,
        name,
        code,
        qty,
        amount,
        refunds: amount.lt(0) ? amount.negated() : toDec(ZERO),
        rows: 1,
      })
    }
    rowsRead++
    lastDay = day
    lastOrder = order
  }

  const items: ImportItem[] = [...sums.values()].map((s) => ({
    day: s.day,
    name: s.name,
    code: s.code,
    qty: plain(roundHalfUp(s.qty, QUANTITY_SCALE)),
    amount: fixed(s.amount, options.minorUnit),
    refunds: fixed(s.refunds, options.minorUnit),
    rows: s.rows,
  }))
  items.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  const days = items.map((i) => i.day)
  const period =
    shape === 'summary'
      ? options.period
      : days.length === 0
        ? null
        : { from: days[0]!, to: days[days.length - 1]! }
  let problem: ImportProblem | null = null
  if (items.length === 0) problem = 'no_rows'
  else if (period && period.from.slice(0, 7) !== period.to.slice(0, 7)) {
    problem = 'period_over_month'
  }
  return {
    shape,
    period,
    items,
    // What the app kept, however the file signs it (an export may write it as a deduction: -13.50).
    fees: fee.sum === null ? null : fixed(fee.sum.abs(), options.minorUnit),
    amountsIncludeVat: includesVat,
    rowsRead,
    rowsLeftOut: errorCount,
    totalRows,
    errors,
    problem,
  }
}

/** Σ of the items' amounts (refunds taken off), to the minor unit. */
export function importSales(items: readonly ImportItem[], minorUnit: number): string {
  return fixed(
    items.reduce((acc, item) => acc.plus(toDec(item.amount)), new Dec(0)),
    minorUnit,
  )
}
