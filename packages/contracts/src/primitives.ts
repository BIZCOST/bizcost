import { normalizeDigits } from '@bizcost/domain'
import { z } from 'zod'

// Wire primitives (docs/ARCHITECTURE.md §API & request flow): plain JSON, decimals as strings,
// business dates as YYYY-MM-DD. Each is a shared schema instance; tag a copy with sensitive(), never
// the instance itself.

/** A UUID in 8-4-4-4-12 hex form, any version (auth user ids are v4, row ids v7); output lowercase. */
export const zUuid = z.guid().toLowerCase()

const ARABIC_DECIMAL_SEPARATOR = /٫/g // U+066B
const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/

/** Longest accepted decimal string; the widest column, numeric(28,12), needs 30 characters. */
export const DECIMAL_MAX_LENGTH = 40

/**
 * A decimal number as a string ("12", "-0.125"). JSON numbers are rejected: money and quantities are
 * never JS floats. Arabic-Indic digits and the Arabic decimal separator (٫) are normalized; exponents,
 * a leading "+", group separators and bare "." forms (".5", "5.") are rejected.
 */
export const zDecimal = z
  .string()
  .trim()
  .overwrite((value) => normalizeDigits(value).replace(ARABIC_DECIMAL_SEPARATOR, '.'))
  .max(DECIMAL_MAX_LENGTH)
  .regex(DECIMAL_PATTERN)

/** The local business day of a document: a real calendar date as YYYY-MM-DD. */
export const zBusinessDate = z.iso.date()
