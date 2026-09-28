// Stored values of the purchasing tables of M2 Step 3 (docs/DATA_MODEL.md §6: suppliers, purchases,
// purchase_lines, purchase_returns, stock_movements, attachments). The database CHECK constraints
// list the same values; pure code (contracts, the API) reads them from here.

/**
 * `purchases.document_type`: what the supplier gave (PRODUCT.md §4.13), independent of how it was
 * paid. Only a tax invoice lets a VAT-registered business reclaim the VAT (D-114 rule 4).
 */
export const PURCHASE_DOCUMENT_TYPES = ['tax_invoice', 'non_tax_invoice', 'no_invoice'] as const
export type PurchaseDocumentType = (typeof PURCHASE_DOCUMENT_TYPES)[number]

/** `purchases.payment_method` (PRODUCT.md §4.13). NULL: not said. */
export const PAYMENT_METHODS = ['cash', 'card', 'bank_transfer', 'cheque', 'other'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

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

/** `attachments.entity`: what a file is attached to. M2 Step 3: purchases (their receipts). */
export const ATTACHMENT_ENTITIES = ['purchase'] as const
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
