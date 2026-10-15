import { nameKey } from '../../catalog/names'

// The columns of a sales file (M3 Step 4; the owner's answer Q15 of D-218). A file is read in the
// browser and never uploaded: its header row is found, its columns mapped to these fields from their
// English or Arabic names (then confirmed by the person), and only the mapped columns of each row go
// on. A file's own layout is remembered by a fingerprint of its headers, so the next file of the same
// export maps in one click (import_profiles).
//
// The fields:
//   - `date`: the sale's day (a line file); a file without it is a summary of the days the person
//     names ("These sales are for: a day / from–to");
//   - `name` and `variant` (joined as "Latte · Large"), `code` (an item code or SKU: retail files are
//     matched by it, through the saved aliases; products have no SKU of their own);
//   - `qty`; the amount, in one of three ways: `net` (before VAT), `total` (as the customer paid, with
//     VAT for a VAT-registered business unless the file has a `tax` column to take off, or the person
//     says it is before VAT), or `price` (per unit, × qty);
//   - `fee` (what the app or marketplace kept: summed into the channel's statement for the file's
//     days, B9), `order` (an order number: order-level fields left blank on its later rows are copied
//     down from its first row).
// Customer names, phones and anything else are never mapped, so they never leave the browser.

export const IMPORT_FIELDS = [
  'date',
  'name',
  'variant',
  'code',
  'qty',
  'net',
  'total',
  'tax',
  'price',
  'fee',
  'order',
] as const
export type ImportField = (typeof IMPORT_FIELDS)[number]

/** A file's columns as read: `lines` has a date per row; a `summary` covers days the person names. */
export const IMPORT_SHAPES = ['lines', 'summary'] as const
export type ImportShape = (typeof IMPORT_SHAPES)[number]

/** Which column (0-based) each field is read from; a field left out is not in the file. */
export type ImportMapping = Partial<Record<ImportField, number>>

/** The amount fields: one of them is needed. */
export const AMOUNT_FIELDS = ['net', 'total', 'price'] as const satisfies readonly ImportField[]

/**
 * The header names each field is known by, in English and Arabic, as headerKey folds them, best
 * first. A header is matched whole (never a part of it), so "Customer name" is never the item's name.
 */
const SYNONYMS: Readonly<Record<ImportField, readonly string[]>> = {
  date: [
    'date',
    'business date',
    'sale date',
    'order date',
    'day',
    'created at',
    'created',
    'paid at',
    'transaction date',
    'date time',
    'التاريخ',
    'تاريخ',
    'اليوم',
    'تاريخ البيع',
    'تاريخ الطلب',
    'تاريخ العمليه',
  ],
  name: [
    'item',
    'item name',
    'product',
    'product name',
    'lineitem name',
    'menu item',
    'product title',
    'title',
    'description',
    'name',
    'الصنف',
    'اسم الصنف',
    'المنتج',
    'اسم المنتج',
    'الاسم',
    'الوصف',
    'البند',
  ],
  variant: [
    'variant',
    'variant name',
    'variant title',
    'size',
    'option',
    'الحجم',
    'النوع',
    'الخيار',
  ],
  code: [
    'sku',
    'code',
    'item code',
    'product code',
    'barcode',
    'plu',
    'lineitem sku',
    'رمز الصنف',
    'الرمز',
    'الكود',
    'كود',
    'الباركود',
    'رمز المنتج',
  ],
  qty: [
    'qty',
    'quantity',
    'items sold',
    'sold',
    'count',
    'lineitem quantity',
    'units',
    'units sold',
    'الكميه',
    'الكميه المباعه',
    'العدد',
    'عدد',
  ],
  net: [
    'net sales',
    'net',
    'net amount',
    'subtotal',
    'sub total',
    'sales before vat',
    'amount excl vat',
    'amount before vat',
    'net of vat',
    'excl vat',
    'صافي المبيعات',
    'الصافي',
    'صافي',
    'المبلغ قبل الضريبه',
    'المبيعات قبل الضريبه',
    'المجموع الفرعي',
  ],
  total: [
    'total',
    'gross sales',
    'total sales',
    'sales',
    'amount',
    'total amount',
    'gross',
    'line total',
    'lineitem total',
    'الاجمالي',
    'اجمالي المبيعات',
    'المبيعات',
    'المبلغ',
    'المبلغ الاجمالي',
  ],
  tax: ['tax', 'vat', 'tax amount', 'vat amount', 'taxes', 'الضريبه', 'ضريبه القيمه المضافه'],
  price: [
    'price',
    'unit price',
    'lineitem price',
    'item price',
    'السعر',
    'سعر الوحده',
    'سعر البيع',
  ],
  fee: [
    'commission',
    'fee',
    'fees',
    'platform fee',
    'marketplace fee',
    'commission fee',
    'service fee',
    'العموله',
    'عموله',
    'الرسوم',
    'رسوم',
  ],
  order: [
    'order',
    'order number',
    'order id',
    'order no',
    'receipt',
    'receipt number',
    'receipt no',
    'invoice',
    'invoice number',
    'رقم الطلب',
    'الطلب',
    'رقم الفاتوره',
    'رقم الايصال',
  ],
}

