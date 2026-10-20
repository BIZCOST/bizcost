import {
  CREDIT_BY,
  CREDIT_NOTE_KINDS,
  CREDIT_REASONS,
  CUSTOMER_KINDS,
  EINVOICE_CREDIT_CASES,
  EMIRATES,
  INVOICE_BILLS,
  INVOICE_CREDIT_STATES,
  INVOICE_KINDS,
  INVOICE_LINE_KINDS,
  INVOICE_STATUSES,
  VAT_CATEGORIES,
} from '@bizcost/domain'
import { z } from 'zod'
import {
  CREDIT_REASON_TEXT_MAX_LENGTH,
  INVOICE_LINES_MAX,
  INVOICE_LPO_MAX_LENGTH,
  INVOICE_NOTES_MAX_LENGTH,
  INVOICE_PAGE_SIZE,
  INVOICE_PAGE_SIZE_MAX,
  INVOICE_TERMS_MAX_LENGTH,
  QUOTATION_SITE_MAX_LENGTH,
  STATEMENT_DAYS_MAX,
} from '../documents'
import { zBusinessDate, zDecimal, zUuid } from '../primitives'
import { standardUnitDto } from './catalog'
import {
  discountDto,
  discountInput,
  moneyInput,
  percentInput,
  positiveMoneyInput,
  settlementMethodDto,
} from './purchases'
import { quotationLineInput, quotationVatRateDto } from './quotations'
import { documentPaymentStateDto, saleQtyInput } from './sales'
import { optionalLine } from './suppliers'

// Invoices, credit notes and customer statements (ROADMAP.md M3 Step 8; docs/DATA_MODEL.md §6; the
// owner's answers Q3, Q17, Q22, Q24–Q27 of D-218). An invoice is a draft until issued: issuing takes the
// next number of its gapless series (INV-0001…), dates it today, sets its kind by the VAT registration
// («فاتورة ضريبية · Tax Invoice», or a plain «فاتورة · Invoice» without it; never simplified) and freezes
// it with the seller's and the customer's particulars. An issued invoice is never edited: a credit note
// (its own series, CN-0001…) corrects it, by quantity or by amount, never more than is left. Made from
// an accepted quotation, an order or a recorded sale, an invoice bills everything, a part (a stage or a
// deposit, % or an amount) or the rest (Q22); counting once (Q3) decides whether issuing posts its sale.
// Once an order or a sale has an issued invoice, what is owed lives on its invoices (A2).
//
// Who (Q10): `invoices.documents.view` sees the business's invoices and credit notes (within one's
// branches, Q12); `.manage` prepares drafts (from scratch, a quotation, an order or a sale) and copies
// an invoice to a quotation; `.issue` issues; `.credit` prepares and issues credit notes. Prices are not
// sensitive (D-187); what an invoice is paid and owes shows with `payments.customers.view`.

const isoTimestamp = z.iso.datetime({ offset: true })

export const invoiceStatusDto = z.enum(INVOICE_STATUSES)
export const invoiceKindDto = z.enum(INVOICE_KINDS)
export const invoiceBillsDto = z.enum(INVOICE_BILLS)
export const invoiceLineKindDto = z.enum(INVOICE_LINE_KINDS)
export const invoiceCreditStateDto = z.enum(INVOICE_CREDIT_STATES)
export const creditNoteKindDto = z.enum(CREDIT_NOTE_KINDS)
export const creditReasonDto = z.enum(CREDIT_REASONS)
export const creditByDto = z.enum(CREDIT_BY)

/** No control character but line breaks (each kind stored as \n); '' means none. */
const MULTILINE_CONTROL = /(?!\n)\p{Cc}/u
function multilineInput(max: number) {
  return z
    .string()
    .overwrite((value) => value.replace(/\r\n?/g, '\n'))
    .trim()
    .max(max)
    .refine((value) => !MULTILINE_CONTROL.test(value), { message: 'control character' })
    .nullish()
    .transform((value) => (value ? value : null))
}

const uniqueIds = (items: readonly { id: string }[]) =>
  new Set(items.map((item) => item.id)).size === items.length

/**
 * A line of an invoice made from scratch: a product or service of the business, or typed (Q21), with
 * an optional area, details and a red note, as a quotation's line (D-299: each area's lines saved
 * together).
 */
