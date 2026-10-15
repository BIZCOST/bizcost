import type { ImportMappingDto, ImportProfileDto, ImportRowInput } from '@bizcost/contracts'
import {
  AMOUNT_FIELDS,
  autoMap,
  cellText,
  dateOrderOf,
  findHeaderRow,
  looksNotSold,
  readImportRows,
  SALE_LINE_QTY_MAX,
  shapeOf,
  vatQuestionAsked,
  type DateOrder,
  type ImportCell,
  type ImportField,
  type ImportMapping,
  type ImportRead,
} from '@bizcost/domain'

// The import wizard's own logic (M3 Step 4), apart from its screens so it is tested: which steps a file
// needs, the columns it starts with (a saved layout, else the automatic mapping), what the person's
// choices make of the file (readImportRows), and what is sent (the rows in chunks, the mapping kept).
//
// The steps: 1 the file, the channel and the branch; 2 the columns; 3 "These sales are for: a day /
// from–to" (a summary only: no date column); 4 "Do these amounts include VAT?" (a VAT-registered
// business whose file has no column before VAT and no tax column). Then the draft is made and the
// names (5) and the preview (6) are settled on the import's own page.

export const WIZARD_STEPS = ['file', 'columns', 'period', 'vat'] as const
export type WizardStep = (typeof WIZARD_STEPS)[number]

/** The steps a file takes with these columns (3 and 4 only when they apply). */
export function stepsFor(mapping: ImportMapping, vatRegistered: boolean): WizardStep[] {
  return WIZARD_STEPS.filter(
    (step) =>
      (step !== 'period' || shapeOf(mapping) === 'summary') &&
      (step !== 'vat' || vatQuestionAsked(mapping, vatRegistered)),
  )
}

/** The amount column's meaning, as the screen asks it (one of the three amount fields). */
export type AmountKind = (typeof AMOUNT_FIELDS)[number]

/** Which amount field a mapping uses, and its column. */
export function amountOf(mapping: ImportMapping): { kind: AmountKind; column: number } | null {
  for (const kind of AMOUNT_FIELDS) {
    const column = mapping[kind]
    if (column !== undefined) return { kind, column }
  }
  return null
}

/** The mapping with its amount column set (or cleared) as `kind`. */
export function withAmount(
  mapping: ImportMapping,
  column: number | null,
  kind: AmountKind,
): ImportMapping {
  const next: ImportMapping = { ...mapping }
  for (const field of AMOUNT_FIELDS) delete next[field]
  if (column !== null) next[kind] = column
  return next
}

/** The mapping with `field` read from `column` (null: not in the file); a column serves one field. */
export function withField(
  mapping: ImportMapping,
  field: ImportField,
  column: number | null,
): ImportMapping {
  const next: ImportMapping = {}
  for (const [key, value] of Object.entries(mapping) as [ImportField, number][]) {
    if (key !== field && value !== column) next[key] = value
  }
  if (column !== null) next[field] = column
  return next
}

/** A column's name as the screens show it: its header, or "Column C". */
export function columnLetter(index: number): string {
  let n = index + 1
  let letters = ''
  while (n > 0) {
    const rest = (n - 1) % 26
    letters = String.fromCharCode(65 + rest) + letters
    n = Math.floor((n - 1) / 26)
  }
  return letters
}

/** The file's columns below its header row: each one's index and header text (may be empty). */
export function columnsOf(
  rows: readonly (readonly ImportCell[])[],
  headerRow: number,
): { index: number; header: string }[] {
  const width = Math.max(0, ...rows.slice(headerRow, headerRow + 50).map((r) => r.length))
  const headers = rows[headerRow] ?? []
  return Array.from({ length: width }, (_, index) => ({
    index,
    header: cellText(headers[index] ?? null),
  }))
}

/** A saved layout's columns, when they fit this file (its header row and columns exist). */
export function profileMapping(
  profile: Pick<ImportProfileDto, 'mapping'> | undefined,
  rows: readonly (readonly ImportCell[])[],
): { headerRow: number; mapping: ImportMapping; dateOrder: DateOrder } | null {
  if (!profile) return null
  const { headerRow, columns, dateOrder } = profile.mapping
  const width = rows[headerRow]?.length ?? 0
  const mapping: ImportMapping = {}
  for (const [field, column] of Object.entries(columns) as [ImportField, number][]) {
    if (column >= width) return null
    mapping[field] = column
  }
  return { headerRow, mapping, dateOrder }
}

/**
 * Where a file starts: its header row (found, or the one the person picks), the columns found from
 * their names and from the rows below (an amount every line fills), the order of its days.
 */
