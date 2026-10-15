import { Dec, plain } from '../../numbers/decimal'
import { normalizeDigits } from '../../numbers/digits'
import { parseNumber } from '../../numbers/parse'
import type { ImportCell } from './headers'

// Values of a sales file (M3 Step 4): amounts and quantities through parseNumber (Arabic-Indic digits,
// ٫ and ٬, thousands in groups of three), with what exports add around them: a currency ("AED",
// "Dhs", «د.إ», «درهم»), "(12.00)" for a negative, a trailing minus ("12.00-"); spreadsheet numbers
// as the 15 significant digits a spreadsheet shows. Days: dd/mm/yyyy unless the file says otherwise
// (a day above 12 in the second place reads mm/dd), ISO yyyy-mm-dd, "8 Oct 2026", and spreadsheet
// serial days; a time after the day is dropped. A file whose every day reads both ways is reported as
// ambiguous, read as dd/mm until the person says otherwise.

const CURRENCY = /(?:aed|dhs|dh|د\.?\s?إ|درهم|دراهم)\.?/giu
const SPACES = /[\s\u00a0\u202f]+/gu
const DIRECTION_MARKS = /[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/gu

export type ImportNumberError = 'invalid'

/**
 * A number of a file as a canonical decimal string; null for an empty cell. A spreadsheet number is
 * taken at 15 significant digits (what the spreadsheet shows: 0.1 + 0.2 is 0.3).
 */
export function importNumber(
  cell: ImportCell | undefined,
): { ok: true; value: string | null } | { ok: false; error: ImportNumberError } {
  if (cell === null || cell === undefined) return { ok: true, value: null }
  if (typeof cell === 'number') {
    if (!Number.isFinite(cell)) return { ok: false, error: 'invalid' }
    return { ok: true, value: plain(new Dec(cell).toSignificantDigits(15, Dec.ROUND_HALF_UP)) }
  }
  let text = cell.replace(DIRECTION_MARKS, '').replace(CURRENCY, '').replace(SPACES, '')
  if (text === '' || text === '-' || text === '−') return { ok: true, value: null }
  let negative = false
  const bracketed = /^\((.*)\)$/u.exec(text)
  if (bracketed) {
    negative = true
    text = bracketed[1] ?? ''
  }
  const trailing = /^(.*[\d٠-٩۰-۹])[-−]$/u.exec(text)
  if (trailing) {
    negative = !negative
    text = trailing[1] ?? ''
  }
  const parsed = parseNumber(text)
  if (!parsed.ok) return { ok: false, error: 'invalid' }
  if (!negative) return { ok: true, value: parsed.value }
  return { ok: true, value: plain(new Dec(parsed.value).negated()) }
}

/** The order of day and month in a file's days (`ymd` is always read as such). */
export const DATE_ORDERS = ['dmy', 'mdy'] as const
export type DateOrder = (typeof DATE_ORDERS)[number]

export type ImportDateResult =
  | { ok: true; date: string; /** Both dd/mm and mm/dd read as a day. */ ambiguous: boolean }
  | { ok: false; error: 'invalid' | 'missing' }

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
  يناير: 1,
  فبراير: 2,
  مارس: 3,
  أبريل: 4,
  ابريل: 4,
  مايو: 5,
  يونيو: 6,
  يوليو: 7,
  أغسطس: 8,
  اغسطس: 8,
  سبتمبر: 9,
  أكتوبر: 10,
  اكتوبر: 10,
  نوفمبر: 11,
  ديسمبر: 12,
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function isoOf(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 9999 || month < 1 || month > 12) return null
  if (day < 1 || day > daysInMonth(year, month)) return null
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

const twoDigitYear = (year: number, text: string) => (text.length <= 2 ? 2000 + year : year)

/** The first and last serial days a spreadsheet date may be (1900-01-01 … 9999-12-31). */
const SERIAL_MIN = 1
const SERIAL_MAX = 2_958_465
const DAY_MS = 86_400_000
/** Day 0 of the 1900 date system as spreadsheets count it (they hold 29 Feb 1900 as day 60). */
const SERIAL_EPOCH = Date.UTC(1899, 11, 30)

/** A spreadsheet's serial day (its time of day dropped). */
export function serialDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < SERIAL_MIN || serial > SERIAL_MAX) return null
  const whole = Math.floor(serial)
  // Days before 1 Mar 1900 count from one day later (the 1900 leap-year error kept by spreadsheets).
  const days = whole < 61 ? whole + 1 : whole
  return new Date(SERIAL_EPOCH + days * DAY_MS).toISOString().slice(0, 10)
}

/**
 * The first day a file's day may be: a sale before 2000 is a misread (a "Day" column of 1, 2, 3 read
 * as spreadsheet serials would be January 1900).
 */
export const IMPORT_DAY_MIN = '2000-01-01'

/** A time after the day, with its offset from UTC when it says one ("14:32", "2:32 PM", "T14:32:00Z"). */
const TIME =
  /(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:\s*([AP]M))?(?:\s*(Z|[+-]\d{2}:?\d{2}))?)$/iu

/** YYYY-MM-DD of an instant in a time zone (IANA). */
function dayIn(instant: number, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(instant))
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
    return `${part('year')}-${part('month')}-${part('day')}`
  } catch {
    return null
  }
}

