import type Decimal from 'decimal.js'
import { Dec, exactProduct, fixed, plain, pow10, toDec } from '../numbers/decimal'

// Splitting one document amount over lines (D-114 rule 4, D-120 rule 3, D-142): a document
// discount, the delivery charged on the same invoice, or a credit note entered as one amount.
// Largest remainder: each line's exact share (the amount × its weight ÷ the total weight) is cut
// down to the currency's minor unit, and the minor units still missing go one each to the lines that
// lost the most in that cut (on a tie the larger weight, then the first line). So the shares always
// add up to the amount exactly, each is within one minor unit of its exact share, and when the
// amount is not more than the weights (money amounts in the same minor unit) no share is below zero
// or above its line's weight.

/**
 * Shares of `amount` in proportion to `weights` (same order), each with `digits` decimals. Weights
 * must not be negative; when they are all zero the amount is split equally. Throws RangeError for a
 * negative amount or weight, an amount with more than `digits` decimals, or an empty list with a
 * non-zero amount.
 */
export function splitByWeights(
  amount: string,
  weights: readonly string[],
  digits: number,
): string[] {
  const total = toDec(amount)
  if (total.lt(0)) throw new RangeError(`A split amount must not be negative: "${amount}"`)
  if (total.decimalPlaces() > digits) {
    throw new RangeError(`A split amount has more than ${digits} decimals: "${amount}"`)
  }
  const values = weights.map((w) => {
    const value = toDec(w)
    if (value.lt(0)) throw new RangeError(`A split weight must not be negative: "${w}"`)
    return value
  })
  if (values.length === 0) {
    if (!total.isZero()) throw new RangeError('Nothing to split the amount over')
    return []
  }
  const sum = values.reduce((acc, value) => acc.plus(value), toDec('0'))
  const exact: Decimal[] = values.map((value) =>
    sum.isZero() ? total.dividedBy(values.length) : exactProduct([total, value]).dividedBy(sum),
  )
  // Each share cut down to the minor unit (never below zero: neither the amount nor a weight is).
  const parts = exact.map((share) => share.toDecimalPlaces(digits, Dec.ROUND_DOWN))
  const unit = pow10(-digits)
  // Fewer minor units than lines are missing (each line lost less than one in the cut); they go to
  // the lines that lost the most, one each.
  const order = values
    .map((value, index) => ({ index, value, lost: exact[index]!.minus(parts[index]!) }))
    .sort((a, b) => b.lost.comparedTo(a.lost) || b.value.comparedTo(a.value) || a.index - b.index)
  let missing = total.minus(parts.reduce((acc, part) => acc.plus(part), toDec('0')))
  for (let k = 0; missing.gt(0); k = (k + 1) % order.length) {
    const index = order[k]!.index
    parts[index] = parts[index]!.plus(unit)
    missing = missing.minus(unit)
  }
  return parts.map((part) => fixed(part, digits))
}

/** Sum of decimal strings, as a plain decimal string. */
export function sumDecimals(values: readonly string[]): string {
  return plain(values.reduce((acc, value) => acc.plus(toDec(value)), toDec('0')))
}

/**
 * `value` × `part` ÷ `whole` (an exact product divided once), rounded half away from zero to `places`
 * decimals: the share of a line that a return takes (its base quantity to 6 decimals, its amounts to
 * the currency's minor unit). Throws RangeError when `whole` is not more than zero.
 */
export function proportionOf(value: string, part: string, whole: string, places: number): string {
  const divisor = toDec(whole)
  if (!divisor.gt(0)) throw new RangeError(`Nothing to take a share of: "${whole}"`)
  return fixed(exactProduct([toDec(value), toDec(part)]).dividedBy(divisor), places)
}

/** `value` − each of `minus`, as a plain decimal string (exact). */
export function subtractDecimals(value: string, ...minus: readonly string[]): string {
  return plain(minus.reduce((acc, m) => acc.minus(toDec(m)), toDec(value)))
}
