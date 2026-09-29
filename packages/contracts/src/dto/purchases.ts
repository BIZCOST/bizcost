import {
  checkDecimal,
  compareDecimal,
  DOCUMENT_STATUSES,
  PAYMENT_METHODS,
  PURCHASE_DOCUMENT_TYPES,
  PURCHASE_RETURN_KINDS,
  SETTLEMENT_METHODS,
  type DecimalKind,
} from '@bizcost/domain'
import { z } from 'zod'
import { withMeta } from '../envelope'
import { zBusinessDate, zDecimal, zUuid } from '../primitives'
import {
  DOCUMENT_LINES_MAX,
  DOCUMENT_NOTES_MAX_LENGTH,
  PAYABLE_PAGE_SIZE,
  PAYMENT_NOTE_MAX_LENGTH,
  DOCUMENT_PAGE_SIZE,
  DOCUMENT_PAGE_SIZE_MAX,
  DOCUMENT_REFERENCE_MAX_LENGTH,
  MATERIAL_COSTS_MAX,
  PURCHASE_LINE_DESCRIPTION_MAX_LENGTH,
} from '../purchasing'
import { sensitive } from '../sensitivity'
import { standardUnitDto } from './catalog'
import { optionalLine } from './suppliers'

// Purchases, supplier returns and credit notes, the books-closed date and the material cost view
// (ROADMAP.md M2 Step 3; docs/DATA_MODEL.md §6; D-114, D-115, D-120). Decimals are strings (Arabic-Indic
// digits accepted on input), business days YYYY-MM-DD, timestamps ISO strings.
//
// Sensitive (redacted for members without data.*.view; D-026): what was paid to a supplier is
// `supplier_price` (prices, discounts, line and document amounts, what a line's goods cost, credit and
// return amounts, the last purchase price); the material's average cost is `cost`. Members who may see
// supplier prices always see costs too (the grouping rule: the prices would reveal the average).
// Outputs with such fields are withMeta() envelopes: meta.redacted names the hidden paths.

const isoTimestamp = z.iso.datetime({ offset: true })

/** A decimal that fits its column and passes `ok` (e.g. more than zero). */
function decimalInput(kind: DecimalKind, ok: (value: string) => boolean, message: string) {
  return zDecimal.refine((value) => checkDecimal(value, kind) === null && ok(value), { message })
}

/** A price or amount: zero or more, numeric(20,4). */
const moneyInput = decimalInput('money', (v) => compareDecimal(v, '0') >= 0, 'zero or more')
/** A positive amount, numeric(20,4). */
const positiveMoneyInput = decimalInput(
  'money',
  (v) => compareDecimal(v, '0') > 0,
  'more than zero',
)
/** A percentage from 0 to 100, numeric(9,6). */
const percentInput = decimalInput(
  'percent',
  (v) => compareDecimal(v, '0') >= 0 && compareDecimal(v, '100') <= 0,
  'from 0 to 100',
)
/** A quantity: more than zero, numeric(24,6). */
const quantityInput = decimalInput('quantity', (v) => compareDecimal(v, '0') > 0, 'more than zero')

/** Several lines are fine. */
const notesInput = z
  .string()
  .trim()
  .max(DOCUMENT_NOTES_MAX_LENGTH)
  .nullish()
  .transform((value) => (value ? value : null))

const uniqueIds = (items: readonly { id: string }[]) =>
  new Set(items.map((item) => item.id)).size === items.length

export const purchaseDocumentTypeDto = z.enum(PURCHASE_DOCUMENT_TYPES)
export const paymentMethodDto = z.enum(PAYMENT_METHODS)
export const documentStatusDto = z.enum(DOCUMENT_STATUSES)
export const purchaseReturnKindDto = z.enum(PURCHASE_RETURN_KINDS)

/** A discount: a percentage, or an amount. */
export const discountInput = z.union([
  z.object({ percent: percentInput }),
  z.object({ amount: moneyInput }),
])
export type DiscountInput = z.input<typeof discountInput>