export const invoiceLineInput = quotationLineInput
export type InvoiceLineInput = z.input<typeof invoiceLineInput>

/** What part of its source an invoice bills: a % or an amount of the source's payable. */
export const billPartInput = z.union([
  z.object({ percent: percentInput.refine((v) => !/^0+(\.0+)?$/.test(v), 'more than zero') }),
  z.object({ amount: positiveMoneyInput }),
])
export type BillPartInput = z.input<typeof billPartInput>

const headerFields = {
  /** The branch it is issued from; null: the default location (another needs branches). */
  locationId: zUuid.nullable().default(null),
  /** The channel its sale posts on, when the business has several active ones (null: its only one). */
  channelId: zUuid.nullable().default(null),
  /** The date of supply (on or before today; null: the issue date). */
  supplyDate: zBusinessDate.nullable().default(null),
  /** When it is due (on or after the issue date); null: not said. */
  dueDate: zBusinessDate.nullable().default(null),
  lpoReference: optionalLine(INVOICE_LPO_MAX_LENGTH),
  /** The project or site the work is for ("Villa 12, Al Barsha"), printed with the customer. */
  site: optionalLine(QUOTATION_SITE_MAX_LENGTH),
  /**
   * "Is this sale already in your recorded sales (Today's sales, an import or your POS)?" (Q3): required
   * when the invoice asks it (`asksCountedElsewhere`), never preselected; null: not answered.
   */
  countedElsewhere: z.boolean().nullable().default(null),
  terms: multilineInput(INVOICE_TERMS_MAX_LENGTH),
  notes: multilineInput(INVOICE_NOTES_MAX_LENGTH),
}

/**
 * `invoice.create` (invoices.documents.manage): a draft from scratch (no number until issued),
 * idempotent on the client's `id`. Its customer is required (a tax invoice names its buyer).
 */
export const createInvoiceInput = z.object({
  id: zUuid,
  customerId: zUuid,
  ...headerFields,
  /** A discount on the whole invoice: a % of its lines, or an amount typed like their prices. */
  discount: discountInput.nullish().transform((value) => value ?? null),
  /** "Round the total" («تقريب الإجمالي», D-221): the total wanted, with VAT; null: none. */
  roundTo: moneyInput.nullish().transform((value) => value ?? null),
  lines: z
    .array(invoiceLineInput)
    .max(INVOICE_LINES_MAX)
    .default([])
    .refine(uniqueIds, { message: 'duplicate line id' }),
})
export type CreateInvoiceInput = z.input<typeof createInvoiceInput>

/**
 * `invoice.update` (a draft): its header whole, `version` as read. A draft made from scratch also takes
 * its customer, lines, discount and "Round the total" (left out: kept); one made from a quotation, an
 * order or a sale keeps its customer and lines (VALIDATION when they are sent).
 */
export const updateInvoiceInput = z.object({
  id: zUuid,
  version: z.int().positive(),
  customerId: zUuid.optional(),
  ...headerFields,
  discount: discountInput.nullish().optional(),
  roundTo: moneyInput.nullish().optional(),
  lines: z
    .array(invoiceLineInput)
    .max(INVOICE_LINES_MAX)
    .refine(uniqueIds, { message: 'duplicate line id' })
    .optional(),
})
export type UpdateInvoiceInput = z.input<typeof updateInvoiceInput>

/** `invoice.get`, `invoice.history`, `invoice.pdf`. */
export const invoiceIdInput = z.object({ id: zUuid })
export type InvoiceIdInput = z.input<typeof invoiceIdInput>

/** `invoice.discard` and `invoice.issue` (a draft; a repeated issue returns it as issued). */
export const invoiceVersionInput = z.object({ id: zUuid, version: z.int().positive() })
export type InvoiceVersionInput = z.input<typeof invoiceVersionInput>

const billFields = {
  /** What it bills: everything (nothing billed yet), a part, or the rest. */
  bills: invoiceBillsDto.default('everything'),
  /** The part (`bills: part`): a % or an amount of the source's payable. */
  part: billPartInput.nullish().transform((value) => value ?? null),
  /** A deposit invoice (a part, before the work: the final invoice counts the whole work, Q22). */
  isDeposit: z.boolean().default(false),
}