/** Currency words a header may carry ("Net sales (AED)", "Total AED"), dropped before matching. */
const CURRENCY_WORDS = /(?:^|\s)(?:aed|dhs|dh|درهم|د\.?\s?إ|د\.?\s?ا)\.?(?=\s|$)/gu
/** Brackets and what they hold, punctuation and symbols: "Qty.", "Item_Name", "# Sold". */
const BRACKETS = /[([{][^)\]}]*[)\]}]/gu
const PUNCTUATION = /[\p{P}\p{S}]+/gu

/**
 * A header as it is compared: nameKey (case, Arabic letter forms, marks and digits folded, D-158),
 * with what is in brackets, currency words and punctuation dropped ("Net Sales (AED)" → "net sales",
 * «الكمية» → «الكميه»).
 */
export function headerKey(text: string): string {
  return nameKey(
    nameKey(text).replace(BRACKETS, ' ').replace(CURRENCY_WORDS, ' ').replace(PUNCTUATION, ' '),
  )
}

const KNOWN = new Map<string, { field: ImportField; rank: number }[]>()
for (const field of IMPORT_FIELDS) {
  SYNONYMS[field].forEach((name, rank) => {
    const key = headerKey(name)
    KNOWN.set(key, [...(KNOWN.get(key) ?? []), { field, rank }])
  })
}

/** The fields a header is known for, best first (empty when it is not a known name). */
export function fieldsOfHeader(text: string): readonly ImportField[] {
  return (KNOWN.get(headerKey(text)) ?? []).map((k) => k.field)
}

/** A cell of a file as read: text, a number (spreadsheets), or nothing. */
export type ImportCell = string | number | null

/** A cell as text ("" for nothing). */
export function cellText(cell: ImportCell | undefined): string {
  if (cell === null || cell === undefined) return ''
  return typeof cell === 'number' ? String(cell) : cell.trim()
}

/** How far down a file its header row is looked for (title lines come first). */
export const HEADER_SEARCH_ROWS = 30

/**
 * The header row of a file: among its first rows, the one whose cells name the most known fields
 * (at least two: an item's name and an amount or a quantity), so title lines above it are skipped.
 * Without one, the first row with at least two cells of text that are not numbers (the person maps
 * its columns). Null for a file with no such row.
 */