export const discountDto = z.union([
  z.object({ percent: zDecimal }),
  z.object({ amount: zDecimal }),
])
export type DiscountDto = z.infer<typeof discountDto>

// ---------------------------------------------------------------------------------------------------
// Purchases (module purchases; purchases.documents.view / manage / post / reverse)
// ---------------------------------------------------------------------------------------------------

/**
 * A material bought: `qty` in its purchase unit, which is a standard unit (`unit`: of the material's
 * dimension, or of another one through its cross factor) or one of its packs (`packId`); exactly one
 * of the two. `unitPrice` is per purchase unit, before VAT, or with its VAT when the purchase's
 * `pricesIncludeVat` is on (its discount then too); the line's own discount comes off first.
 */
export const purchaseMaterialLineInput = z
  .object({
    kind: z.literal('material'),
    id: zUuid,
    materialId: zUuid,
    qty: quantityInput,
    unit: standardUnitDto.nullish(),
    packId: zUuid.nullish(),
    unitPrice: moneyInput,
    discount: discountInput.nullish(),
    /** VAT rate in percent (5 for the UAE standard rate; 0 when the document shows no VAT). */
    vatRate: percentInput.default('0'),
  })
  .refine((line) => (line.unit == null) !== (line.packId == null), {
    message: 'exactly one of unit and packId',
  })

/**
 * Delivery charged on the same invoice: split over the material lines and part of their cost. The
 * amount is before VAT, or with its VAT when the purchase's `pricesIncludeVat` is on.
 */
export const purchaseDeliveryLineInput = z.object({
  kind: z.literal('delivery'),
  id: zUuid,
  description: optionalLine(PURCHASE_LINE_DESCRIPTION_MAX_LENGTH),
  amount: moneyInput,
  vatRate: percentInput.default('0'),
})

export const purchaseLineInput = z.discriminatedUnion('kind', [
  purchaseMaterialLineInput,
  purchaseDeliveryLineInput,
])
export type PurchaseLineInput = z.input<typeof purchaseLineInput>

const purchaseFields = {
  /** Optional: a purchase at a market may have none (supplier credit needs one). */
  supplierId: zUuid.nullable().default(null),
  businessDate: zBusinessDate,
  documentType: purchaseDocumentTypeDto,
  /** The supplier's invoice or receipt number. */
  reference: optionalLine(DOCUMENT_REFERENCE_MAX_LENGTH),
  /**
   * How it was paid: required on every save (a draft saved before 2026-09-29 without one is
   * completed first). `supplier_credit` needs `supplierId`; `paid_by_member` needs
   * `paidByMemberId`.
   */
  paymentMethod: paymentMethodDto,
  /**
   * `paid_by_member` only: the member who paid from their own money, an active member of the
   * business (NOT_FOUND otherwise); null for every other method.
   */
  paidByMemberId: zUuid.nullable().default(null),
  /**
   * Whether the prices, discounts and delivery amounts are typed with their VAT (default false). The
   * amounts stored and returned are before VAT, VAT and total either way.
   */
  pricesIncludeVat: z.boolean().default(false),
  /**
   * Where the goods came in. Only with multi_location (CAPABILITY_DISABLED for another than the
   * default location without it); null: the default location.
   */
  locationId: zUuid.nullable().default(null),
  /** The document is marked "VAT can't be reclaimed" (D-114 rule 4). */
  vatNotReclaimable: z.boolean().default(false),
  /** A discount on the whole document, split over the material lines by net amount. */
  discount: discountInput.nullable().default(null),
  notes: notesInput,
  /** In their order on the document. Ids are client UUIDv7s. */
  lines: z
    .array(purchaseLineInput)
    .max(DOCUMENT_LINES_MAX)
    .default([])
    .refine(uniqueIds, { message: 'duplicate line id' }),
}