const partFits = (input: { bills: string; part: unknown; isDeposit: boolean }) =>
  (input.bills === 'part') === (input.part !== null) && (!input.isDeposit || input.bills === 'part')
const partMessage = { message: 'a part for `part` only; a deposit is a part', path: ['part'] }

/**
 * `invoice.fromQuotation` (invoices.documents.manage): a draft `newId` from an accepted quotation
 * revision, billing everything, a part, the rest, or one of its payment stages by its stored amount
 * (`stage`, 0-based: the last stage bills the rest, D-296). Idempotent on `newId`.
 */
export const invoiceFromQuotationInput = z
  .object({
    id: zUuid,
    newId: zUuid,
    ...billFields,
    stage: z.int().min(0).max(9).nullable().default(null),
  })
  .refine((input) => (input.stage === null ? partFits(input) : input.part === null), {
    message: 'a stage bills its own amount; a part for `part` only; a deposit is a part',
    path: ['part'],
  })
export type InvoiceFromQuotationInput = z.input<typeof invoiceFromQuotationInput>

/** `invoice.fromOrder` (invoices.documents.manage): a draft `newId` from an order. Idempotent on `newId`. */
export const invoiceFromOrderInput = z
  .object({ orderId: zUuid, newId: zUuid, ...billFields })
  .refine(partFits, partMessage)
export type InvoiceFromOrderInput = z.input<typeof invoiceFromOrderInput>

/**
 * `invoice.fromSale` (invoices.documents.manage): a draft `newId` billing a finalized One sale (its
 * lines; what she is owed moves to the invoice once issued). Idempotent on `newId`.
 */
export const invoiceFromSaleInput = z.object({ saleId: zUuid, newId: zUuid })
export type InvoiceFromSaleInput = z.input<typeof invoiceFromSaleInput>

/**
 * `invoice.copyToQuotation` (invoices.documents.manage with Quotations on and
 * quotations.documents.manage): a new quotation draft `newId` with the invoice's customer and lines
 * (deductions left out). Idempotent on `newId`.
 */
export const invoiceCopyToQuotationInput = z.object({ id: zUuid, newId: zUuid })
export type InvoiceCopyToQuotationInput = z.input<typeof invoiceCopyToQuotationInput>

/**
 * `invoice.list`: newest first (drafts by when they were made, issued ones by number); `status`
 * filters (owed, overdue and paid need payments.customers.view); the search finds the number, the LPO
 * and the customer's name.
 */
export const invoiceListInput = z
  .object({
    status: z
      .enum(['all', 'draft', 'issued', 'owed', 'overdue', 'paid', 'credited'])
      .default('all'),
    customerId: zUuid.optional(),
    orderId: zUuid.optional(),
    quotationId: zUuid.optional(),
    search: z.string().trim().max(100).optional(),
    cursor: z.string().min(1).max(500).optional(),
    limit: z.int().min(1).max(INVOICE_PAGE_SIZE_MAX).default(INVOICE_PAGE_SIZE),
  })
  .prefault({})
export type InvoiceListInput = z.input<typeof invoiceListInput>

/** A party's particulars as printed (the customer: live on a draft, frozen once issued). */
export const invoicePartyDto = z.object({
  name: z.string(),
  /** The customer's kind (person, business, government); null for the seller. */
  kind: z.enum(CUSTOMER_KINDS).nullable(),
  /** The seller's Arabic legal name; null for the customer. */
  nameAr: z.string().nullable(),
  trn: z.string().nullable(),
  tradeLicence: z.string().nullable(),
  /** Who issued the seller's trade licence; null for the customer. */
  tradeLicenceAuthority: z.string().nullable(),
  addressLine: z.string().nullable(),
  city: z.string().nullable(),
  emirate: z.enum(EMIRATES).nullable(),
  country: z.string().nullable(),
})
export type InvoicePartyDto = z.infer<typeof invoicePartyDto>

/** What credit notes took of a line, and what is left to credit. */
export const lineCreditDto = z.object({
  qty: zDecimal,
  net: zDecimal,
  vat: zDecimal,
  total: zDecimal,
})