export function findHeaderRow(rows: readonly (readonly ImportCell[])[]): number | null {
  let best: { index: number; known: number } | null = null
  const limit = Math.min(rows.length, HEADER_SEARCH_ROWS)
  for (let index = 0; index < limit; index++) {
    const fields = new Set(
      (rows[index] ?? []).flatMap((cell) =>
        typeof cell === 'string' ? fieldsOfHeader(cell).slice(0, 1) : [],
      ),
    )
    if (fields.size >= 2 && (best === null || fields.size > best.known)) {
      best = { index, known: fields.size }
    }
  }
  if (best) return best.index
  for (let index = 0; index < limit; index++) {
    const texts = (rows[index] ?? []).filter(
      (cell) => typeof cell === 'string' && cell.trim() !== '' && !/^[\d\s.,٠-٩٫٬-]+$/u.test(cell),
    )
    if (texts.length >= 2) return index
  }
  return null
}

/**
 * Headers that name a line item's own amount in a store's orders export, where the order's amounts
 * (Subtotal, Taxes, Total) are written on its first row only (Shopify's "Lineitem price").
 */
const LINE_AMOUNT_KEYS = new Set(
  ['lineitem price', 'lineitem total', 'line item price', 'line item total', 'line total'].map(
    headerKey,
  ),
)

/** How many data rows the automatic mapping looks at (which amount column every row fills). */
const MAP_SAMPLE_ROWS = 200

/**
 * The fields of a header row, mapped automatically: each field takes the column whose header is its
 * best known name, each column at most one field (a better-ranked claim wins). The person confirms or
 * changes it. One amount, never two:
 *   - a line item's own amount when the file names one ("Lineitem price"): an orders export writes
 *     its order's Subtotal, Taxes and Total on the order's first row only, so they are not the
 *     line's (its order-level tax column is left out too);
 *   - else, with `rows` (the rows below the header), the first of `net`, `total`, `price` filled on
 *     every row that names an item (an amount left blank on an order's later rows is the order's);
 *   - else `net` when the file has it, then `total`, then `price`.
 */
export function autoMap(
  headers: readonly ImportCell[],
  rows: readonly (readonly ImportCell[])[] = [],
): ImportMapping {
  const claims: { field: ImportField; column: number; rank: number }[] = []
  headers.forEach((cell, column) => {
    if (typeof cell !== 'string') return
    for (const { field, rank } of KNOWN.get(headerKey(cell)) ?? []) {
      claims.push({ field, column, rank })
    }
  })
  claims.sort((a, b) => a.rank - b.rank || a.column - b.column)
  const mapping: ImportMapping = {}
  const taken = new Set<number>()
  for (const claim of claims) {
    if (mapping[claim.field] !== undefined || taken.has(claim.column)) continue
    mapping[claim.field] = claim.column
    taken.add(claim.column)
  }
  const candidates = AMOUNT_FIELDS.filter((field) => mapping[field] !== undefined)
  if (candidates.length === 0) return mapping
  const headerOf = (column: number) => headerKey(cellText(headers[column]))
  const named = rows
    .slice(0, MAP_SAMPLE_ROWS)
    .filter((row) => mapping.name !== undefined && cellText(row[mapping.name]) !== '')
  const filled = (column: number | undefined) =>
    column === undefined || named.every((row) => cellText(row[column]) !== '')
  const lineLevel = candidates.find((field) => LINE_AMOUNT_KEYS.has(headerOf(mapping[field]!)))
  const everyRow = named.length > 0 ? candidates.find((f) => filled(mapping[f])) : undefined
  const chosen = lineLevel ?? everyRow ?? candidates[0]!
  // A tax column beside the order's amounts passed over is the order's too, unless every line fills it.
  const orderLevel = chosen !== candidates[0]
  for (const field of candidates) if (field !== chosen) delete mapping[field]
  if (orderLevel && mapping.tax !== undefined && (named.length === 0 || !filled(mapping.tax))) {
    delete mapping.tax
  }
  return mapping
}

/** A mapping's problem: no item name, no amount, two amounts, or one column for two fields. */
export type MappingError = 'name_missing' | 'amount_missing' | 'amounts_twice' | 'column_twice'

