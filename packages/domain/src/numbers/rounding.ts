import { fixed, plain, roundHalfUp, toDec } from './decimal'
import { COST_SCALE, type CostAmount, type Money } from './kinds'

// The two rounding policies (D-033, docs/ARCHITECTURE.md §Numbers, money, units & time):
// 1. Documents (purchase, sale and invoice lines; VAT): to the currency's minor unit.
// 2. Cost engine (unit cost, recipes, WAC): never to the currency. Values keep COST_SCALE (12)
//    decimals, the scale of their numeric(28,12) columns, and are rounded only for display.
//
// Every rounding here is half away from zero: 1.005 → 1.01 and −1.005 → −1.01. A credit note is then
// the exact mirror of its invoice (round(−x) = −round(x)), and the result matches Postgres round()
// on numeric and the digits the app shows (@bizcost/i18n formatCurrency).

/** ISO 4217 minor-unit digits of the currencies BizCost supports (AED in M1). */
export const CURRENCY_MINOR_UNITS = {
  AED: 2,
  SAR: 2,
  QAR: 2,
  KWD: 3,
  BHD: 3,
  OMR: 3,
  USD: 2,
  EUR: 2,
} as const

export type CurrencyCode = keyof typeof CURRENCY_MINOR_UNITS

export function isCurrencyCode(value: string): value is CurrencyCode {
  return Object.hasOwn(CURRENCY_MINOR_UNITS, value)
}

/** Digits after the decimal point for `currency` (AED 2, KWD 3). Throws RangeError if unsupported. */
export function currencyMinorUnit(currency: CurrencyCode): number {
  if (!isCurrencyCode(currency)) throw new RangeError(`Unsupported currency: "${currency}"`)
  return CURRENCY_MINOR_UNITS[currency]
}

/**
 * A document amount rounded half away from zero to the currency's minor unit, printed with exactly
 * that many decimals: roundDocument('1.005', 'AED') = '1.01', roundDocument('-0.0005', 'KWD') =
 * '-0.001'.
 */
export function roundDocument(amount: string, currency: CurrencyCode): Money {
  return fixed(toDec(amount), currencyMinorUnit(currency)) as Money
}

/**
 * Whether a document amount typed by a person has at most the currency's minor-unit decimals
 * (trailing zeros are fine): fitsCurrency('10.50', 'AED') is true, fitsCurrency('10.005', 'AED')
 * false. An amount that doesn't fit is refused, never rounded silently (D-142).
 */
export function fitsCurrency(amount: string, currency: CurrencyCode): boolean {
  return toDec(amount).decimalPlaces() <= currencyMinorUnit(currency)
}

/** A cost-engine value at COST_SCALE (12) decimals, as its numeric(28,12) column stores it. */
export function roundCost(value: string): CostAmount {
  return plain(roundHalfUp(toDec(value), COST_SCALE)) as CostAmount
}

/**
 * A value rounded half away from zero for display, with exactly `places` decimals
 * (roundForDisplay('0.0066666', 4) = '0.0067'). Format the result with @bizcost/i18n.
 */
export function roundForDisplay(value: string, places: number): string {
  if (!Number.isInteger(places) || places < 0) throw new RangeError(`Bad places: ${places}`)
  return fixed(toDec(value), places)
}
