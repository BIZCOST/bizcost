import { z } from 'zod'
import {
  CUSTOMER_PAYMENT_PAGE_SIZE,
  PAY_MANY_DOCUMENTS_MAX,
  RECEIVABLE_PAGE_SIZE,
} from '../customers'
import { zBusinessDate, zDecimal, zUuid } from '../primitives'
import { PAYMENT_NOTE_MAX_LENGTH } from '../purchasing'
import { orderStatusDto, paymentStateDto } from './orders'
import { memberNameDto, paymentKindDto, positiveMoneyInput, settlementMethodDto } from './purchases'

// Customer payments and what customers owe (ROADMAP.md M3 Step 5; the owner's answer Q17 = A of
// D-218, as supplier payments: D-159, D-160, D-162). One payment names one order or one sale "they'll
// pay later" (an invoice in Step 8): a payment towards what is owed (deposits and part payments too),
// or money given back (a refund, or a cancelled order's deposit). The method is required and never
// preselected; a payment is never edited (a mistake is reversed) and never more than is owed
// (EXCEEDS_OUTSTANDING), money given back never more than was paid beyond it. One figure per
// obligation (A2): the sale a delivered order posted owes nothing, the order does. No output field is
// named `balance` (the contract test walks every output); what is owed is `owed`.
//
// Keys: `payments.customers.view` (needs every sale seen, H1) lists them and what is owed;
// `payments.customers.record` records and reverses. Amounts are sales amounts, not a redaction
// category: who sees them is a permission.

const isoTimestamp = z.iso.datetime({ offset: true })

/**
 * What a customer payment pays: an order, a sale "they'll pay later", or an issued invoice (M3 Step 8;
 * once an order or a sale has one, what is owed lives on its invoices, A2).
 */
export const receivableKindDto = z.enum(['order', 'sale', 'invoice'])
export type ReceivableKindDto = z.infer<typeof receivableKindDto>

const noteInput = z
  .string()
  .trim()
  .max(PAYMENT_NOTE_MAX_LENGTH)
  .nullish()
  .transform((value) => (value ? value : null))

const oneDocument = (input: {
  orderId?: string | undefined
  saleId?: string | undefined
  invoiceId?: string | undefined
}) => [input.orderId, input.saleId, input.invoiceId].filter((id) => id !== undefined).length === 1
const oneDocumentMessage = { message: 'exactly one of orderId, saleId and invoiceId' }