export const invoiceLineDto = z.object({
  id: zUuid,
  kind: invoiceLineKindDto,
  productId: zUuid.nullable(),
  /** No product: typed (also a stage's or a deposit's line). */
  typed: z.boolean(),
  area: z.string().nullable(),
  description: z.string(),
  details: z.string().nullable(),
  note: z.string().nullable(),
  qty: zDecimal,
  unit: standardUnitDto.nullable(),
  unitPrice: zDecimal,
  priceIncludesVat: z.boolean(),
  discount: discountDto.nullable(),
  vatCategory: z.enum(VAT_CATEGORIES).nullable(),
  vatRate: zDecimal.nullable(),
  subtotal: zDecimal,
  lineDiscount: zDecimal,
  net: zDecimal,
  vat: zDecimal,
  total: zDecimal,
  /** A deduction: the deposit invoice it takes off, and its number. */
  depositInvoiceId: zUuid.nullable(),
  depositInvoiceNumber: z.string().nullable(),
  /** What issued credit notes took of it. */
  credited: lineCreditDto,
  /** What is left to credit (zero for a deduction). */
  left: lineCreditDto,
  /** Its picture (an attachment of entity invoice_line), with a signed URL; null: none. */
  picture: z.object({ id: zUuid, fileName: z.string(), url: z.string().nullable() }).nullable(),
})
export type InvoiceLineDto = z.infer<typeof invoiceLineDto>

/** A credit note of an invoice, as the invoice lists it. */
export const invoiceCreditNoteRefDto = z.object({
  id: zUuid,
  number: z.string().nullable(),
  status: invoiceStatusDto,
  issueDate: zBusinessDate.nullable(),
  total: zDecimal,
})

/**
 * What would stop or warn an issue (B16, C5): `missing` stops it (DETAILS_MISSING): the business's
 * TRN or address for a tax invoice, a VAT-registered customer's address; `warnings` do not
 * (`ibr_143_ae`: the business's address line, city and emirate; `ibr_144_ae`: a business customer's,
 * which PINT-AE requires from the connector milestone; `late`: the supply is more than 14 days old,
 * VAT DL Art. 67(1)).
 */
export const ISSUE_MISSING = [
  'business_trn',
  'business_address',
  'customer_address',
  'channel',
  'currency_aed',
] as const
export const ISSUE_WARNINGS = ['ibr_143_ae', 'ibr_144_ae', 'late'] as const

