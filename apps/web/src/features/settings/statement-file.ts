import {
  cellText,
  dateOrderOf,
  headerKey,
  importDate,
  importNumber,
  HEADER_SEARCH_ROWS,
  type DateOrder,
  type ImportCell,
} from '@bizcost/domain'

// A channel's statements read from a file (M3 Step 4; the statement template, or an app's own export
// with the same columns): one statement a row, its days and what the app kept. Headers in English or
// Arabic; amounts and days as the importer reads them (Arabic digits, "AED", "(12.00)", dd/mm/yyyy,
// spreadsheet serial days). Read in the browser; each row becomes a draft the person checks and
// finalizes.

export const STATEMENT_FIELDS = [
  'from',
  'to',
  'sales',
  'commission',
  'paymentFees',
  'otherFees',
  'ads',
  'refundsCharged',
  'payout',
] as const
export type StatementField = (typeof STATEMENT_FIELDS)[number]

const NAMES: Readonly<Record<StatementField, readonly string[]>> = {
  from: ['from', 'start', 'start date', 'period from', 'من', 'من تاريخ', 'بداية الفتره'],
  to: ['to', 'end', 'end date', 'period to', 'الى', 'إلى', 'الي', 'الى تاريخ', 'نهايه الفتره'],
  sales: ['sales', 'gross sales', 'total sales', 'orders value', 'المبيعات', 'اجمالي المبيعات'],
  commission: ['commission', 'commission fee', 'العموله', 'عموله'],
  paymentFees: ['payment fees', 'payment fee', 'card fees', 'رسوم الدفع'],
  otherFees: ['other fees', 'other charges', 'fees', 'رسوم اخري', 'رسوم اخرى', 'رسوم'],
  ads: ['ads', 'advertising', 'marketing', 'الاعلانات', 'اعلانات'],
  refundsCharged: [
    'refunds charged',
    'refunds',
    'refund deductions',
    'المبالغ المسترده المخصومه',
    'المبالغ المسترده',
    'المرتجعات',
  ],
  payout: ['payout', 'net payout', 'amount paid', 'transferred', 'المبلغ المحول', 'صافي التحويل'],
}

const KNOWN = new Map<string, StatementField>()
for (const field of STATEMENT_FIELDS) {
  for (const name of NAMES[field]) {
    const key = headerKey(name)
    if (!KNOWN.has(key)) KNOWN.set(key, field)
  }
}

export interface StatementRow {
  readonly row: number
  readonly periodFrom: string
  readonly periodTo: string
  readonly sales: string | null
  readonly commission: string
  readonly paymentFees: string
  readonly otherFees: string
  readonly ads: string
  readonly refundsCharged: string
  readonly payout: string | null
}

/** Why a row is left out: a day missing or not a day, its first day after its last, not a number. */
export type StatementRowError = 'date_missing' | 'date_invalid' | 'days_order' | 'number_invalid'

/** A row left out: its row (1-based), its column (null: the row's days together) and why. */
export interface StatementRowProblem {
  readonly row: number
  readonly column: number | null
  readonly code: StatementRowError
}

export interface StatementFileRead {
  readonly statements: readonly StatementRow[]
  readonly errors: readonly StatementRowProblem[]
  /** The file's header of each column read (to name a column left out). */
  readonly headers: Readonly<Partial<Record<number, string>>>
  /** No header row with the statement's columns (its days and at least one fee). */
  readonly unknown: boolean
}

/** Reads statements from a file's rows (see above). */
export function readStatementRows(rows: readonly (readonly ImportCell[])[]): StatementFileRead {
  let headerRow = -1
  let columns = new Map<StatementField, number>()
  for (let index = 0; index < Math.min(rows.length, HEADER_SEARCH_ROWS); index++) {
    const found = new Map<StatementField, number>()
    ;(rows[index] ?? []).forEach((cell, column) => {
      const field = typeof cell === 'string' ? KNOWN.get(headerKey(cell)) : undefined
      if (field && !found.has(field)) found.set(field, column)
    })
    const fees = (
      ['commission', 'paymentFees', 'otherFees', 'ads', 'refundsCharged'] as const
    ).some((f) => found.has(f))
    if (found.has('from') && found.has('to') && fees) {
      headerRow = index
      columns = found
      break
    }
  }
  if (headerRow < 0) return { statements: [], errors: [], headers: {}, unknown: true }
  const headers: Partial<Record<number, string>> = {}
  for (const column of columns.values())
    headers[column] = cellText(rows[headerRow]?.[column] ?? null)
  const body = rows.slice(headerRow + 1)
  const order: DateOrder = dateOrderOf(
    body.flatMap((row) => [row[columns.get('from')!] ?? null, row[columns.get('to')!] ?? null]),
  ).order
  const statements: StatementRow[] = []
  const errors: StatementRowProblem[] = []
  body.forEach((row, offset) => {
    const at = headerRow + offset + 2
    if (row.every((cell) => cellText(cell) === '')) return
    // Each row left out names its column and why, as the sales importer does.
    const days = { from: columns.get('from')!, to: columns.get('to')! }
    const from = importDate(row[days.from] ?? null, order)
    const to = importDate(row[days.to] ?? null, order)
    for (const [read, column] of [
      [from, days.from],
      [to, days.to],
    ] as const) {
      if (!read.ok) {
        errors.push({
          row: at,
          column,
          code: read.error === 'missing' ? 'date_missing' : 'date_invalid',
        })
        return
      }
    }
    if (!from.ok || !to.ok) return
    if (from.date > to.date) {
      errors.push({ row: at, column: null, code: 'days_order' })
      return
    }
    const amounts: Partial<Record<StatementField, string | null>> = {}
    for (const field of [
      'sales',
      'commission',
      'paymentFees',
      'otherFees',
      'ads',
      'refundsCharged',
      'payout',
    ] as const) {
      const column = columns.get(field)
      const read =
        column === undefined ? { ok: true as const, value: null } : importNumber(row[column])
      if (!read.ok) {
        errors.push({ row: at, column: column ?? null, code: 'number_invalid' })
        return
      }
      if (read.value !== null && read.value.startsWith('-')) {
        // An app's export may write what it kept as a negative ("-1,800.00"): it is still kept.
        amounts[field] = field === 'payout' ? read.value : read.value.slice(1)
      } else amounts[field] = read.value
    }
    statements.push({
      row: at,
      periodFrom: from.date,
      periodTo: to.date,
      sales: amounts.sales ?? null,
      commission: amounts.commission ?? '0',
      paymentFees: amounts.paymentFees ?? '0',
      otherFees: amounts.otherFees ?? '0',
      ads: amounts.ads ?? '0',
      refundsCharged: amounts.refundsCharged ?? '0',
      payout: amounts.payout?.startsWith('-') ? null : (amounts.payout ?? null),
    })
  })
  return { statements, errors, headers, unknown: false }
}
