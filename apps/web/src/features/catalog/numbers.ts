import {
  checkDecimal,
  compareDecimal,
  normalizeDigits,
  parseNumber,
  type DecimalKind,
} from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'

// Numbers typed into the catalog forms, in either language: Arabic-Indic digits, ٫ and grouping
// commas are read by the domain's parseNumber (D-107) into the decimal string the API takes. Each
// problem is a message key for the field.

/** A problem of a field: a message key and the values it names. */
export interface FieldError {
  readonly key: I18nKey
  readonly values?: Readonly<Record<string, unknown>>
  /** Names the message shows as `{{chain}}`, joined by the language's arrow (a loop of packs). */
  readonly chain?: readonly string[]
}

export type ReadNumber = { ok: true; value: string } | { ok: false; error: FieldError }

const REQUIRED: FieldError = { key: 'catalog.numbers.required' }
const INVALID: FieldError = { key: 'catalog.numbers.invalid' }

/** A number that must fit the column of `kind` (decimals and size). */
function read(input: string, kind: DecimalKind): ReadNumber {
  const parsed = parseNumber(input)
  if (!parsed.ok) return { ok: false, error: parsed.error === 'required' ? REQUIRED : INVALID }
  const fits = checkDecimal(parsed.value, kind)
  if (fits === 'too_many_decimals') {
    return { ok: false, error: { key: 'catalog.numbers.tooManyDecimals' } }
  }
  if (fits) return { ok: false, error: { key: 'catalog.numbers.tooLarge' } }
  return { ok: true, value: parsed.value }
}

/** How many of a unit one pack or conversion holds: more than zero, numeric(28,12). */
export function readFactor(input: string): ReadNumber {
  const result = read(input, 'unitCost')
  if (result.ok && compareDecimal(result.value, '0') <= 0) {
    return { ok: false, error: { key: 'catalog.numbers.positive' } }
  }
  return result
}

/** A usual price: empty for none (null), else zero or more, numeric(20,4). */
export function readPrice(input: string): { ok: true; value: string | null } | ReadNumber {
  if (input.trim() === '') return { ok: true, value: null }
  const result = read(input, 'money')
  if (result.ok && compareDecimal(result.value, '0') < 0) {
    return { ok: false, error: { key: 'catalog.numbers.notNegative' } }
  }
  return result
}

/**
 * A number as typed, with Latin digits once it reads (D-067: the screens show Latin digits in both
 * languages): "١٬٢٥٠" → "1,250", "١٨٫٥" → "18.5". What does not read stays as typed, for its message.
 */
export function withLatinDigits(input: string): string {
  if (!parseNumber(input).ok) return input
  // ٫ (U+066B) is the Arabic decimal separator, ٬ (U+066C) the Arabic thousands separator.
  return normalizeDigits(input)
    .replace(/\u066b/g, '.')
    .replace(/\u066c/g, ',')
    .trim()
}
