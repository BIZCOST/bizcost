import type Decimal from 'decimal.js'
import { fixed, toDec } from '../numbers/decimal'
import type { Money, Percent, Quantity } from '../numbers/kinds'
import { currencyMinorUnit, type CurrencyCode } from '../numbers/rounding'

// Line maths of quotations, invoices, orders and purchases (docs/PRODUCT.md, the owner's spec §27):
// qty × unit price = subtotal; the discount (% or a fixed amount) comes off BEFORE VAT; VAT is on
// what is left. Each amount of a line is rounded half away from zero to the currency's minor unit
// as it is computed, so a line's figures always add up as printed:
//   subtotal = round(qty × unitPrice)
//   discount = round(subtotal × percent / 100)   or   round(fixed amount)
//   net      = subtotal − discount               (the taxable amount)
//   vat      = round(net × vatRate / 100)
//   total    = net + vat

/** A line discount: a percentage of the subtotal, or a fixed amount. */
export type LineDiscount = { percent: Percent } | { amount: Money }

export interface LineInput {
  readonly qty: Quantity
  readonly unitPrice: Money
  readonly discount?: LineDiscount | null
  /** VAT rate in percent (5 for the UAE standard rate, 0 when zero-rated or not VAT registered). */
  readonly vatRate: Percent
}

/** A line's amounts, each with exactly the currency's minor-unit digits ("31.50"). */
export interface LineAmounts {
  readonly subtotal: Money
  readonly discount: Money
  readonly net: Money
  readonly vat: Money
  readonly total: Money
}

export type LineError =
  | 'negative_quantity'
  | 'negative_price'
  | 'negative_discount'
  | 'discount_over_100_percent'
  | 'discount_over_subtotal'
  | 'negative_vat_rate'

/** The first problem with a line's input (for a form message), or null when it can be computed. */
export function lineError(input: LineInput, currency: CurrencyCode): LineError | null {
  if (toDec(input.qty).lt(0)) return 'negative_quantity'
  if (toDec(input.unitPrice).lt(0)) return 'negative_price'
  if (toDec(input.vatRate).lt(0)) return 'negative_vat_rate'
  const discount = input.discount
  if (!discount) return null
  const value = toDec('percent' in discount ? discount.percent : discount.amount)
  if (value.lt(0)) return 'negative_discount'
  if ('percent' in discount) return value.gt(100) ? 'discount_over_100_percent' : null
  const subtotal = toDec(input.qty).times(toDec(input.unitPrice))
  const digits = currencyMinorUnit(currency)
  return toDec(fixed(value, digits)).gt(toDec(fixed(subtotal, digits)))
    ? 'discount_over_subtotal'
    : null
}

/** A line's amounts (see the formulas above). Throws RangeError when lineError finds a problem. */
export function computeLine(input: LineInput, currency: CurrencyCode): LineAmounts {
  const error = lineError(input, currency)
  if (error) throw new RangeError(`Invalid line: ${error}`)
  const digits = currencyMinorUnit(currency)
  const round = (value: Decimal) => toDec(fixed(value, digits))

  const subtotal = round(toDec(input.qty).times(toDec(input.unitPrice)))
  const discount = !input.discount
    ? toDec('0')
    : 'percent' in input.discount
      ? round(subtotal.times(toDec(input.discount.percent)).dividedBy(100))
      : round(toDec(input.discount.amount))
  const net = subtotal.minus(discount)
  const vat = round(net.times(toDec(input.vatRate)).dividedBy(100))
  const print = (value: Decimal) => fixed(value, digits) as Money
  return {
    subtotal: print(subtotal),
    discount: print(discount),
    net: print(net),
    vat: print(vat),
    total: print(net.plus(vat)),
  }
}