export const invoiceDto = z.object({
  id: zUuid,
  /** As printed ("INV-0001"); null until issued. */
  number: z.string().nullable(),
  seq: z.int().positive().nullable(),
  /** `tax_invoice` or a plain `invoice` (a draft: the kind it will take now). */
  kind: invoiceKindDto,
  status: invoiceStatusDto,
  customerId: zUuid,
  customerPhoneLast4: z.string().nullable(),
  /** The customer as printed: live on a draft, frozen once issued. */
  customer: invoicePartyDto,
  /** The seller as frozen at issue; null on a draft. */
  seller: invoicePartyDto.nullable(),
  locationId: zUuid,
  locationName: z.string(),
  channelId: zUuid.nullable(),
  issueDate: zBusinessDate.nullable(),
  /** As typed on a draft (null: the issue date); set at issue. */
  supplyDate: zBusinessDate.nullable(),
  dueDate: zBusinessDate.nullable(),
  lpoReference: z.string().nullable(),
  vatRegistered: z.boolean(),
  currency: z.string(),
  /** What it is made from. */
  quotationId: zUuid.nullable(),
  quotationNumber: z.string().nullable(),
  orderId: zUuid.nullable(),
  orderNumber: z.string().nullable(),
  /** Its order's delivery day once delivered (its sale counted then, Q3); null otherwise. */
  orderDeliveredOn: zBusinessDate.nullable(),
  saleId: zUuid.nullable(),
  /** The project or site (copied from its quotation, or typed). */
  site: z.string().nullable(),
  /** A quotation's payment stage it bills (0-based); null otherwise. */
  billStage: z.int().nonnegative().nullable(),
  bills: invoiceBillsDto,
  part: z.union([z.object({ percent: zDecimal }), z.object({ amount: zDecimal })]).nullable(),
  isDeposit: z.boolean(),
  countedElsewhere: z.boolean().nullable(),
  /** Its draft must answer "already in your recorded sales?" before it is issued. */
  asksCountedElsewhere: z.boolean(),
  /** Issuing it posts its sale (Q3); once issued: whether it did. */
  counts: z.boolean(),
  /** The day its sale counts (its supply date, or the first open day when its books were closed). */
  countedOn: zBusinessDate.nullable(),
  discount: discountDto.nullable(),
  roundTo: zDecimal.nullable(),
  adjustment: zDecimal,
  roundingDifference: zDecimal,
  subtotal: zDecimal,
  discountTotal: zDecimal,
  netTotal: zDecimal,
  vatTotal: zDecimal,
  total: zDecimal,
  /** What the customer is asked to pay (total + rounding difference). */
  payable: zDecimal,
  vatRates: z.array(quotationVatRateDto),
  terms: z.string().nullable(),
  notes: z.string().nullable(),
  lines: z.array(invoiceLineDto),
  creditNotes: z.array(invoiceCreditNoteRefDto),
  /** How much its issued credit notes took back (with VAT), and its credit state. */
  credited: zDecimal,
  creditState: invoiceCreditStateDto,
  /** Paid and owed (with payments.customers.view, once issued); null otherwise. */
  payment: documentPaymentStateDto.nullable(),
  /** It still owes after its due date (with payments.customers.view). */
  overdue: z.boolean().nullable(),
  /** The last day a tax invoice of its supply is due (supply + 14 days, VAT DL Art. 67(1)). */
  taxInvoiceDueBy: zBusinessDate.nullable(),
  missing: z.array(z.enum(ISSUE_MISSING)),
  warnings: z.array(z.enum(ISSUE_WARNINGS)),
  /** Its issued PDF is stored (else it is rendered again on the next `invoice.pdf`). */
  pdfStored: z.boolean(),
  issuedAt: isoTimestamp.nullable(),
  enteredByName: z.string().nullable(),
  mine: z.boolean(),
  createdAt: isoTimestamp,
  version: z.int().positive(),
})
export type InvoiceDto = z.infer<typeof invoiceDto>

export const invoiceListItemDto = z.object({
  id: zUuid,
  number: z.string().nullable(),
  kind: invoiceKindDto,
  status: invoiceStatusDto,
  customerId: zUuid,
  customerName: z.string(),
  issueDate: zBusinessDate.nullable(),
  supplyDate: zBusinessDate.nullable(),
  dueDate: zBusinessDate.nullable(),
  lpoReference: z.string().nullable(),
  currency: z.string(),
  payable: zDecimal,
  lineCount: z.int().nonnegative(),
  lineTitles: z.array(z.string()),
  isDeposit: z.boolean(),
  /** A quotation's payment stage it bills (0-based); null otherwise. */
  billStage: z.int().nonnegative().nullable(),
  orderId: zUuid.nullable(),
  orderNumber: z.string().nullable(),
  quotationId: zUuid.nullable(),
  quotationNumber: z.string().nullable(),
  credited: zDecimal,
  creditState: invoiceCreditStateDto,
  /** With payments.customers.view, once issued; null otherwise. */
  owed: zDecimal.nullable(),
  paymentState: z.enum(['unpaid', 'deposit', 'paid', 'overpaid']).nullable(),
  overdue: z.boolean().nullable(),
  enteredByName: z.string().nullable(),
  mine: z.boolean(),
  createdAt: isoTimestamp,
  version: z.int().positive(),
})
export type InvoiceListItemDto = z.infer<typeof invoiceListItemDto>

export const invoiceListDto = z.object({
  items: z.array(invoiceListItemDto),
  nextCursor: z.string().nullable(),
})
export type InvoiceListDto = z.infer<typeof invoiceListDto>

export const INVOICE_EVENT_KINDS = [
  'created',
  'edited',
  'issued',
  'credited',
  'paid',
  'payment_reversed',
  'discarded',
] as const
export type InvoiceEventKind = (typeof INVOICE_EVENT_KINDS)[number]

/**
 * `invoice.history`: what happened to the invoice, newest first, from its own columns, its credit notes
 * and its payments (amounts with payments.customers.view), with who and when from the audit log (never
 * its row data). Names only with a team.
 */