/** Who paid goes with how it was paid (VALIDATION otherwise). */
function paidBy(purchase: {
  paymentMethod: string
  paidByMemberId: string | null
  supplierId: string | null
}) {
  if ((purchase.paymentMethod === 'paid_by_member') !== (purchase.paidByMemberId !== null)) {
    return false
  }
  return purchase.paymentMethod !== 'supplier_credit' || purchase.supplierId !== null
}
const paidByMessage = {
  message: 'paidByMemberId goes with paid_by_member, and supplier_credit needs a supplier',
}

/** `purchase.create` (a draft): idempotent on the client's `id`. */
export const createPurchaseInput = z
  .object({ id: zUuid, ...purchaseFields })
  .refine(paidBy, paidByMessage)
export type CreatePurchaseInput = z.input<typeof createPurchaseInput>

/** `purchase.update` (a draft only): the whole document, `version` as read. */
export const updatePurchaseInput = z
  .object({
    id: zUuid,
    version: z.int().positive(),
    ...purchaseFields,
  })
  .refine(paidBy, paidByMessage)
export type UpdatePurchaseInput = z.input<typeof updatePurchaseInput>

/** `purchase.get`, `purchase.reverse`. */
export const documentIdInput = z.object({ id: zUuid })
export type DocumentIdInput = z.input<typeof documentIdInput>

/** `purchase.post`, `purchase.discard`: the draft's `version` as read. */
export const documentVersionInput = z.object({ id: zUuid, version: z.int().positive() })
export type DocumentVersionInput = z.input<typeof documentVersionInput>

/** `purchase.correct`: reverse a posted purchase and open a copy of it as a new draft (`newId`). */
export const correctPurchaseInput = z.object({ id: zUuid, newId: zUuid })
export type CorrectPurchaseInput = z.input<typeof correctPurchaseInput>

/** `purchase.list`: newest business day first. */
export const purchaseListInput = z
  .object({
    /** Default: every purchase that was not discarded. */
    status: z.enum(['all', ...DOCUMENT_STATUSES]).default('all'),
    supplierId: zUuid.optional(),
    /** Business days from and to (both included). */
    from: zBusinessDate.optional(),
    to: zBusinessDate.optional(),
    /** Part of the reference or of the supplier's name. */
    search: z.string().trim().max(100).optional(),
    cursor: z.string().min(1).max(500).optional(),
    limit: z.int().min(1).max(DOCUMENT_PAGE_SIZE_MAX).default(DOCUMENT_PAGE_SIZE),
  })
  .prefault({})
export type PurchaseListInput = z.input<typeof purchaseListInput>

const price = () => sensitive(zDecimal, 'supplier_price')

export const purchaseLineDto = z.object({
  id: zUuid,
  kind: z.enum(['material', 'delivery']),
  materialId: zUuid.nullable(),
  /** The material's name when the line was saved, or the delivery's text. */
  description: z.string().nullable(),
  qty: zDecimal,
  unit: standardUnitDto.nullable(),
  packId: zUuid.nullable(),
  /** The pack's name (null for a standard unit); a pack removed since keeps its name here. */
  packName: z.string().nullable(),
  vatRate: zDecimal,
  unitPrice: price(),
  discount: sensitive(discountDto.nullable(), 'supplier_price'),
  subtotal: price(),
  /** The line's own discount as an amount. */
  lineDiscount: price(),
  net: price(),
  /** Its share of the document discount. */
  documentDiscount: price(),
  /** What VAT is on: net − documentDiscount. */
  taxable: price(),
  vat: price(),
  total: price(),
  /** Posted material lines: the quantity in the material's base unit. */
  baseQty: zDecimal.nullable(),
  /** Posted material lines: their share of the delivery. */
  deliveryShare: sensitive(zDecimal.nullable(), 'supplier_price'),
  /** Posted material lines: what the goods cost (the value they brought into stock). */
  cost: sensitive(zDecimal.nullable(), 'supplier_price'),
  /** Quantity sent back by posted returns (in the line's unit). */
  returnedQty: zDecimal,
  /** Amount (before VAT) that posted returns took back. */
  returnedAmount: price(),
  /** Amount (before VAT) taken off by posted credit notes. */
  creditedAmount: price(),
})
export type PurchaseLineDto = z.infer<typeof purchaseLineDto>

