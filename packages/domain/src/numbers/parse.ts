import { DECIMAL_PATTERN, plain, toDec } from './decimal'
import { normalizeDigits } from './digits'
import { checkDecimal, type DecimalCheckError, type DecimalKind, type DecimalKinds } from './kinds'

// What a person types into a number field, in either language (docs/ARCHITECTURE.md §Numbers,
// money, units & time). Accepted on top of the wire form that zDecimal accepts:
// - Arabic-Indic and Extended Arabic-Indic digits (normalizeDigits), and the Arabic decimal
//   separator ٫ (U+066B), as zDecimal also does;
// - thousands separators, "," or the Arabic ٬ (U+066C), only in groups of three ("1,234.5"). Any
//   other comma is refused, never guessed: "1,5" may mean 1.5 or 15;
// - the minus sign − (U+2212) and the direction marks (LRM, RLM, ALM) that copied Arabic numbers
//   carry.
// Still refused, as in zDecimal: exponents, a leading "+", bare dot forms (".5", "5."), spaces inside.
// The result is canonical wire form (no grouping, no leading or trailing zeros), which zDecimal
// accepts unchanged.

const DIRECTION_MARKS = /[\u200e\u200f\u061c]/g
const MINUS_SIGN = /\u2212/g
const ARABIC_DECIMAL_SEPARATOR = /\u066b/g
/**
 * Digits in groups of three, one kind of separator throughout ("1,234,567" or "1٬234٬567"). The
 * first group never starts with 0: "0,123" is more likely a decimal comma than 123.
 */
const GROUPED = /^-?[1-9]\d{0,2}([,\u066c])\d{3}(?:\1\d{3})*(?:\.\d+)?$/
const GROUP_SEPARATORS = /[,\u066c]/g
/** Longest input accepted, as zDecimal's DECIMAL_MAX_LENGTH (numeric(28,12) needs 30). */
const MAX_LENGTH = 40

export type ParseNumberError = 'required' | 'invalid' | Exclude<DecimalCheckError, 'invalid'>

export type ParseNumberResult<T extends string = string> =
  { ok: true; value: T } | { ok: false; error: ParseNumberError }

/**
 * Reads a number a person typed ("١٬٢٣٤٫٥", "1,234.50", "−3") into a canonical decimal string
 * ("1234.5"). With a `kind`, the value must also fit that kind's column (too_many_decimals,
 * too_large) and comes back branded. Range rules of a field (e.g. "more than zero") belong to its
 * form schema.
 */
export function parseNumber(input: string): ParseNumberResult
export function parseNumber<K extends DecimalKind>(
  input: string,
  kind: K,
): ParseNumberResult<DecimalKinds[K]>
export function parseNumber(input: string, kind?: DecimalKind): ParseNumberResult {
  const text = normalizeDigits(input)
    .replace(DIRECTION_MARKS, '')
    .replace(MINUS_SIGN, '-')
    .replace(ARABIC_DECIMAL_SEPARATOR, '.')
    .trim()
  if (text === '') return { ok: false, error: 'required' }
  const ungrouped = GROUPED.test(text) ? text.replace(GROUP_SEPARATORS, '') : text
  if (ungrouped.length > MAX_LENGTH || !DECIMAL_PATTERN.test(ungrouped)) {
    return { ok: false, error: 'invalid' }
  }
  const value = plain(toDec(ungrouped))
  const error = kind ? checkDecimal(value, kind) : null
  return error ? { ok: false, error } : { ok: true, value }
}