export const invoiceHistoryDto = z.object({
  events: z.array(
    z.object({
      kind: z.enum(INVOICE_EVENT_KINDS),
      at: isoTimestamp,
      byName: z.string().nullable(),
      /** `issued`: its number; `credited`: the credit note's; null otherwise. */
      reference: z.string().nullable(),
      /** `credited`, `paid`, `payment_reversed`: the amount; null otherwise. */
      amount: zDecimal.nullable(),
    }),
  ),
})
export type InvoiceHistoryDto = z.infer<typeof invoiceHistoryDto>

/** A deposit recorded on an order without its tax invoice yet (M6), with its 14-day deadline. */
export const depositWithoutInvoiceDto = z.object({
  orderId: zUuid,
  orderNumber: z.string(),
  customerId: zUuid.nullable(),
  customerName: z.string().nullable(),
  paymentId: zUuid,
  paidOn: zBusinessDate,
  /** What of it no deposit invoice covers yet. */
  amount: zDecimal,
  currency: z.string(),
  /** Its tax invoice is due by (paid on + 14 days, VAT DL Art. 67(1)). */
  dueBy: zBusinessDate,
  late: z.boolean(),
})

/**
 * `invoice.depositsWithoutInvoice` (invoices.documents.view and payments.customers.view, a
 * VAT-registered business): each deposit paid on an order that no deposit tax invoice covers yet.
 */
export const depositsWithoutInvoiceDto = z.object({
  items: z.array(depositWithoutInvoiceDto),
})
export type DepositsWithoutInvoiceDto = z.infer<typeof depositsWithoutInvoiceDto>

// ---------------------------------------------------------------------------------------------------
// Credit notes
// ---------------------------------------------------------------------------------------------------

/** A line credited: by quantity (`qty`) or by amount (`amount`, as the line's prices are typed). */
export const creditNoteLineInput = z.object({
  invoiceLineId: zUuid,
  qty: saleQtyInput.optional(),
  amount: positiveMoneyInput.optional(),
})

const creditFields = {
  /** The day the reason happened (on or before today). */
  eventDate: zBusinessDate,
  reason: creditReasonDto,
  /** A brief explanation (ER Art. 60(1)(f)): required. */
  reasonText: optionalLine(CREDIT_REASON_TEXT_MAX_LENGTH).refine((v) => v !== null, {
    message: 'required',
  }),
  by: creditByDto,
  lines: z
    .array(creditNoteLineInput)
    .min(1)
    .refine((lines) => new Set(lines.map((l) => l.invoiceLineId)).size === lines.length, {
      message: 'a line twice',
    }),
  /** "Is this refund already in your recorded sales?" (on an invoice counted elsewhere). */
  countedElsewhere: z.boolean().nullable().default(null),
  notes: multilineInput(INVOICE_NOTES_MAX_LENGTH),
}

const byFits = (input: { by: string; lines: readonly { qty?: string; amount?: string }[] }) =>
  input.lines.every((l) =>
    input.by === 'quantity'
      ? l.qty !== undefined && l.amount === undefined
      : l.amount !== undefined && l.qty === undefined,
  )
const byMessage = { message: 'by quantity: qty on every line; by amount: amount', path: ['lines'] }

/** `creditNote.create` (invoices.documents.credit): a draft of an issued invoice, idempotent on `id`. */
export const createCreditNoteInput = z
  .object({ id: zUuid, invoiceId: zUuid, ...creditFields })
  .refine(byFits, byMessage)
export type CreateCreditNoteInput = z.input<typeof createCreditNoteInput>

/** `creditNote.update` (a draft): whole, `version` as read. */
export const updateCreditNoteInput = z
  .object({ id: zUuid, version: z.int().positive(), ...creditFields })
  .refine(byFits, byMessage)
export type UpdateCreditNoteInput = z.input<typeof updateCreditNoteInput>

export const creditNoteIdInput = z.object({ id: zUuid })
export const creditNoteVersionInput = z.object({ id: zUuid, version: z.int().positive() })

