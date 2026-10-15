import { subtractDecimals } from '../documents/split'
import { compareDecimal } from '../numbers/decimal'
import { outstandingOf, overpaidOf } from '../purchasing/keys'

// What a customer's order or sale says about its payments (M3 Step 5; the owner's answers Q16 and
// Q17 of D-218, as supplier payments: D-159, D-160, D-162). One figure per obligation (A2): an order
// owes its total (0 once cancelled) less its refunds, a sale "they'll pay later" its total less its
// refunds; the sale a delivered order posted owes nothing (the order does).
//
//   what was paid (net) = the payments that stand − the money given back that stands
//   still owed          = outstandingOf(total, credited, paid)   never below zero
//   paid beyond it      = overpaidOf(total, credited, paid)      "money back to the customer"
//
// At most one of the two is more than zero. A payment is never more than is still owed
// (EXCEEDS_OUTSTANDING), and money given back never more than was paid beyond it.

/**
 * `customer_payments.kind` and `purchase_payments.kind`: money paid towards what is owed, or money
 * given back (to a customer: a refund; from a supplier: "Money back from the supplier", Q18).
 */
export const PAYMENT_KINDS = ['payment', 'refund'] as const
export type PaymentKind = (typeof PAYMENT_KINDS)[number]

/**
 * The badge of an order or a sale (Q16): `unpaid` (nothing paid), `deposit` (part paid), `paid` (paid
 * in full), `overpaid` (paid beyond what it now comes to: a refund, or a cancelled order's deposit,
 * not yet given back).
 */
export const PAYMENT_STATES = ['unpaid', 'deposit', 'paid', 'overpaid'] as const
export type PaymentState = (typeof PAYMENT_STATES)[number]

/** What was paid on a document, net of the money given back: payments − refunds (exact). */
export function netPaid(payments: string, refunds: string): string {
  return subtractDecimals(payments, refunds)
}

/**
 * The payment state of a document that comes to `total`, less `credited` (its refunds, with VAT),
 * with `paid` (net of money given back) paid on it: built from outstandingOf and overpaidOf.
 */
export function paymentState(total: string, credited: string, paid: string): PaymentState {
  if (compareDecimal(overpaidOf(total, credited, paid), '0') > 0) return 'overpaid'
  if (compareDecimal(outstandingOf(total, credited, paid), '0') === 0) return 'paid'
  if (compareDecimal(paid, '0') > 0) return 'deposit'
  return 'unpaid'
}
