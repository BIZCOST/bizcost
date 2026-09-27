import Decimal from 'decimal.js'

// Internal decimal maths for the domain (docs/ARCHITECTURE.md §Numbers, money, units & time). Values
// enter and leave the domain as decimal strings; decimal.js does the arithmetic in between. Never a
// JS number: a float cannot hold 0.1 exactly.
//
// Dec is a private copy of the decimal.js constructor, so the global Decimal (used by @bizcost/i18n)
// keeps its own settings:
// - precision 64 significant digits: sums and products of the widest columns (numeric(28,12) ×
//   numeric(24,6)) stay exact, and a quotient carries 30+ digits beyond the 12 decimals we keep;
// - ROUND_DOWN (truncate) at that 64th digit, so rounding a quotient half up afterwards is never a
//   double rounding (a truncated value only reaches a ...5 tie when the exact value does);
// - plain notation from toString(), never an exponent (1e-7 prints as 0.0000001).
//
// Test signs with lt(0) / gt(0), never isNeg(): decimal.js reports "-0" (spreadsheets give "-0.00",
// and zDecimal passes it on) as negative.
//
// The truncation argument holds for ONE truncated operation. A chain (a factor that is itself a
// quotient, times a quantity) truncates twice, and a product of long factors passes 64 digits. So a
// result that multiplies several values and divides is computed as exactProduct(...) ÷ divisor: the
// numerator exact, one division, then one rounding.

export const Dec = Decimal.clone({
  precision: 64,
  rounding: Decimal.ROUND_DOWN,
  toExpNeg: -9e15,
  toExpPos: 9e15,
})

/** Multiplies without a digit limit; only exactProduct uses it (a division here would never end). */
const Exact = Decimal.clone({
  precision: 1e9,
  rounding: Decimal.ROUND_DOWN,
  toExpNeg: -9e15,
  toExpPos: 9e15,
})

/** The exact product of `values` (never truncated), as a Dec ready for one final division. */
export function exactProduct(values: readonly Decimal[]): Decimal {
  let result = new Exact(1)
  for (const value of values) result = result.times(value)
  return new Dec(result)
}

/** Wire form of a decimal: optional "-", digits, optional "." and digits (same as zDecimal). */
export const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/

/** A Decimal from a wire-form string. Throws RangeError for anything else ("1e5", "NaN", ".5"). */
export function toDec(value: string): Decimal {
  if (!DECIMAL_PATTERN.test(value)) throw new RangeError(`Not a decimal string: "${value}"`)
  return new Dec(value)
}

/** Canonical plain string: no exponent, no trailing zeros, never "-0". */
export function plain(value: Decimal): string {
  return value.isZero() ? '0' : value.toString()
}

/** Rounds half away from zero ("half up" for negatives too) to `places` decimals. */
export function roundHalfUp(value: Decimal, places: number): Decimal {
  return value.toDecimalPlaces(places, Decimal.ROUND_HALF_UP)
}

/** Rounds half away from zero to `places` decimals and prints exactly that many ("1.20"). */
export function fixed(value: Decimal, places: number): string {
  const [whole = '0', fraction = ''] = plain(roundHalfUp(value, places)).split('.')
  return places === 0 ? whole : `${whole}.${fraction.padEnd(places, '0')}`
}

/** 10 to the power `exponent` (exact): pow10(3) = 1000, pow10(-2) = 0.01. */
export function pow10(exponent: number): Decimal {
  return new Dec(10).toPower(exponent)
}

export function min(a: Decimal, b: Decimal): Decimal {
  return a.lte(b) ? a : b
}

export function max(a: Decimal, b: Decimal): Decimal {
  return a.gte(b) ? a : b
}

/** Numeric comparison of two decimal strings: -1, 0 or 1 ("1.50" equals "1.5"). */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  return toDec(a).comparedTo(toDec(b)) as -1 | 0 | 1
}