/** The day a date and a time with an offset from UTC fall on in `timeZone` (the business's). */
function shiftedDay(date: string, time: RegExpExecArray, timeZone: string): string {
  const offset = time[5]!.toUpperCase()
  const raw = Number(time[1])
  const meridiem = time[4]?.toUpperCase()
  const hours = meridiem === 'PM' ? (raw % 12) + 12 : meridiem === 'AM' ? raw % 12 : raw
  const digits = offset.replace(/[^\d]/gu, '')
  const offsetMinutes =
    offset === 'Z'
      ? 0
      : (offset.startsWith('-') ? -1 : 1) *
        (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)))
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const instant =
    Date.UTC(y, m - 1, d, hours, Number(time[2]), Number(time[3] ?? 0)) - offsetMinutes * 60_000
  return dayIn(instant, timeZone) ?? date
}

/**
 * A day of a file as YYYY-MM-DD: a spreadsheet serial, ISO, day and month in `order`, or a month by
 * name; never before IMPORT_DAY_MIN. `missing` for an empty cell. A time after the day is dropped,
 * unless it says its offset from UTC ("…T21:30:00Z", "… +00:00") and `timeZone` (the business's) is
 * given: the day is then the business's day at that moment (21:30 UTC is the next day in Dubai).
 */
export function importDate(
  cell: ImportCell | undefined,
  order: DateOrder,
  timeZone: string | null = null,
): ImportDateResult {
  const result = readDate(cell, order, timeZone)
  if (result.ok && result.date < IMPORT_DAY_MIN) return { ok: false, error: 'invalid' }
  return result
}

function readDate(
  cell: ImportCell | undefined,
  order: DateOrder,
  timeZone: string | null,
): ImportDateResult {
  if (cell === null || cell === undefined) return { ok: false, error: 'missing' }
  if (typeof cell === 'number') {
    const date = serialDate(cell)
    return date ? { ok: true, date, ambiguous: false } : { ok: false, error: 'invalid' }
  }
  const trimmed = normalizeDigits(cell.replace(DIRECTION_MARKS, '')).trim()
  const time = TIME.exec(trimmed)
  const text = (time ? trimmed.slice(0, time.index) : trimmed).trim()
  const day = readDay(text, order)
  if (day.ok && time?.[5] && timeZone !== null) {
    return { ...day, date: shiftedDay(day.date, time, timeZone) }
  }
  return day
}

/** The day part of a cell's text (its time taken off). */
function readDay(text: string, order: DateOrder): ImportDateResult {
  if (text === '') return { ok: false, error: 'missing' }
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/u.exec(text)
  if (iso) {
    const date = isoOf(Number(iso[1]), Number(iso[2]), Number(iso[3]))
    return date ? { ok: true, date, ambiguous: false } : { ok: false, error: 'invalid' }
  }
  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/u.exec(text)
  if (numeric) {
    const a = Number(numeric[1])
    const b = Number(numeric[2])
    const year = twoDigitYear(Number(numeric[3]), numeric[3] ?? '')
    const dmy = isoOf(year, b, a)
    const mdy = isoOf(year, a, b)
    const date = order === 'dmy' ? (dmy ?? mdy) : (mdy ?? dmy)
    if (!date) return { ok: false, error: 'invalid' }
    return { ok: true, date, ambiguous: dmy !== null && mdy !== null && dmy !== mdy }
  }
  // "8 Oct 2026", "08-Oct-26", "Oct 8, 2026", «8 أكتوبر 2026».
  const words = text
    .replace(/,/gu, ' ')
    .split(/[\s\-/.]+/u)
    .filter(Boolean)
  if (words.length === 3) {
    const monthAt = words.findIndex((w) => MONTHS[w.toLowerCase()] !== undefined)
    if (monthAt === 0 || monthAt === 1) {
      const month = MONTHS[words[monthAt]!.toLowerCase()]!
      const day = Number(words[monthAt === 0 ? 1 : 0])
      const yearText = words[2]!
      const date = /^\d+$/u.test(yearText)
        ? isoOf(twoDigitYear(Number(yearText), yearText), month, day)
        : null
      return date ? { ok: true, date, ambiguous: false } : { ok: false, error: 'invalid' }
    }
  }
  return { ok: false, error: 'invalid' }
}

/**
 * The order of day and month a file's days say themselves: `mdy` when some day reads only as mm/dd
 * (a second part above 12), `dmy` otherwise; `ambiguous` when every day read both ways (03/04/2026
 * and no day above 12), so the person is asked.
 */
export function dateOrderOf(cells: readonly ImportCell[]): {
  order: DateOrder
  ambiguous: boolean
} {
  let dmyOnly = false
  let mdyOnly = false
  let ambiguous = false
  for (const cell of cells) {
    if (typeof cell !== 'string') continue
    const dmy = importDate(cell, 'dmy')
    const mdy = importDate(cell, 'mdy')
    if (!dmy.ok && !mdy.ok) continue
    if (dmy.ok && dmy.ambiguous) ambiguous = true
    else if (dmy.ok && mdy.ok && dmy.date !== mdy.date) ambiguous = true
    // dd/mm only: the first part above 12 (25/10/2026); mm/dd only: the second (10/25/2026).
    const parts = /^(\d{1,2})[-/.](\d{1,2})[-/.]/u.exec(normalizeDigits(cell.trim()))
    if (parts) {
      if (Number(parts[1]) > 12) dmyOnly = true
      if (Number(parts[2]) > 12) mdyOnly = true
    }
  }
  if (mdyOnly && !dmyOnly) return { order: 'mdy', ambiguous: false }
  if (dmyOnly) return { order: 'dmy', ambiguous: false }
  return { order: 'dmy', ambiguous }
}