export const customerPaymentDto = z.object({
  id: zUuid,
  /** `payment` towards what is owed, or `refund`: money given back to the customer. */
  kind: paymentKindDto,
  customerId: zUuid.nullable(),
  /** The customer's name as it is now. */
  customerName: z.string().nullable(),
  documentKind: receivableKindDto,
  documentId: zUuid,
  /** An order's number ("#1001") or an invoice's ("INV-0001"); null for a sale. */
  documentNumber: z.string().nullable(),
  businessDate: zBusinessDate,
  method: settlementMethodDto,
  amount: zDecimal,
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
export type CustomerPaymentDto = z.infer<typeof customerPaymentDto>

/**
 * An order or a sale "they'll pay later" and what it is owed (Q17): it comes to `total` (an order: 0
 * once cancelled), less its refunds (`credited`); `paid` the payments that stand, `refunded` the money
 * given back; `owed` what is still owed, `overpaid` what was paid beyond it ("money back to the
 * customer": a refund, or a cancelled order's deposit).
 */
export const owedDocumentDto = z.object({
  kind: receivableKindDto,
  id: zUuid,
  /** An order's or an invoice's number; null for a sale. */
  number: z.string().nullable(),
  /** An order's status; null for a sale. */
  orderStatus: orderStatusDto.nullable(),
  customerId: zUuid.nullable(),
  customerName: z.string().nullable(),
  /** The order's day, the sale's, or the invoice's issue date. */
  businessDate: zBusinessDate,
  /** An order's or an invoice's due day. */
  dueDate: zBusinessDate.nullable(),
  /** The names of its first two items. */
  itemNames: z.array(z.string()),
  currency: z.string(),
  total: zDecimal,
  credited: zDecimal,
  paid: zDecimal,
  refunded: zDecimal,
  owed: zDecimal,
  overpaid: zDecimal,
  state: paymentStateDto,
  /**
   * An order its issued invoices bill in part (M3 Step 8 review, D-313): this is what they do not bill
   * yet, owed on the order until its last invoice bills it (its payments count toward its invoices
   * first).
   */
  invoicedInPart: z.boolean(),
})
export type OwedDocumentDto = z.infer<typeof owedDocumentDto>

/**
 * `customerPayment.list` (payments.customers.view): the payments of one order or sale (reversed ones
 * too) with what it is owed (`document`), or of one customer, newest first, a page at a time
 * (`document` null).
 */
export const customerPaymentListInput = z
  .object({
    orderId: zUuid.optional(),
    saleId: zUuid.optional(),
    invoiceId: zUuid.optional(),
    customerId: zUuid.optional(),
    cursor: z.string().min(1).max(500).optional(),
    limit: z.int().min(1).max(CUSTOMER_PAYMENT_PAGE_SIZE).default(CUSTOMER_PAYMENT_PAGE_SIZE),
  })
  .refine(
    (input) =>
      [input.orderId, input.saleId, input.invoiceId, input.customerId].filter(
        (id) => id !== undefined,
      ).length === 1,
    { message: 'exactly one of orderId, saleId, invoiceId and customerId' },
  )
export type CustomerPaymentListInput = z.input<typeof customerPaymentListInput>

/**
 * An invoice made from an order or a sale: what that order's or sale's payments count toward it (A2: a
 * deposit invoice first, then by number), and where they were recorded; null otherwise.
 */
export const paymentsFromSourceDto = z
  .object({
    kind: z.enum(['order', 'sale']),
    id: zUuid,
    /** The order's number; null for a sale. */
    number: z.string().nullable(),
    amount: zDecimal,
  })
  .nullable()

export const customerPaymentListDto = z.object({
  document: owedDocumentDto.nullable(),
  /**
   * An invoice's own payments only; what the order or sale it was made from paid toward it is
   * `fromSource` (those payments are listed, and reversed, on that order or sale).
   */
  items: z.array(customerPaymentDto),
  fromSource: paymentsFromSourceDto,
  nextCursor: z.string().nullable(),
})
export type CustomerPaymentListDto = z.infer<typeof customerPaymentListDto>

/**
 * `customerPayment.record` (payments.customers.record): on a pending or delivered order, or a sale
 * "they'll pay later". Idempotent on the client's `id`. Its day in the business's time zone, not after
 * today (FUTURE_DATE), not on or before the books-closed date (BOOKS_CLOSED), not before the document
 * (VALIDATION); the amount more than zero, at most the currency's decimals (VALIDATION); a payment at
 * most what is still owed, money given back (`refund`) at most what was paid beyond it
 * (EXCEEDS_OUTSTANDING).
 */
export const recordCustomerPaymentInput = z
  .object({
    id: zUuid,
    orderId: zUuid.optional(),
    saleId: zUuid.optional(),
    invoiceId: zUuid.optional(),
    kind: paymentKindDto.default('payment'),
    businessDate: zBusinessDate,
    method: settlementMethodDto,
    amount: positiveMoneyInput,
    note: noteInput,
  })
  .refine(oneDocument, oneDocumentMessage)
export type RecordCustomerPaymentInput = z.input<typeof recordCustomerPaymentInput>

/**
 * `customerPayment.reverse` (payments.customers.record): a payment (or money given back) recorded by
 * mistake stops counting (it stays listed as reversed). Dated its own day, or the first open day when
 * the books are closed on it. Idempotent: a reversed payment is answered as it is.
 */
export const reverseCustomerPaymentInput = z.object({ id: zUuid })
export type ReverseCustomerPaymentInput = z.input<typeof reverseCustomerPaymentInput>

/** The payments panel after recording or reversing: the document, what it is owed, its payments. */
export const documentPaymentsDto = z.object({
  document: owedDocumentDto,
  items: z.array(customerPaymentDto),
  fromSource: paymentsFromSourceDto,
})
export type DocumentPaymentsDto = z.infer<typeof documentPaymentsDto>

/**
 * "Pay several at once" (`customerPayment.recordMany`, payments.customers.record; M14): one amount of
 * one customer, applied to the orders and sales listed, in their order (oldest first, or as chosen),
 * each up to what it still owes; one payment each, with its own client id, in one step. A document it
 * does not reach gets no payment. More than they owe in all is EXCEEDS_OUTSTANDING. Idempotent: the
 * same call again (any of its ids recorded already) returns what it recorded.
 */
export const recordManyCustomerPaymentsInput = z.object({
  customerId: zUuid,
  businessDate: zBusinessDate,
  method: settlementMethodDto,
  amount: positiveMoneyInput,
  note: noteInput,
  documents: z
    .array(
      z
        .object({
          id: zUuid,
          orderId: zUuid.optional(),
          saleId: zUuid.optional(),
          invoiceId: zUuid.optional(),
        })
        .refine(oneDocument, oneDocumentMessage),
    )
    .min(1)
    .max(PAY_MANY_DOCUMENTS_MAX)
    .refine((docs) => new Set(docs.map((d) => d.id)).size === docs.length, {
      message: 'duplicate payment id',
    })
    .refine(
      (docs) => new Set(docs.map((d) => d.orderId ?? d.saleId ?? d.invoiceId)).size === docs.length,
      { message: 'a document twice' },
    ),
})
export type RecordManyCustomerPaymentsInput = z.input<typeof recordManyCustomerPaymentsInput>

export const recordManyCustomerPaymentsDto = z.object({
  customerId: zUuid,
  /** The payments recorded, in the documents' order. */
  payments: z.array(customerPaymentDto),
  /** Each document listed, as it is now. */
  documents: z.array(owedDocumentDto),
})
export type RecordManyCustomerPaymentsDto = z.infer<typeof recordManyCustomerPaymentsDto>

/**
 * `receivable.list` ("What customers owe", payments.customers.view): the orders and sales "they'll pay
 * later" still owed, or paid beyond what they come to, by customer (by name; orders without a
 * customer last), RECEIVABLE_PAGE_SIZE customers a page. `customerId`: one customer's.
 */
export const receivableListInput = z
  .object({
    customerId: zUuid.optional(),
    cursor: z.string().min(1).max(500).optional(),
    limit: z.int().min(1).max(RECEIVABLE_PAGE_SIZE).default(RECEIVABLE_PAGE_SIZE),
  })
  .prefault({})
export type ReceivableListInput = z.input<typeof receivableListInput>

export const receivableGroupDto = z.object({
  /** Null: orders that name no customer. */
  customerId: zUuid.nullable(),
  name: z.string().nullable(),
  phoneLast4: z.string().nullable(),
  /** False for an archived customer (still owing). */
  active: z.boolean(),
  /** Σ owed of its orders and sales, and Σ paid beyond. */
  owed: zDecimal,
  overpaid: zDecimal,
  documentCount: z.int().nonnegative(),
  /** The oldest RECEIVABLE_DOCUMENTS_MAX of them, oldest first. */
  documents: z.array(owedDocumentDto),
})
export type ReceivableGroupDto = z.infer<typeof receivableGroupDto>

export const receivableListDto = z.object({
  currency: z.string(),
  /** What every customer owes (all pages), and what was paid beyond by them. */
  owed: zDecimal,
  overpaid: zDecimal,
  groups: z.array(receivableGroupDto),
  nextCursor: z.string().nullable(),
})
export type ReceivableListDto = z.infer<typeof receivableListDto>