export const purchaseReturnSummaryDto = z.object({
  id: zUuid,
  kind: purchaseReturnKindDto,
  status: documentStatusDto,
  businessDate: zBusinessDate,
  reference: z.string().nullable(),
  /** The document's total (with its VAT). */
  total: price(),
  /** Posted: what it took off the goods' cost (12 decimals); null for a draft. */
  costTotal: sensitive(zDecimal.nullable(), 'supplier_price'),
})

export const purchaseDto = z.object({
  id: zUuid,
  status: documentStatusDto,
  supplierId: zUuid.nullable(),
  /** The supplier's name (as it is now). */
  supplierName: z.string().nullable(),
  locationId: zUuid,
  businessDate: zBusinessDate,
  documentType: purchaseDocumentTypeDto,
  reference: z.string().nullable(),
  /** Null only on a purchase posted before the method was required (or a draft from then). */
  paymentMethod: paymentMethodDto.nullable(),
  /** `paid_by_member`: the member who paid, and their name in the business as it is now. */
  paidByMemberId: zUuid.nullable(),
  paidByMemberName: z.string().nullable(),
  /** Whether its prices were typed with their VAT (its amounts are before VAT, VAT and total). */
  pricesIncludeVat: z.boolean(),
  vatNotReclaimable: z.boolean(),
  /** ISO 4217 (the business's currency). */
  currency: z.string(),
  discount: sensitive(discountDto.nullable(), 'supplier_price'),
  notes: z.string().nullable(),
  subtotal: price(),
  /** The document discount as an amount. */
  documentDiscount: price(),
  /** Line discounts + the document discount. */
  discountTotal: price(),
  netTotal: price(),
  vatTotal: price(),
  total: price(),
  /** Posted: whether VAT is part of the cost (D-114 rule 4); null for a draft. */
  vatInCost: z.boolean().nullable(),
  /** Posted: what the goods cost in all. */
  costTotal: sensitive(zDecimal.nullable(), 'supplier_price'),
  lines: z.array(purchaseLineDto),
  /** Its supplier returns and credit notes (drafts included). */
  returns: z.array(purchaseReturnSummaryDto),
  attachmentCount: z.int().nonnegative(),
  postedAt: isoTimestamp.nullable(),
  reversedAt: isoTimestamp.nullable(),
  /** The reversal's business day (the purchase's own, or the first open day). */
  reversalDate: zBusinessDate.nullable(),
  /** A draft made by "correct": the reversed purchase it replaces. */
  copiedFromId: zUuid.nullable(),
  createdAt: isoTimestamp,
  version: z.int().positive(),
})
export type PurchaseDto = z.infer<typeof purchaseDto>

/** One purchase as withMeta() (sensitive fields may be removed; meta.redacted names them). */
export const purchaseResultDto = withMeta(purchaseDto)
export type PurchaseResultDto = z.infer<typeof purchaseResultDto>

export const purchaseListItemDto = z.object({
  id: zUuid,
  status: documentStatusDto,
  supplierId: zUuid.nullable(),
  supplierName: z.string().nullable(),
  locationId: zUuid,
  businessDate: zBusinessDate,
  documentType: purchaseDocumentTypeDto,
  reference: z.string().nullable(),
  currency: z.string(),
  total: price(),
  /** How many materials it bought (delivery lines are not counted). */
  lineCount: z.int().nonnegative(),
  /** The names of its first two materials, as bought (for a purchase without a supplier). */
  itemNames: z.array(z.string()),
  version: z.int().positive(),
})
export type PurchaseListItemDto = z.infer<typeof purchaseListItemDto>

/** `purchase.list`: newest business day first; `nextCursor` null on the last page. */
export const purchaseListDto = withMeta(
  z.object({ items: z.array(purchaseListItemDto), nextCursor: z.string().nullable() }),
)
export type PurchaseListDto = z.infer<typeof purchaseListDto>

// ---------------------------------------------------------------------------------------------------
// Supplier returns and credit notes (the same module and keys; D-120)
// ---------------------------------------------------------------------------------------------------

