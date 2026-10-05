import type { DiscountDto } from '@bizcost/contracts'
import type { LineDiscount, Money, Percent } from '@bizcost/domain'
import { readAmount, readPercent, type ReadNumber } from '../catalog/numbers'

// What the document forms share about a line (purchases since M2 Step 3, expenses since Step 5, sales
// since M3 Step 2): the VAT rates a person picks, and a discount as typed (a percentage or an amount,
// or none) read into the API's and the domain's shapes.

/**
 * The UAE's standard VAT rate (D-121), the one a tax invoice line of a VAT-registered business
 * starts with; the person can pick "No VAT" on a line.
 */
export const STANDARD_VAT_RATE = '5'
export const NO_VAT = '0'

export type DiscountKind = 'none' | 'percent' | 'amount'

/** A stored discount as the form holds it (its kind and the number as text). */
export function discountDraft(discount: DiscountDto | null | undefined): {
  discountKind: DiscountKind
  discount: string
} {
  if (!discount) return { discountKind: 'none', discount: '' }
  return 'percent' in discount
    ? { discountKind: 'percent', discount: discount.percent }
    : { discountKind: 'amount', discount: discount.amount }
}

/** A typed discount read as a number (null: none). */
export function discountOf(kind: DiscountKind, value: string): ReadNumber | null {
  if (kind === 'none') return null
  return kind === 'percent' ? readPercent(value) : readAmount(value)
}

/** A discount that reads, as the domain's maths take it (null: none). */
export function asDiscount(kind: DiscountKind, value: string): LineDiscount | null {
  if (kind === 'none') return null
  return kind === 'percent' ? { percent: value as Percent } : { amount: value as Money }
}