export const creditNoteListInput = z
  .object({
    status: z.enum(['all', 'draft', 'issued']).default('all'),
    invoiceId: zUuid.optional(),
    customerId: zUuid.optional(),
    search: z.string().trim().max(100).optional(),
    cursor: z.string().min(1).max(500).optional(),
    limit: z.int().min(1).max(INVOICE_PAGE_SIZE_MAX).default(INVOICE_PAGE_SIZE),
  })
  .prefault({})
export type CreditNoteListInput = z.input<typeof creditNoteListInput>

export const creditNoteLineDto = z.object({
  id: zUuid,
  invoiceLineId: zUuid,
  description: z.string(),
  qty: zDecimal,
  unit: standardUnitDto.nullable(),
  unitPrice: zDecimal,
  priceIncludesVat: z.boolean(),
  vatCategory: z.enum(VAT_CATEGORIES).nullable(),
  vatRate: zDecimal.nullable(),
  net: zDecimal,
  vat: zDecimal,
  total: zDecimal,
})
export type CreditNoteLineDto = z.infer<typeof creditNoteLineDto>

export const creditNoteDto = z.object({
  id: zUuid,
  number: z.string().nullable(),
  seq: z.int().positive().nullable(),
  /** `tax_credit_note` for a tax invoice, a plain `credit_note` for a plain one. */
  kind: creditNoteKindDto,
  status: invoiceStatusDto,
  invoiceId: zUuid,
  invoiceNumber: z.string(),
  invoiceIssueDate: zBusinessDate,
  customerId: zUuid,
  customer: invoicePartyDto,
  seller: invoicePartyDto.nullable(),
  locationId: zUuid,
  issueDate: zBusinessDate.nullable(),
  eventDate: zBusinessDate,
  /** A tax credit note is due within 14 days of its reason (VAT DL Art. 62(2)): the last day. */
  dueBy: zBusinessDate,
  /** Its reason is more than 14 days old (today on a draft, its issue date once issued). */
  late: z.boolean(),
  reason: creditReasonDto,
  reasonText: z.string(),
  /** The reason in each list: VAT DL Art. 61(1), PINT-AE BTAE-03, MD 243 Art. 6(2). */
  reasonLaw: z.object({
    vatLaw: z.enum(['a', 'b', 'c', 'd', 'e']),
    pintAe: z.string(),
    md243: z.enum(EINVOICE_CREDIT_CASES),
  }),
  by: creditByDto,
  countedElsewhere: z.boolean().nullable(),
  asksCountedElsewhere: z.boolean(),
  /** Issuing it posts a negative sale (Q3); once issued: whether it did. */
  counts: z.boolean(),
  countedOn: zBusinessDate.nullable(),
  vatRegistered: z.boolean(),
  currency: z.string(),
  netTotal: zDecimal,
  vatTotal: zDecimal,
  total: zDecimal,
  vatRates: z.array(quotationVatRateDto),
  /**
   * ER Art. 60(1)(e): the invoice's value of the supply (less earlier credit notes), the value after
   * this one, their difference and its VAT (worked out now on a draft, frozen once issued).
   */
  values: z.object({
    valueBefore: zDecimal,
    valueAfter: zDecimal,
    difference: zDecimal,
    vat: zDecimal,
  }),
  lines: z.array(creditNoteLineDto),
  notes: z.string().nullable(),
  pdfStored: z.boolean(),
  issuedAt: isoTimestamp.nullable(),
  enteredByName: z.string().nullable(),
  mine: z.boolean(),
  createdAt: isoTimestamp,
  version: z.int().positive(),
})
export type CreditNoteDto = z.infer<typeof creditNoteDto>

export const creditNoteListItemDto = z.object({
  id: zUuid,
  number: z.string().nullable(),
  kind: creditNoteKindDto,
  status: invoiceStatusDto,
  invoiceId: zUuid,
  invoiceNumber: z.string(),
  customerId: zUuid,
  customerName: z.string(),
  issueDate: zBusinessDate.nullable(),
  eventDate: zBusinessDate,
  reason: creditReasonDto,
  currency: z.string(),
  total: zDecimal,
  mine: z.boolean(),
  createdAt: isoTimestamp,
  version: z.int().positive(),
})
export type CreditNoteListItemDto = z.infer<typeof creditNoteListItemDto>

export const creditNoteListDto = z.object({
  items: z.array(creditNoteListItemDto),
  nextCursor: z.string().nullable(),
})
export type CreditNoteListDto = z.infer<typeof creditNoteListDto>

