import type { Locale } from '@bizcost/domain'
import Decimal from 'decimal.js'
import { intlLocale } from './locale'

// Display formatting with Intl (docs/ARCHITECTURE.md §Numbers and §i18n & RTL). Amounts arrive as
// decimal strings: they are rounded with decimal.js to the digits shown, then passed to Intl with
// min = max fraction digits, because Hermes may turn a numeric string into a float.

type DecimalString = Intl.StringNumericLiteral

/** Rounds half up (away from zero) to `digits` places, as a plain decimal string. */
function roundHalfUp(value: string, digits: number): DecimalString {
  return new Decimal(value)
    .toDecimalPlaces(digits, Decimal.ROUND_HALF_UP)
    .toString() as DecimalString
}

/** Counts and other plain numbers (never money: use formatDecimal / formatCurrency). */
export function formatNumber(
  locale: Locale,
  value: number | bigint,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(intlLocale(locale), options).format(value)
}

/** A decimal string shown with exactly `fractionDigits` digits (e.g. quantities, percentages). */
export function formatDecimal(locale: Locale, value: string, fractionDigits: number): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(roundHalfUp(value, fractionDigits))
}

/** Digits of a currency's minor unit (AED 2, KWD 3, JPY 0), from the Intl currency data. */
export function currencyDigits(currency: string): number {
  return (
    new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  )
}

/** An amount (decimal string) in `currency` (ISO 4217, e.g. the business currency AED). */
export function formatCurrency(locale: Locale, amount: string, currency: string): string {
  const digits = currencyDigits(currency)
  return new Intl.NumberFormat(intlLocale(locale), {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(roundHalfUp(amount, digits))
}

/** Most decimals a unit cost shows (a price per ml or per gram can be a tiny amount). */
const UNIT_COST_MAX_DIGITS = 6

/**
 * A cost or price per unit (decimal string, often 12 decimals) in `currency`: with the currency's
 * digits, or, below one, with as many more as it takes to show two significant digits (up to 6), so
 * a price per ml or per gram never reads as 0.00: 6.666666666667 → AED 6.67, 0.006666666667 → AED
 * 0.0067, 0.05 → AED 0.050. Rounded half up like formatCurrency.
 */
export function formatUnitCost(locale: Locale, amount: string, currency: string): string {
  const minor = currencyDigits(currency)
  const value = new Decimal(amount).abs()
  let digits = minor
  if (value.gt(0) && value.lt(1)) {
    // Zeros after the point before the first significant digit (0.0066 → 2).
    const zeros = -value.e - 1
    digits = Math.min(UNIT_COST_MAX_DIGITS, Math.max(minor, zeros + 2))
  }
  return new Intl.NumberFormat(intlLocale(locale), {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(roundHalfUp(amount, digits))
}

/**
 * How `currency` is written in `locale`, as formatCurrency writes it: "AED" in English, «د.إ.» in
 * Arabic. For a field's prefix, so the field and the lists show the same symbol.
 */
export function currencySymbol(locale: Locale, currency: string): string {
  const format = new Intl.NumberFormat(intlLocale(locale), { style: 'currency', currency })
  if (typeof format.formatToParts !== 'function') return currency
  return format.formatToParts(0).find((part) => part.type === 'currency')?.value ?? currency
}

/** A date or timestamp (Date or ISO string). Pass `timeZone` so server and browser agree. */
export function formatDate(
  locale: Locale,
  value: Date | string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  return new Intl.DateTimeFormat(intlLocale(locale), options).format(
    typeof value === 'string' ? new Date(value) : value,
  )
}

/** "a, b and c" in the locale's words (Intl.ListFormat; joined with commas where it is missing). */
export function formatList(locale: Locale, items: readonly string[]): string {
  if (typeof Intl.ListFormat !== 'function') return items.join(', ')
  return new Intl.ListFormat(intlLocale(locale), { style: 'long', type: 'conjunction' }).format(
    items,
  )
}
