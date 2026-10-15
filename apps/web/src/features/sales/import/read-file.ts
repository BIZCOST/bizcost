import type { ImportCell } from '@bizcost/domain'

// Reading a sales file in the browser (M3 Step 4; the owner's answer Q15 of D-218): the file never
// leaves the device. A spreadsheet (.xlsx, .xls) is read by SheetJS Community Edition (pinned from its
// official tarball, D-252), loaded only when such a file is picked, so no other page carries it. A
// text file (.csv, .txt, .tsv) is decoded here: UTF-8 with or without its byte-order mark, UTF-16
// (little or big endian, with a mark, or recognised by its high bytes: zero for Latin letters, 0x06
// for Arabic ones), else Windows-1256 (Arabic Windows exports), and split by its delimiter (comma,
// semicolon, tab or bar, whichever the first lines use alike). Numbers and days in a text file stay
// text: the importer reads them itself (Arabic digits, "(12.00)", dd/mm/yyyy), never a spreadsheet's
// guess. Many back offices save an HTML table, an XML 2003 workbook or plain text named ".xls": the
// first two are read by SheetJS from the text decoded here, the third as a text file.
//
// A spreadsheet is read by the cells it holds, never by the range it declares (a few KB may declare
// a million rows of 16,384 columns: `nodim`), up to IMPORT_SHEET_ROWS_MAX rows (more is too large) and
// its first IMPORT_SHEET_COLUMNS_MAX columns; a .xlsx whose parts would unzip past
// IMPORT_UNZIPPED_MAX_BYTES is refused before it is unzipped. A workbook in the 1904 date system
// (Excel for Mac) has its days moved to the 1900 system the importer counts in.

/** The largest file read (a month of a busy shop's lines is a few MB). */
export const IMPORT_FILE_MAX_BYTES = 25 * 1024 * 1024

/** The most rows a spreadsheet's sheet may hold (a month of a busy shop's lines is far fewer). */
export const IMPORT_SHEET_ROWS_MAX = 200_000

/** The columns of a sheet that are read (an export has far fewer: a stray cell far right widens no row). */
export const IMPORT_SHEET_COLUMNS_MAX = 200

/**
 * The most a .xlsx may hold once unzipped, all its parts together (a 25 MB workbook of a busy shop's
 * month is far less): a few KB of zip may claim gigabytes (a zip bomb), refused before it is unzipped.
 */
export const IMPORT_UNZIPPED_MAX_BYTES = 400 * 1024 * 1024

/** Serial days between the 1904 and the 1900 date systems. */
const DAYS_1904 = 1462

/**
 * What a zip's parts come to once unzipped, as its central directory says (each part's uncompressed
 * size); Infinity for a zip that cannot be read so (no directory, or ZIP64's sizes past 4 GB).
 */
export function unzippedSize(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // The end of the central directory: its signature within the last 64 KB (after a comment).
  let end = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) return Infinity
  const entries = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  if (entries === 0xffff || at === 0xffffffff) return Infinity
  let total = 0
  for (let n = 0; n < entries; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) return Infinity
    const size = view.getUint32(at + 24, true)
    if (size === 0xffffffff) return Infinity
    total += size
    at +=
      46 +
      view.getUint16(at + 28, true) +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true)
  }
  return total
}

/** `markup`: an HTML table or an XML 2003 workbook named .xls (SheetJS reads it from its text). */
export type FileKind = 'csv' | 'xlsx' | 'xls' | 'markup'
export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1256'

export interface FileRead {
  readonly name: string
  readonly size: number
  /** SHA-256 of the file's bytes, in hex: the same file twice is refused. */
  readonly hash: string
  readonly kind: FileKind
  /** A text file's encoding and delimiter. */
  readonly encoding: TextEncoding | null
  readonly delimiter: string | null
  /** A spreadsheet's sheets, and the one read. */
  readonly sheets: readonly string[]
  readonly sheet: string | null
  readonly rows: readonly (readonly ImportCell[])[]
}

export type ReadError = 'too_large' | 'empty' | 'unreadable' | 'not_supported'

export class FileReadError extends Error {
  constructor(readonly code: ReadError) {
    super(code)
  }
}

const extensionOf = (name: string) => name.toLowerCase().split('.').pop() ?? ''

/** A spreadsheet's name (.xlsx, .xls): a file named so that cannot be read is unreadable, not unknown. */
export const isSpreadsheetName = (name: string) => ['xlsx', 'xls'].includes(extensionOf(name))

/** The start of a file as text, when it is text (few control characters): null for binary bytes. */
function textStart(bytes: Uint8Array): string | null {
  const { text } = decodeText(bytes.subarray(0, Math.min(bytes.length, 4096)))
  let control = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) control++
  }
  return control <= text.length * 0.01 ? text : null
}