export const CREDIT_NOTE_EVENT_KINDS = ['created', 'edited', 'issued', 'discarded'] as const
export type CreditNoteEventKind = (typeof CREDIT_NOTE_EVENT_KINDS)[number]

export const creditNoteHistoryDto = z.object({
  events: z.array(
    z.object({
      kind: z.enum(CREDIT_NOTE_EVENT_KINDS),
      at: isoTimestamp,
      byName: z.string().nullable(),
      reference: z.string().nullable(),
    }),
  ),
})
export type CreditNoteHistoryDto = z.infer<typeof creditNoteHistoryDto>

// ---------------------------------------------------------------------------------------------------
// Customer statements (Q27)
// ---------------------------------------------------------------------------------------------------

/**
 * `customer.statement` / `customer.statementPdf` (payments.customers.view; served with Invoices until
 * Release B, B10): one customer's period, `from` to `to` (at most STATEMENT_DAYS_MAX days, never after
 * today).
 */
export const customerStatementInput = z
  .object({ customerId: zUuid, from: zBusinessDate, to: zBusinessDate })
  .refine((input) => input.from <= input.to, { message: 'from on or before to', path: ['to'] })
  .refine(
    (input) =>
      (Date.parse(`${input.to}T00:00:00Z`) - Date.parse(`${input.from}T00:00:00Z`)) / 86_400_000 <
      STATEMENT_DAYS_MAX,
    { message: 'a period of at most two years', path: ['from'] },
  )
export type CustomerStatementInput = z.input<typeof customerStatementInput>

export const STATEMENT_ENTRY_KINDS = [
  'invoice',
  'credit_note',
  'order',
  'sale',
  'refund',
  'payment',
  'money_back',
] as const
export type StatementEntryKind = (typeof STATEMENT_ENTRY_KINDS)[number]

export const statementEntryDto = z.object({
  date: zBusinessDate,
  kind: z.enum(STATEMENT_ENTRY_KINDS),
  /** The document (an invoice, a credit note, an order, a sale), or the payment. */
  id: zUuid,
  /** Its number ("INV-0001", "#1001"); null for a sale. */
  number: z.string().nullable(),
  /** What the payment was recorded on (its document's number), for a payment or money given back. */
  reference: z.string().nullable(),
  /** A sale paid when it was made and invoiced after: its payment, which has no record of its own. */
  paidWhenMade: z.boolean(),
  /** A sale's first items (what it was); empty for another entry. */
  itemNames: z.array(z.string()),
  /** How a payment or money given back was paid; null for another entry. */
  method: settlementMethodDto.nullable(),
  /**
   * What of the document was owed already through its order (`orderNumber`) or its sale (null): of an
   * invoice issued on a later day than its order's delivery or its sale, what they charged already (it
   * adds only `charge`); of a credit note that only billed less (D-305), what its order owes again (it
   * takes off only `credit`). Null for another entry (D-313).
   */
  owedThrough: z.object({ amount: zDecimal, orderNumber: z.string().nullable() }).nullable(),
  /**
   * What it adds to what is owed on its day (an invoice: less what its order or sale charged on an
   * earlier day; a delivered order: what its invoices did not bill by the end of its delivery day;
   * money given back), or zero. A past day's entries never change.
   */
  charge: zDecimal,
  /** What it takes off (a credit note, a refund, a payment), or zero. */
  credit: zDecimal,
  /** What is owed after it. */
  owed: zDecimal,
})
export type StatementEntryDto = z.infer<typeof statementEntryDto>

export const customerStatementDto = z.object({
  customerId: zUuid,
  customer: invoicePartyDto,
  currency: z.string(),
  from: zBusinessDate,
  to: zBusinessDate,
  /** Owed at the start of `from` (below zero: paid ahead). */
  opening: zDecimal,
  entries: z.array(statementEntryDto),
  /** Σ charges and Σ credits of the period: what was invoiced or delivered, credited and paid. */
  invoiced: zDecimal,
  credited: zDecimal,
  paid: zDecimal,
  /** Owed at the end of `to`. */
  closing: zDecimal,
})
export type CustomerStatementDto = z.infer<typeof customerStatementDto>
