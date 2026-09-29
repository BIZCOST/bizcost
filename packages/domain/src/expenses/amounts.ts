import { computePurchase } from '../documents/purchase'
import { toDec } from '../numbers/decimal'
import type { Money, Percent, Quantity } from '../numbers/kinds'
import { fitsCurrency, type CurrencyCode } from '../numbers/rounding'

// An expense's amounts (M2 Step 5; D-114 rule 4, D-157, D-165). An expense is one amount in one
// category: what was paid, typed before VAT or with its VAT (the purchase's switch), with the VAT
// rate the bill shows (0 without VAT). The maths is the purchase line's, for one line of quantity 1
// (computePurchase), so a bill entered as an expense and as a purchase line gives the same figures:
//   - before VAT: net = amount, VAT = round(amount × rate ÷ 100), total = net + VAT;
//   - including VAT: total = amount, VAT = round(amount × rate ÷ (100 + rate)), net = total − VAT;
//   - what it costs the business (at posting): net, plus the VAT when it cannot be reclaimed
//     (vatInCost: not VAT-registered, not a tax invoice, or marked "VAT can't be reclaimed").
// The amount typed is a document amount: at most the currency's minor-unit decimals, more than zero
// (refused, never rounded behind the person's back, D-142).

export interface ExpenseInput {
  /** What the bill says, before VAT or with its VAT (`pricesIncludeVat`). */
  readonly amount: Money
  /** VAT rate in percent (5 for the UAE standard rate; 0 when the bill shows no VAT). */
  readonly vatRate: Percent
  readonly pricesIncludeVat: boolean
  /** Whether the VAT is part of what it costs (vatInCost in purchasing/keys.ts). */
  readonly vatInCost: boolean
}

/** An expense's document amounts, each with exactly the currency's minor-unit digits. */
export interface ExpenseAmounts {
  /** Before VAT. */
  readonly net: Money
  readonly vat: Money
  /** net + vat: what was paid (and what is owed on credit or to a member). */
  readonly total: Money
  /** What it costs the business: net, plus the VAT when it cannot be reclaimed. */
  readonly cost: Money
}

export type ExpenseErrorCode =
  'amount_not_positive' | 'too_many_decimals' | 'negative_vat_rate' | 'vat_rate_over_100'

/** The first problem with an expense's input (for a form message), or null when it is fine. */
export function expenseError(
  input: Pick<ExpenseInput, 'amount' | 'vatRate'>,
  currency: CurrencyCode,
): ExpenseErrorCode | null {
  if (!toDec(input.amount).gt(0)) return 'amount_not_positive'
  if (!fitsCurrency(input.amount, currency)) return 'too_many_decimals'
  if (toDec(input.vatRate).lt(0)) return 'negative_vat_rate'
  if (toDec(input.vatRate).gt(100)) return 'vat_rate_over_100'
  return null
}

/** An expense's amounts (see above). Throws RangeError when expenseError finds a problem. */
export function computeExpense(input: ExpenseInput, currency: CurrencyCode): ExpenseAmounts {
  const error = expenseError(input, currency)
  if (error) throw new RangeError(`Invalid expense: ${error}`)
  const purchase = computePurchase(
    {
      lines: [
        { kind: 'material', qty: '1' as Quantity, unitPrice: input.amount, vatRate: input.vatRate },
      ],
      vatInCost: input.vatInCost,
      pricesIncludeVat: input.pricesIncludeVat,
    },
    currency,
  )
  return { net: purchase.net, vat: purchase.vat, total: purchase.total, cost: purchase.cost }
}
