import type Decimal from 'decimal.js'
import { exactProduct, roundHalfUp, toDec } from '../numbers/decimal'

// The VAT in an amount typed with it (a price that includes VAT, D-121): amount × rate ÷ (100 + rate),
// an exact product divided once and rounded once, half away from zero, to the currency's minor unit;
// what is before VAT is the rest. 105 including 5 % is 100 + 5. Purchases take it out of each amount
// as they compute it (the supplier's document, D-107); sales take it out of each VAT rate's total
// once (sale.ts, D-220).

/** The VAT in `gross` at `rate` percent: round(gross × rate ÷ (100 + rate)) to `digits` decimals. */
export function vatIn(gross: Decimal, rate: string, digits: number): Decimal {
  const r = toDec(rate)
  return roundHalfUp(exactProduct([gross, r]).dividedBy(r.plus(100)), digits)
}

/** The part of `gross` (typed with its VAT at `rate` percent) that is before VAT: gross − vatIn. */
export function beforeVat(gross: Decimal, rate: string, digits: number): Decimal {
  return gross.minus(vatIn(gross, rate, digits))
}