/**
 * A line: a material line of the purchase, and `qty` (a return, in that line's unit) or `amount` (a
 * credit note, before VAT). Exactly one of the two, the one of the document's kind.
 */
export const purchaseReturnLineInput = z
  .object({
    id: zUuid,
    purchaseLineId: zUuid,
    qty: quantityInput.nullish(),
    amount: positiveMoneyInput.nullish(),
  })
  .refine((line) => (line.qty == null) !== (line.amount == null), {
    message: 'exactly one of qty and amount',
  })
export type PurchaseReturnLineInput = z.input<typeof purchaseReturnLineInput>

const purchaseReturnFields = {
  businessDate: zBusinessDate,
  /** The supplier's return note or credit note number. */
  reference: optionalLine(DOCUMENT_REFERENCE_MAX_LENGTH),
  notes: notesInput,
  lines: z
    .array(purchaseReturnLineInput)
    .max(DOCUMENT_LINES_MAX)
    .default([])
    .refine(uniqueIds, { message: 'duplicate line id' })
    .refine((lines) => new Set(lines.map((l) => l.purchaseLineId)).size === lines.length, {
      message: 'a purchase line twice',
    }),
  /**
   * Credit notes only: one amount (before VAT, at most the currency's decimals) split over the
   * purchase's material lines by what is left of their net amount (largest remainder, D-142); `lines`
   * then stays empty.
   */
  splitAmount: positiveMoneyInput.nullable().default(null),
}

/** `purchaseReturn.create` (a draft): for a posted purchase; idempotent on the client's `id`. */
export const createPurchaseReturnInput = z.object({
  id: zUuid,
  purchaseId: zUuid,
  kind: purchaseReturnKindDto,
  ...purchaseReturnFields,
})
export type CreatePurchaseReturnInput = z.input<typeof createPurchaseReturnInput>

/** `purchaseReturn.update` (a draft only): the whole document, `version` as read. */
export const updatePurchaseReturnInput = z.object({
  id: zUuid,
  version: z.int().positive(),
  ...purchaseReturnFields,
})
export type UpdatePurchaseReturnInput = z.input<typeof updatePurchaseReturnInput>

/** `purchaseReturn.list`: newest business day first. */
export const purchaseReturnListInput = z
  .object({
    purchaseId: zUuid.optional(),
    kind: purchaseReturnKindDto.optional(),
    status: z.enum(['all', ...DOCUMENT_STATUSES]).default('all'),
    cursor: z.string().min(1).max(500).optional(),
    limit: z.int().min(1).max(DOCUMENT_PAGE_SIZE_MAX).default(DOCUMENT_PAGE_SIZE),
  })
  .prefault({})
export type PurchaseReturnListInput = z.input<typeof purchaseReturnListInput>

export const purchaseReturnLineDto = z.object({
  id: zUuid,
  purchaseLineId: zUuid,
  materialId: zUuid.nullable(),
  /** The purchase line's text (the material's name when it was bought). */
  description: z.string().nullable(),
  /** The purchase line's unit (a return's quantity is in it). */
  unit: standardUnitDto.nullable(),
  packId: zUuid.nullable(),
  packName: z.string().nullable(),
  /** A return: the quantity sent back. */
  qty: zDecimal.nullable(),
  /** A credit note: the amount before VAT. */
  amount: sensitive(zDecimal.nullable(), 'supplier_price'),
  /** Before VAT, and its VAT (document amounts). */
  net: price(),
  vat: price(),
  /** Posted returns: the quantity in the material's base unit. */
  baseQty: zDecimal.nullable(),
  /** Posted: what it took off the goods' cost (12 decimals). */
  cost: sensitive(zDecimal.nullable(), 'supplier_price'),
})
export type PurchaseReturnLineDto = z.infer<typeof purchaseReturnLineDto>