export function startOf(
  rows: readonly (readonly ImportCell[])[],
  header: number | null = null,
): {
  headerRow: number
  mapping: ImportMapping
  dateOrder: DateOrder
  ambiguousDays: boolean
} {
  const headerRow = header ?? findHeaderRow(rows) ?? 0
  const mapping = autoMap(rows[headerRow] ?? [], rows.slice(headerRow + 1, headerRow + 201))
  const days = datesOf(rows, headerRow, mapping)
  const order = dateOrderOf(days)
  return { headerRow, mapping, dateOrder: order.order, ambiguousDays: order.ambiguous }
}

/** The day column's cells below the header row. */
export function datesOf(
  rows: readonly (readonly ImportCell[])[],
  headerRow: number,
  mapping: ImportMapping,
): ImportCell[] {
  if (mapping.date === undefined) return []
  return rows.slice(headerRow + 1).map((row) => row[mapping.date!] ?? null)
}

/** What the person chose, read into the import (the domain's readImportRows). */
export function readWith(
  rows: readonly (readonly ImportCell[])[],
  choice: {
    headerRow: number
    mapping: ImportMapping
    dateOrder: DateOrder
    vatRegistered: boolean
    amountsIncludeVat: boolean | null
    period: { from: string; to: string } | null
    /** The business's time zone (a time written with its offset from UTC is its day there). */
    timeZone?: string | null
  },
): ImportRead {
  return readImportRows(rows, {
    ...choice,
    minorUnit: 2,
    qtyMax: SALE_LINE_QTY_MAX,
  })
}

/** The mapping as an import keeps it (with each mapped column's header, for the screens). */
export function mappingDto(
  rows: readonly (readonly ImportCell[])[],
  headerRow: number,
  mapping: ImportMapping,
  dateOrder: DateOrder,
): ImportMappingDto {
  const headers: ImportMappingDto['headers'] = {}
  for (const [field, column] of Object.entries(mapping) as [ImportField, number][]) {
    headers[field] = cellText(rows[headerRow]?.[column] ?? null).slice(0, 200)
  }
  return { headerRow, columns: { ...mapping }, headers, dateOrder }
}

/** The staged rows of a read file, numbered from 0. */
export function rowsToSend(read: ImportRead): ImportRowInput[] {
  return read.items.map((item, position) => ({
    position,
    businessDate: item.day,
    name: item.name.slice(0, 300),
    code: item.code === null ? null : item.code.slice(0, 100),
    qty: item.qty,
    amount: item.amount,
    refunds: item.refunds,
    fileRows: item.rows,
  }))
}

/** `list` in chunks of `size` (the API takes IMPORT_ROWS_CHUNK rows a call). */
export function chunksOf<T>(list: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size))
  return chunks
}

/**
 * What "Add as new products" takes of the names not settled: only those compared with the products
 * that look like none of them, and never one that looks like a tip, a service charge or delivery
 * (looksNotSold). The others are left for the person to settle, one at a time.
 */
export function namesToAddAll<
  T extends {
    readonly name: string
    readonly match:
      | { readonly state: 'matched' }
      | { readonly state: 'unmatched'; readonly suggestions: readonly unknown[] | null }
  },
>(names: readonly T[]): { add: T[]; left: T[] } {
  const add: T[] = []
  const left: T[] = []
  for (const entry of names) {
    if (entry.match.state !== 'unmatched') continue
    const alone = entry.match.suggestions !== null && entry.match.suggestions.length === 0
    if (alone && looksNotSold(entry.name) === null) add.push(entry)
    else left.push(entry)
  }
  return { add, left }
}

/**
 * How many days an import's days cover: a line file's days one each, a summary's one sale every day
 * from its first to its last ("1–30 Sep" is 30 days, never "1 day").
 */
export function daysCovered(
  days: readonly { readonly businessDate: string; readonly periodFrom: string | null }[],
): number {
  const covered = new Set<string>()
  for (const day of days) {
    const date = new Date(`${day.periodFrom ?? day.businessDate}T00:00:00Z`)
    for (let iso = date.toISOString().slice(0, 10); iso <= day.businessDate;) {
      covered.add(iso)
      date.setUTCDate(date.getUTCDate() + 1)
      iso = date.toISOString().slice(0, 10)
    }
  }
  return covered.size
}

/** A summary's days: one day, or from–to within one month and never after today. */
export function periodError(
  from: string,
  to: string,
  today: string,
): 'missing' | 'order' | 'month' | 'future' | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return 'missing'
  if (from > to) return 'order'
  if (from.slice(0, 7) !== to.slice(0, 7)) return 'month'
  if (to > today) return 'future'
  return null
}
