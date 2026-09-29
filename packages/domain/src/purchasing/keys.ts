import { subtractDecimals } from '../documents/split'
import { compareDecimal } from '../numbers/decimal'

// Stored values of the purchasing tables of M2 Step 3 (docs/DATA_MODEL.md §6: suppliers, purchases,
// purchase_lines, purchase_returns, stock_movements, attachments, purchase_payments). The database
// CHECK constraints list the same values; pure code (contracts, the API) reads them from here.

/**
 * `purchases.document_type`: what the supplier gave (PRODUCT.md §4.13), independent of how it was
 * paid. Only a tax invoice lets a VAT-registered business reclaim the VAT (D-114 rule 4).
 */
export const PURCHASE_DOCUMENT_TYPES = ['tax_invoice', 'non_tax_invoice', 'no_invoice'] as const
export type PurchaseDocumentType = (typeof PURCHASE_DOCUMENT_TYPES)[number]

/**
 * `purchases.payment_method` (PRODUCT.md §4.13): how the purchase was paid, independent of the
 * document type. Every purchase saved from 2026-09-29 says it (the API requires it for a draft and for
 * posting); purchases posted before keep NULL. `supplier_credit`: bought on credit, the business pays
 * the supplier later (it needs the supplier). `paid_by_member`: a member paid from their own money
 * (purchases.paid_by_member_id names them) and the business owes it to them. `other` stays for what
 * none of these says.
 */
export const PAYMENT_METHODS = [
  'cash',
  'card',
  'bank_transfer',
  'cheque',
  'supplier_credit',
  'paid_by_member',
  'other',
] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

/** Payment methods that leave the purchase owed (to its supplier, or to the member who paid). */
export const OWED_PAYMENT_METHODS = [
  'supplier_credit',
  'paid_by_member',
] as const satisfies readonly PaymentMethod[]
export type OwedPaymentMethod = (typeof OWED_PAYMENT_METHODS)[number]

export function isOwedPaymentMethod(value: unknown): value is OwedPaymentMethod {
  return (OWED_PAYMENT_METHODS as readonly unknown[]).includes(value)
}

/**
 * `purchase_payments.method`: how the business paid what it owed on a purchase (to the supplier or
 * to the member who paid for it).
 */
export const SETTLEMENT_METHODS = [
  'cash',
  'card',
  'bank_transfer',
  'cheque',
] as const satisfies readonly PaymentMethod[]
export type SettlementMethod = (typeof SETTLEMENT_METHODS)[number]

/**
 * Whether a new purchase's prices are typed with their VAT, until the person chooses: before VAT on
 * a tax invoice (it shows the prices before VAT and the VAT apart), with VAT on a non-tax invoice or
 * without an invoice (what was paid).
 */
export function defaultPricesIncludeVat(documentType: PurchaseDocumentType): boolean {
  return documentType !== 'tax_invoice'
}

/**
 * What is still owed on a purchase bought on credit or paid by a member: its total less its posted
 * returns and credit notes (their totals, with VAT) less the payments that stand; never below zero
 * (a return after the purchase was paid leaves it overpaid: overpaidOf). Amounts are document amounts
 * in the purchase's currency.
 */
export function outstandingOf(total: string, returned: string, paid: string): string {
  const left = subtractDecimals(total, returned, paid)
  return compareDecimal(left, '0') > 0 ? left : '0'
}

/**
 * What was paid on a purchase beyond what it came to after its posted returns and credit notes: the
 * payments that stand less (its total less those returns); zero when not more. A return or credit
 * note posted after the purchase was paid leaves this owed back to the business (by the supplier, or
 * the member who paid); it is shown, not tracked as a balance yet (D-162). With outstandingOf:
 * total − returned − paid = outstanding − overpaid, and at most one of them is not zero.
 */
export function overpaidOf(total: string, returned: string, paid: string): string {
  const over = subtractDecimals(paid, subtractDecimals(total, returned))
  return compareDecimal(over, '0') > 0 ? over : '0'
}

/**
 * `status` of purchases, supplier returns and credit notes: a draft changes nothing; posting writes
 * the stock ledger and the average (D-114 rule 1); a posted document is never edited, it is reversed
 * ("as if never posted", D-109, D-120) and stays in the list as reversed.
 */
export const DOCUMENT_STATUSES = ['draft', 'posted', 'reversed'] as const
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

/**
 * `purchase_lines.kind`: a material bought, or delivery charged on the same invoice. Delivery is
 * split over the material lines by their net amount and becomes part of their cost (D-114 rule 4).
 */
export const PURCHASE_LINE_KINDS = ['material', 'delivery'] as const
export type PurchaseLineKind = (typeof PURCHASE_LINE_KINDS)[number]

/**
 * `purchase_returns.kind` (D-120): goods sent back to the supplier (a quantity per purchase line), or
 * a credit note (a price reduction without goods: an amount per purchase line).
 */
export const PURCHASE_RETURN_KINDS = ['return', 'credit_note'] as const
export type PurchaseReturnKind = (typeof PURCHASE_RETURN_KINDS)[number]

/**
 * `stock_movements.kind` (D-110, D-120): a posted purchase line brings goods in (`purchase`), a
 * supplier return takes goods out at the price paid for them (`purchase_return`), a credit note
 * lowers the value of the credited goods (`purchase_credit`, no quantity), and `reversal` undoes one
 * of those (it names the movement it reverses).
 */
export const STOCK_MOVEMENT_KINDS = [
  'purchase',
  'purchase_return',
  'purchase_credit',
  'reversal',
] as const
export type StockMovementKind = (typeof STOCK_MOVEMENT_KINDS)[number]

/**
 * `attachments.entity`: what a file is attached to. M2 Step 3: purchases (their receipts); M2 Step 5:
 * expenses (their receipts).
 */
export const ATTACHMENT_ENTITIES = ['purchase', 'expense'] as const
export type AttachmentEntity = (typeof ATTACHMENT_ENTITIES)[number]

/** Days of purchases the average uses until the business's first stock count (D-115). */
export const PURCHASE_AVERAGE_DAYS = 90

export interface VatInCostInput {
  /** businesses.vat_registered when the document is posted. */
  readonly vatRegistered: boolean
  readonly documentType: PurchaseDocumentType
  /** The document is marked "VAT can't be reclaimed". */
  readonly vatNotReclaimable: boolean
}

/**
 * Whether the VAT paid is part of what the goods cost (D-114 rule 4, PRODUCT.md §4 rule 12): VAT you
 * can reclaim never counts as cost; VAT you cannot reclaim is part of what you paid. It stays out of
 * the cost only when the business is VAT-registered, the document is a tax invoice and it is not
 * marked "VAT can't be reclaimed".
 */
export function vatInCost(input: VatInCostInput): boolean {
  return !(input.vatRegistered && input.documentType === 'tax_invoice' && !input.vatNotReclaimable)
}
