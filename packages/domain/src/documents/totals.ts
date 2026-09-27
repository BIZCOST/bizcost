import type Decimal from 'decimal.js'
import { fixed, toDec } from '../numbers/decimal'
import type { Money } from '../numbers/kinds'
import { currencyMinorUnit, type CurrencyCode } from '../numbers/rounding'
import type { LineAmounts } from './line'

// Document totals are sums of the rounded line amounts (never re-rounded from unrounded maths), so
// the printed lines always add up to the printed totals.

/** A document's totals, each with exactly the currency's minor-unit digits. */
export interface DocumentTotals {
  /** Sum of the line subtotals (qty × unit price). */
  readonly subtotal: Money
  /** Sum of the line discounts. */
  readonly discount: Money
  /** Taxable amount: subtotal − discount. */
  readonly net: Money
  /** Sum of the line VAT. */
  readonly vat: Money
  /** net + vat. */
  readonly total: Money
}

/** Totals of a document's computed lines. */
export function documentTotals(
  lines: readonly LineAmounts[],
  currency: CurrencyCode,
): DocumentTotals {
  const digits = currencyMinorUnit(currency)
  const sum = (pick: (line: LineAmounts) => string) =>
    lines.reduce((acc, line) => acc.plus(toDec(pick(line))), toDec('0'))
  const net = sum((line) => line.net)
  const vat = sum((line) => line.vat)
  const print = (value: Decimal) => fixed(value, digits) as Money
  return {
    subtotal: print(sum((line) => line.subtotal)),
    discount: print(sum((line) => line.discount)),
    net: print(net),
    vat: print(vat),
    total: print(net.plus(vat)),
  }
}