export function mappingError(mapping: ImportMapping): MappingError | null {
  if (mapping.name === undefined) return 'name_missing'
  const amounts = AMOUNT_FIELDS.filter((f) => mapping[f] !== undefined)
  if (amounts.length === 0) return 'amount_missing'
  if (amounts.length > 1) return 'amounts_twice'
  const columns = Object.values(mapping)
  if (new Set(columns).size !== columns.length) return 'column_twice'
  return null
}

/** The shape a mapping gives: a date per row (`lines`), else a summary of named days. */
export function shapeOf(mapping: ImportMapping): ImportShape {
  return mapping.date === undefined ? 'summary' : 'lines'
}

/**
 * The text a file's layout is remembered by (its headers folded, in order); the screens keep its
 * SHA-256 (import_profiles.fingerprint), never the headers themselves.
 */
export function headerFingerprintSource(headers: readonly ImportCell[]): string {
  return headers.map((cell) => headerKey(cellText(cell))).join('\u001f')
}

/** Words a "total" row starts with; such rows (and empty ones) are not sales. */
const TOTAL_ROW_KEYS = new Set(
  [
    'total',
    'totals',
    'grand total',
    'sub total',
    'subtotal',
    'total sales',
    'net total',
    'daily total',
    'day total',
    'sum',
    'المجموع',
    'مجموع',
    'المجموع الكلي',
    'المجموع العام',
    'المجموع النهائي',
    'المجموع اليومي',
    'المجموع الفرعي',
    'الاجمالي',
    'اجمالي',
    'الاجمالي الكلي',
    'الاجمالي العام',
    'الاجمالي النهائي',
    'الاجمالي اليومي',
    'اجمالي المبيعات',
    'اجمالي اليوم',
    'مجموع اليوم',
    'مجموع المبيعات',
  ].map(headerKey),
)

/** Words a total row of some days starts with, whatever follows ("Total for 08/10/2026"). */
const TOTAL_ROW_PREFIXES = ['total for', 'totals for', 'اجمالي يوم', 'مجموع يوم'].map(headerKey)

const LETTER = /\p{L}/u

/** The first word of each total row's key or prefix: a text that starts with none is no total row. */
const TOTAL_ROW_FIRST_WORDS = new Set(
  [...TOTAL_ROW_KEYS, ...TOTAL_ROW_PREFIXES].map((key) => key.split(' ')[0]!),
)

/**
 * A row that only adds up others ("Total", «المجموع», «إجمالي المبيعات», "Total 08/10/2026", "Total
 * for 08/10/2026") in its item name or its first cell of text: it is skipped, so a file's own totals
 * never count twice. A name that only starts with the word ("Total Care Kit") is an item, unless the
 * row of a line file has no day (and no item code) of its own: a total of the day above it.
 */
export function isTotalRow(
  row: readonly ImportCell[],
  mapping: ImportMapping,
  fold: (text: string) => string = headerKey,
): boolean {
  const name = mapping.name === undefined ? '' : cellText(row[mapping.name])
  const first = row.find((cell) => typeof cell === 'string' && cell.trim() !== '')
  const ownDay = mapping.date !== undefined && cellText(row[mapping.date]) !== ''
  const ownCode = mapping.code !== undefined && cellText(row[mapping.code]) !== ''
  const dayless = mapping.date !== undefined && !ownDay && !ownCode
  for (const text of [name, typeof first === 'string' ? first : '']) {
    if (text === '') continue
    const key = fold(text)
    // Every check below wants a whole key or prefix at its start: its first word first (most rows).
    const space = key.indexOf(' ')
    if (!TOTAL_ROW_FIRST_WORDS.has(space < 0 ? key : key.slice(0, space))) continue
    if (TOTAL_ROW_KEYS.has(key)) return true
    if (TOTAL_ROW_PREFIXES.some((prefix) => key === prefix || key.startsWith(`${prefix} `))) {
      return true
    }
    for (const total of TOTAL_ROW_KEYS) {
      if (!key.startsWith(`${total} `)) continue
      if (dayless || !LETTER.test(key.slice(total.length))) return true
    }
  }
  return false
}