/**
 * The kind of a file, by its first bytes (a zip is .xlsx, an OLE2 file .xls), else by its name: a
 * text file (.csv, .txt, .tsv), or an ".xls" that is an HTML table or an XML 2003 workbook (markup)
 * or plain text. An ".xlsx" is always a zip: null when it is not, as for any other name.
 */
export function kindOf(name: string, bytes: Uint8Array): FileKind | null {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)
    return 'xlsx'
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return 'xls'
  const extension = extensionOf(name)
  if (['csv', 'txt', 'tsv'].includes(extension)) return 'csv'
  if (extension === 'xls') {
    const text = textStart(bytes)
    if (text === null) return null
    return text.trimStart().startsWith('<') ? 'markup' : 'csv'
  }
  return null
}

/**
 * The text of a text file: its byte-order mark decides; without one, UTF-16 when every other byte of
 * its start is a high byte (zero for Latin letters, 0x06 for Arabic ones) and the bytes between are
 * never zero, else UTF-8 when it decodes as UTF-8, else Windows-1256.
 */
export function decodeText(bytes: Uint8Array): { text: string; encoding: TextEncoding } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' }
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' }
  }
  const sample = bytes.subarray(0, Math.min(bytes.length, 512) & ~1)
  if (sample.length >= 4) {
    const zeros = [0, 0]
    // High bytes of the characters a sales file holds: 0x00 (Latin, digits) and 0x06 (Arabic).
    const highs = [0, 0]
    for (let i = 0; i < sample.length; i++) {
      if (sample[i] === 0) zeros[i % 2]!++
      if (sample[i] === 0 || sample[i] === 6) highs[i % 2]!++
    }
    const half = sample.length / 2
    if (zeros[0] === 0 && highs[1]! >= half * 0.9) {
      return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'utf-16le' }
    }
    if (zeros[1] === 0 && highs[0]! >= half * 0.9) {
      return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'utf-16be' }
    }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }
  } catch {
    return { text: new TextDecoder('windows-1256').decode(bytes), encoding: 'windows-1256' }
  }
}

const DELIMITERS = [',', ';', '\t', '|'] as const

/** How many times `delimiter` splits `line` outside quotes. */
function countOutsideQuotes(line: string, delimiter: string): number {
  let count = 0
  let quoted = false
  for (const ch of line) {
    if (ch === '"') quoted = !quoted
    else if (ch === delimiter && !quoted) count++
  }
  return count
}

/**
 * The delimiter of a text file: among comma, semicolon, tab and bar, the one its first lines (up to
 * 20 with text) use the same number of times, the most; a comma when none does.
 */
export function detectDelimiter(text: string): string {
  const lines = text
    .split(/\r\n|\n|\r/)
    .filter((line) => line.trim() !== '')
    .slice(0, 20)
  let best: { delimiter: string; score: number } = { delimiter: ',', score: 0 }
  for (const delimiter of DELIMITERS) {
    const counts = lines.map((line) => countOutsideQuotes(line, delimiter))
    const max = Math.max(0, ...counts)
    if (max === 0) continue
    // The lines that use it as often as the most frequent count (title lines may not).
    const frequent = new Map<number, number>()
    for (const c of counts) if (c > 0) frequent.set(c, (frequent.get(c) ?? 0) + 1)
    const [count, lines_] = [...frequent.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]!
    const score = lines_ * 100 + count
    if (score > best.score) best = { delimiter, score }
  }
  return best.delimiter
}

/**
 * Splits a text file into rows of cells (RFC 4180: a quoted cell may hold the delimiter, line breaks
 * and doubled quotes). Cells are trimmed; an empty cell is null.
 */
export function parseDelimited(text: string, delimiter: string): ImportCell[][] {
  const rows: ImportCell[][] = []
  let row: ImportCell[] = []
  let cell = ''
  let quoted = false
  let i = 0
  const endCell = () => {
    const value = cell.trim()
    row.push(value === '' ? null : value)
    cell = ''
  }
  const endRow = () => {
    endCell()
    rows.push(row)
    row = []
  }
  while (i < text.length) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      cell += ch
      i++
      continue
    }
    if (ch === '"' && cell.trim() === '') {
      quoted = true
      cell = ''
      i++
      continue
    }
    if (ch === delimiter) {
      endCell()
      i++
      continue
    }
    if (ch === '\r' || ch === '\n') {
      endRow()
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
      continue
    }
    cell += ch
    i++
  }
  if (cell !== '' || row.length > 0) endRow()
  return rows
}

/** SHA-256 of bytes, in hex (the browser's Web Crypto). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** A spreadsheet's cell as the importer reads it: text, a number (a day is its serial), or null. */
function cellOf(value: unknown): ImportCell {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  const text = String(value).trim()
  return text === '' ? null : text
}

