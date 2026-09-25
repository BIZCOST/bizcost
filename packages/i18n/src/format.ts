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