export const purchaseReturnDto = z.object({
  id: zUuid,
  purchaseId: zUuid,
  kind: purchaseReturnKindDto,
  status: documentStatusDto,
  businessDate: zBusinessDate,
  reference: z.string().nullable(),
  notes: z.string().nullable(),
  currency: z.string(),
  splitAmount: sensitive(zDecimal.nullable(), 'supplier_price'),
  netTotal: price(),
  vatTotal: price(),
  total: price(),
  costTotal: sensitive(zDecimal.nullable(), 'supplier_price'),
  lines: z.array(purchaseReturnLineDto),
  postedAt: isoTimestamp.nullable(),
  reversedAt: isoTimestamp.nullable(),
  reversalDate: zBusinessDate.nullable(),
  createdAt: isoTimestamp,
  version: z.int().positive(),
})
export type PurchaseReturnDto = z.infer<typeof purchaseReturnDto>

export const purchaseReturnResultDto = withMeta(purchaseReturnDto)
export type PurchaseReturnResultDto = z.infer<typeof purchaseReturnResultDto>

export const purchaseReturnListItemDto = z.object({
  id: zUuid,
  purchaseId: zUuid,
  kind: purchaseReturnKindDto,
  status: documentStatusDto,
  businessDate: zBusinessDate,
  reference: z.string().nullable(),
  supplierName: z.string().nullable(),
  currency: z.string(),
  total: price(),
  version: z.int().positive(),
})
export type PurchaseReturnListItemDto = z.infer<typeof purchaseReturnListItemDto>

export const purchaseReturnListDto = withMeta(
  z.object({ items: z.array(purchaseReturnListItemDto), nextCursor: z.string().nullable() }),
)
export type PurchaseReturnListDto = z.infer<typeof purchaseReturnListDto>

// ---------------------------------------------------------------------------------------------------
// Who paid, what is owed, and paying it (the owner's requests of 2026-09-29)
// ---------------------------------------------------------------------------------------------------

/** `purchase.payers` (purchases.documents.manage): the members a purchase may say paid for it. */
export const purchasePayerDto = z.object({
  memberId: zUuid,
  /** Their name in the business. */
  name: z.string(),
  /** The caller: the one picked until someone else is. */
  isMe: z.boolean(),
})
export type PurchasePayerDto = z.infer<typeof purchasePayerDto>

/** The active members of the business, by name. */
export const purchasePayersDto = z.object({ items: z.array(purchasePayerDto) })
export type PurchasePayersDto = z.infer<typeof purchasePayersDto>

/** Who a purchase is owed to: its supplier (bought on credit), or the member who paid for it. */
export const payablePartyDto = z.enum(['supplier', 'member'])
export type PayablePartyDto = z.infer<typeof payablePartyDto>

/**
 * `payable.list` (purchases.payments.view, and supplier prices visible: it lists only what is still
 * owed, so it filters on amounts): what the business still owes, by supplier or by member, a page of
 * PAYABLE_PAGE_SIZE suppliers or members at a time (`cursor`: the previous page's `nextCursor`).
 */
export const payableListInput = z.object({
  party: payablePartyDto,
  cursor: z.string().min(1).max(500).optional(),
  /** Suppliers or members per page (at most PAYABLE_PAGE_SIZE, the default). */
  limit: z.int().min(1).max(PAYABLE_PAGE_SIZE).default(PAYABLE_PAGE_SIZE),
})
export type PayableListInput = z.input<typeof payableListInput>

/** The member who entered or changed something, as the business names them now. */
export const memberNameDto = z.object({
  memberId: zUuid.nullable(),
  name: z.string().nullable(),
})

/** One final purchase with something still owed on it. */
export const payableInvoiceDto = z.object({
  purchaseId: zUuid,
  businessDate: zBusinessDate,
  /** The supplier's invoice or receipt number. */
  reference: z.string().nullable(),
  documentType: purchaseDocumentTypeDto,
  /** The names of its first two materials, as bought. */
  itemNames: z.array(z.string()),
  currency: z.string(),
  /** The purchase's total, with its VAT. */
  total: price(),
  /** What its final returns and credit notes took off (their totals, with VAT). */
  returned: price(),
  /** The payments recorded on it that stand. */
  paid: price(),
  /** total − returned − paid (never below zero). */
  outstanding: price(),
  /** Who entered the purchase. */
  enteredBy: memberNameDto,
})
export type PayableInvoiceDto = z.infer<typeof payableInvoiceDto>