/**
 * Reads a spreadsheet's sheet (the first, or `sheet`) with SheetJS, loaded now: a workbook's bytes, or
 * the text of an HTML or XML 2003 one (decoded here, so its Arabic is read as the file wrote it).
 */
async function readWorkbook(
  data: Uint8Array | string,
  sheet: string | null,
): Promise<{ sheets: string[]; sheet: string; rows: ImportCell[][] }> {
  const XLSX = await import('xlsx')
  const book = XLSX.read(data, {
    type: typeof data === 'string' ? 'string' : 'array',
    // Dates stay serial numbers and numbers stay numbers: the importer reads both itself (the day's
    // number format is kept, `z`, to tell a day from a number in a 1904 workbook).
    cellDates: false,
    cellText: false,
    cellNF: true,
    dense: true,
    // The cells a sheet holds make its range, never the range it declares; no more rows than read.
    nodim: true,
    sheetRows: IMPORT_SHEET_ROWS_MAX + 1,
    // The text of an HTML or XML workbook stays text (never a US day guessed from "08/10/2026").
    raw: true,
  })
  const sheets = book.SheetNames
  const name = sheet !== null && sheets.includes(sheet) ? sheet : sheets[0]
  if (name === undefined) throw new FileReadError('empty')
  const ws = book.Sheets[name]!
  if (ws['!fullref'] || !ws['!ref']) {
    if (ws['!fullref']) throw new FileReadError('too_large')
    throw new FileReadError('empty')
  }
  const range = XLSX.utils.decode_range(ws['!ref'])
  if (range.e.r - range.s.r + 1 > IMPORT_SHEET_ROWS_MAX) throw new FileReadError('too_large')
  if (range.e.c >= IMPORT_SHEET_COLUMNS_MAX) {
    range.e.c = IMPORT_SHEET_COLUMNS_MAX - 1
    ws['!ref'] = XLSX.utils.encode_range(range)
  }
  // Each cell's own value (never a Date made of a day's number format). Excel for Mac's 1904 date
  // system counts its serial days 1,462 fewer than the 1900 system's the importer reads.
  const date1904 = book.Workbook?.WBProps?.date1904 === true
  const cells = ws['!data'] ?? []
  const rows: ImportCell[][] = []
  for (let r = range.s.r; r <= range.e.r; r++) {
    const source = cells[r]
    if (!source) {
      rows.push([])
      continue
    }
    const row: ImportCell[] = []
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = source[c]
      if (!cell || cell.t === 'e' || cell.t === 'z') row.push(null)
      else if (
        date1904 &&
        cell.t === 'n' &&
        typeof cell.v === 'number' &&
        typeof cell.z === 'string' &&
        XLSX.SSF.is_date(cell.z)
      ) {
        row.push(cellOf(cell.v + DAYS_1904))
      } else row.push(cellOf(cell.v))
    }
    rows.push(row)
  }
  return { sheets, sheet: name, rows }
}

/** Reads a picked file (see above); `sheet` picks a spreadsheet's other sheet. */
export async function readImportFile(file: File, sheet: string | null = null): Promise<FileRead> {
  if (file.size > IMPORT_FILE_MAX_BYTES) throw new FileReadError('too_large')
  if (file.size === 0) throw new FileReadError('empty')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const kind = kindOf(file.name, bytes)
  // A file named as a spreadsheet that is not one is unreadable ("save it again"), not unknown.
  if (kind === null) {
    throw new FileReadError(isSpreadsheetName(file.name) ? 'unreadable' : 'not_supported')
  }
  const hash = await sha256Hex(bytes)
  if (kind === 'csv') {
    const { text, encoding } = decodeText(bytes)
    const delimiter = detectDelimiter(text)
    const rows = parseDelimited(text, delimiter)
    if (rows.every((r) => r.every((c) => c === null))) throw new FileReadError('empty')
    return {
      name: file.name,
      size: file.size,
      hash,
      kind,
      encoding,
      delimiter,
      sheets: [],
      sheet: null,
      rows,
    }
  }
  // A workbook that would unzip past the bound is refused before it is unzipped (a zip bomb).
  if (kind === 'xlsx' && unzippedSize(bytes) > IMPORT_UNZIPPED_MAX_BYTES) {
    throw new FileReadError('too_large')
  }
  try {
    const book = await readWorkbook(kind === 'markup' ? decodeText(bytes).text : bytes, sheet)
    if (book.rows.every((r) => r.every((c) => c === null))) throw new FileReadError('empty')
    return {
      name: file.name,
      size: file.size,
      hash,
      kind,
      encoding: null,
      delimiter: null,
      sheets: book.sheets,
      sheet: book.sheet,
      rows: book.rows,
    }
  } catch (error) {
    if (error instanceof FileReadError) throw error
    throw new FileReadError('unreadable')
  }
}