/** A supplier, or a member who paid personally, and the purchases still owed to them. */
export const payableGroupDto = z.object({
  party: payablePartyDto,
  /** The supplier's or the member's id. */
  partyId: zUuid,
  name: z.string(),
  /** False for an archived supplier or a member who left (still owed). */
  active: z.boolean(),
  /** Σ outstanding of all its purchases still owed. */
  outstanding: price(),
  /** How many of its purchases are still owed. */
  invoiceCount: z.int().nonnegative(),
  /** The oldest PAYABLE_INVOICES_MAX of them, oldest first. */
  invoices: z.array(payableInvoiceDto),
})
export type PayableGroupDto = z.infer<typeof payableGroupDto>

export const payableListDto = withMeta(
  z.object({
    party: payablePartyDto,
    /** The business's currency. */
    currency: z.string(),
    /** Σ outstanding of every supplier or member (all pages). */
    total: price(),
    /** This page, by name. */
    groups: z.array(payableGroupDto),
    /** The next page's cursor; null on the last page. */
    nextCursor: z.string().nullable(),
  }),
)
export type PayableListDto = z.infer<typeof payableListDto>

/** How the business paid what it owed: cash, card, bank transfer or cheque. */
export const settlementMethodDto = z.enum(SETTLEMENT_METHODS)

/**
 * `purchasePayment.record` (purchases.payments.record, and supplier prices visible: the amount is
 * checked against what is owed): a payment of what is owed on a final purchase bought on credit or
 * paid by a member. Idempotent on the client's `id`. Its day is in the business's time zone, not
 * after today (FUTURE_DATE), not on or before the books-closed date (BOOKS_CLOSED), not before the
 * purchase (VALIDATION); the amount more than zero, at most the currency's decimals (VALIDATION) and
 * at most what is still owed (EXCEEDS_OUTSTANDING).
 */
export const recordPurchasePaymentInput = z.object({
  id: zUuid,
  purchaseId: zUuid,
  businessDate: zBusinessDate,
  method: settlementMethodDto,
  amount: positiveMoneyInput,
  note: z
    .string()
    .trim()
    .max(PAYMENT_NOTE_MAX_LENGTH)
    .nullish()
    .transform((value) => (value ? value : null)),
})
export type RecordPurchasePaymentInput = z.input<typeof recordPurchasePaymentInput>

/**
 * `purchasePayment.reverse` (purchases.payments.record): a payment recorded by mistake stops counting
 * (it stays listed as reversed; every change is audited). Dated its own day, or the first open day
 * when the books are closed on it (BOOKS_CLOSED when that is after today). Idempotent.
 */
export const reversePurchasePaymentInput = z.object({ id: zUuid })
export type ReversePurchasePaymentInput = z.input<typeof reversePurchasePaymentInput>

/** `purchasePayment.list` (purchases.payments.view): the payments of one purchase. */
export const purchasePaymentsInput = z.object({ purchaseId: zUuid })
export type PurchasePaymentsInput = z.input<typeof purchasePaymentsInput>

export const purchasePaymentDto = z.object({
  id: zUuid,
  businessDate: zBusinessDate,
  method: settlementMethodDto,
  amount: price(),
  currency: z.string(),
  note: z.string().nullable(),
  /** `reversed`: recorded by mistake, it no longer counts. */
  status: z.enum(['recorded', 'reversed']),
  recordedBy: memberNameDto,
  createdAt: isoTimestamp,
  reversedAt: isoTimestamp.nullable(),
  reversedBy: memberNameDto.nullable(),
  /** The reversal's business day (the payment's own, or the first open day). */
  reversalDate: zBusinessDate.nullable(),
})
export type PurchasePaymentDto = z.infer<typeof purchasePaymentDto>

/** A purchase's payments and what is still owed on it. */
export const purchasePaymentsDto = withMeta(
  z.object({
    purchaseId: zUuid,
    /** Who it is owed to; null when it was paid when bought (cash, card…) or never said. */
    owedTo: z
      .object({
        party: payablePartyDto,
        partyId: zUuid,
        name: z.string(),
      })
      .nullable(),
    status: documentStatusDto,
    currency: z.string(),
    total: price(),
    returned: price(),
    paid: price(),
    /** What can still be paid (0 unless it is final and owed). */
    outstanding: price(),
    /**
     * What was paid beyond what it came to after its final returns and credit notes (paid − (total −
     * returned), 0 when not more): a return or credit note posted after it was paid leaves it owed
     * back to the business, which nothing else tracks yet (D-162).
     */
    overpaid: price(),
    /** Newest first; reversed ones too. */
    payments: z.array(purchasePaymentDto),
  }),
)
export type PurchasePaymentsDto = z.infer<typeof purchasePaymentsDto>

// ---------------------------------------------------------------------------------------------------
// The books-closed date (D-114 rule 6)
// ---------------------------------------------------------------------------------------------------

export const booksDto = z.object({
  /** Nothing dated on or before it can be posted or reversed; null: the books are open. */
  closedThrough: zBusinessDate.nullable(),
  /** Today in the business's time zone (a document dated later cannot be posted). */
  today: zBusinessDate,
})
export type BooksDto = z.infer<typeof booksDto>

/** `books.close` (purchases.books.close): a day up to today, or null to open the books again. */
export const closeBooksInput = z.object({ closedThrough: zBusinessDate.nullable() })
export type CloseBooksInput = z.input<typeof closeBooksInput>

// ---------------------------------------------------------------------------------------------------
// The material cost view (D-115)
// ---------------------------------------------------------------------------------------------------

/** `material.costs`: the materials of a page (unique ids). */
export const materialCostsInput = z.object({
  ids: z
    .array(zUuid)
    .min(1)
    .max(MATERIAL_COSTS_MAX)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'duplicate id' }),
})
export type MaterialCostsInput = z.input<typeof materialCostsInput>

/**
 * Which average is shown (the page says it, D-115): until the business's first stock count, the
 * average of the material's purchases in the last 90 days, or, with none in that window, the unit
 * cost of its last purchase. After the first count (Phase 4): the stock average.
 */
export const averageBasisDto = z.enum(['purchases_90_days', 'last_purchase'])

export const materialCostDto = z.object({
  materialId: zUuid,
  /** The unit the material is counted in (perUnit is per one of it). */
  unit: standardUnitDto,
  /** Null: never bought (the page says "no price yet", never 0). */
  average: z
    .object({
      basis: averageBasisDto,
      /** The 90 days: from and to (today in the business's time zone). */
      from: zBusinessDate,
      to: zBusinessDate,
      perUnit: sensitive(zDecimal, 'cost'),
      perBaseUnit: sensitive(zDecimal, 'cost'),
    })
    .nullable(),
  /** The last purchase line of it that is still standing (not reversed, not all returned). */
  lastPurchase: z
    .object({
      purchaseId: zUuid,
      businessDate: zBusinessDate,
      /** What was bought, in its purchase unit. */
      qty: zDecimal,
      unit: standardUnitDto.nullable(),
      packId: zUuid.nullable(),
      packName: z.string().nullable(),
      /** What one purchase unit really cost (after discounts, with delivery, VAT when in cost). */
      pricePerPurchaseUnit: sensitive(zDecimal, 'supplier_price'),
      pricePerUnit: sensitive(zDecimal, 'supplier_price'),
      pricePerBaseUnit: sensitive(zDecimal, 'supplier_price'),
    })
    .nullable(),
})
export type MaterialCostDto = z.infer<typeof materialCostDto>

export const materialCostsDto = withMeta(z.object({ items: z.array(materialCostDto) }))
export type MaterialCostsDto = z.infer<typeof materialCostsDto>
