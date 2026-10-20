import type {
  BooksDto,
  CreditNoteDto,
  CustomerDto,
  InvoiceDto,
  OrderDto,
  QuotationDto,
  QuotationListDto,
} from '@bizcost/contracts'
import {
  compareDecimal,
  subtractDecimals,
  type CreditReason,
  type SettlementMethod,
} from '@bizcost/domain'
import { appCodeOf, type DemoApi } from './client'
import { demoId } from './costing'
import { addDays } from './days'

// The invoices of the demo businesses (M3 Step 8; Invoices is previewed by the demo's API, D-125):
// each one's own way of billing, through the same API as the screens: the fit-out company's stage
// invoices of an accepted quotation and a full tax invoice with a credit note; the factory's tax
// invoices of its delivered orders, each with the customer's LPO, one paid (its customers' statements
// come from them); the designer's plain invoice of a sale she recorded; the workshop's deposit tax
// invoice and final invoice of an order, an order's full invoice and a waiting order's deposit
// invoice. A registered customer gets the address a tax invoice prints for it (VAT ER Art. 59(1)(c)).
// Each invoice, credit note and payment has an id derived from its key (demoId), so it is written
// once: `pnpm demo:seed` stays idempotent and keeps what the owner did since. Every name and figure
// is fictional.

/** Where an invoice comes from, as the demo names it. */
export type DemoInvoiceSource =
  | {
      /** An accepted quotation, by the customer's reference the demo gave it (DEMO-…). */
      readonly quotation: string
      /** One of its payment stages (0-based; the last bills the rest). */
      readonly stage?: number
    }
  | {
      /** An order of the costing seed, by its key. */
      readonly order: string
      /** What it bills (default: everything). */
      readonly bills?: 'everything' | 'rest'
      /** A deposit invoice of what was paid on the order so far. */
      readonly deposit?: true
    }
  | {
      /** A One sale of the costing seed, by its key. */
      readonly sale: string
    }

export interface DemoCredit {
  readonly key: string
  readonly reason: CreditReason
  readonly reasonText: string
  readonly by: 'quantity' | 'amount'
  /** The invoice's lines credited, by their position (0-based). */
  readonly lines: readonly {
    readonly line: number
    readonly qty?: string
    readonly amount?: string
  }[]
}

export interface DemoInvoice {
  /** Its key (its id is derived from it): written once. */
  readonly key: string
  readonly from: DemoInvoiceSource
  /** Its date of supply, in days before the seed day (default: the day it is issued). */
  readonly supplyDaysAgo?: number
  /** Days after the issue it is due (default: none said). */
  readonly dueIn?: number
  /** The answer to "Is this sale already in your recorded sales?" where it is asked (default: no). */
  readonly countedElsewhere?: boolean
  /** Payments recorded on it after its issue (`owed`: what it still owes then). */
  readonly payments?: readonly {
    readonly key: string
    readonly method: SettlementMethod
    readonly amount: string | 'owed'
  }[]
  readonly credit?: DemoCredit
}

export interface DemoInvoices {
  /** Customers (costing keys) given an address when they have none. */
  readonly addresses?: readonly {
    readonly customer: string
    readonly addressLine: string
    readonly city: string
  }[]
  /** Quotations (by the demo's reference) accepted before they are invoiced, when only sent. */
  readonly accept?: readonly string[]
  readonly invoices: readonly DemoInvoice[]
}

/** What was written, for the summary. */
export interface InvoicesResult {
  readonly invoices: number
  readonly creditNotes: number
  readonly payments: number
}

interface Calls {
  readonly api: DemoApi
  readonly token: string
  readonly businessId: string
}

const query = <T>(c: Calls, path: string, input?: unknown) =>
  c.api.query<T>(path, c.token, c.businessId, input)
const mutate = <T>(c: Calls, path: string, input?: unknown) =>
  c.api.mutate<T>(path, c.token, c.businessId, input)

/** A record by id, or undefined when there is none. */
async function find<T>(c: Calls, path: string, input: unknown): Promise<T | undefined> {
  try {
    return await query<T>(c, path, input)
  } catch (error) {
    if (appCodeOf(error) === 'not_found') return undefined
    throw error
  }
}

/** The demo's quotation with the customer's reference `ref` (its latest revision), if any. */
async function quotationOf(c: Calls, ref: string): Promise<QuotationDto | undefined> {
  const found = await query<QuotationListDto>(c, 'quotation.list', { search: ref })
  const item = found.items.find((i) => i.customerRef === ref)
  return item ? query<QuotationDto>(c, 'quotation.get', { id: item.id }) : undefined
}

/** Gives a customer the address a tax invoice prints when it has none (kept otherwise). */
async function ensureAddress(
  c: Calls,
  spec: NonNullable<DemoInvoices['addresses']>[number],
): Promise<void> {
  const id = demoId(c.businessId, `customer:${spec.customer}`)
  const customer = await find<CustomerDto>(c, 'customer.get', { id })
  if (!customer || customer.addressLine || customer.city) return
  await mutate(c, 'customer.update', {
    id,
    version: customer.version,
    name: customer.name,
    kind: customer.kind,
    phone: customer.phone,
    email: customer.email,
    trn: customer.trn,
    tradeLicenceNo: customer.tradeLicenceNo,
    addressLine: spec.addressLine,
    city: spec.city,
    emirate: customer.emirate,
    country: customer.country,
    notes: customer.notes,
  })
}

/** The draft of `spec` (made once from its source; its id is derived from its key). */
async function draftOf(c: Calls, spec: DemoInvoice, id: string): Promise<InvoiceDto> {
  const from = spec.from
  if ('quotation' in from) {
    const quote = await quotationOf(c, from.quotation)
    if (!quote) throw new Error(`no demo quotation ${from.quotation}`)
    return mutate<InvoiceDto>(c, 'invoice.fromQuotation', {
      id: quote.id,
      newId: id,
      bills: 'everything',
      stage: from.stage ?? null,
    })
  }
  if ('order' in from) {
    const orderId = demoId(c.businessId, `order:${from.order}`)
    if (from.deposit) {
      const order = (await query<{ data: OrderDto }>(c, 'order.get', { id: orderId })).data
      const amount = order.payment
        ? subtractDecimals(order.payment.paid, order.payment.refunded)
        : '0'
      if (compareDecimal(amount, '0') <= 0) throw new Error(`order ${from.order} has no deposit`)
      return mutate<InvoiceDto>(c, 'invoice.fromOrder', {
        orderId,
        newId: id,
        bills: 'part',
        part: { amount },
        isDeposit: true,
      })
    }
    return mutate<InvoiceDto>(c, 'invoice.fromOrder', {
      orderId,
      newId: id,
      bills: from.bills ?? 'everything',
    })
  }
  return mutate<InvoiceDto>(c, 'invoice.fromSale', {
    saleId: demoId(c.businessId, `sale:${from.sale}`),
    newId: id,
  })
}

/** Writes one invoice (and its credit note and payments) when missing. */
async function seedInvoice(
  c: Calls,
  today: string,
  spec: DemoInvoice,
): Promise<{ invoice: number; credit: number; payments: number }> {
  const id = demoId(c.businessId, `invoice:${spec.key}`)
  let invoice = await find<InvoiceDto>(c, 'invoice.get', { id })
  let written = 0
  if (!invoice) {
    invoice = await draftOf(c, spec, id)
    written = 1
  }
  if (invoice.status === 'draft') {
    invoice = await mutate<InvoiceDto>(c, 'invoice.update', {
      id,
      version: invoice.version,
      locationId: invoice.locationId,
      channelId: invoice.channelId,
      // Its date of supply as typed, else as its source gives it (D-313).
      supplyDate:
        spec.supplyDaysAgo === undefined ? invoice.supplyDate : addDays(today, -spec.supplyDaysAgo),
      dueDate: spec.dueIn === undefined ? null : addDays(today, spec.dueIn),
      lpoReference: invoice.lpoReference,
      site: invoice.site,
      countedElsewhere: invoice.asksCountedElsewhere ? (spec.countedElsewhere ?? false) : null,
      terms: invoice.terms,
      notes: invoice.notes,
    })
    invoice = await mutate<InvoiceDto>(c, 'invoice.issue', { id, version: invoice.version })
    written = 1
  }

  let credit = 0
  if (spec.credit) {
    const noteId = demoId(c.businessId, `credit-note:${spec.credit.key}`)
    let note = await find<CreditNoteDto>(c, 'creditNote.get', { id: noteId })
    if (!note) {
      note = await mutate<CreditNoteDto>(c, 'creditNote.create', {
        id: noteId,
        invoiceId: id,
        eventDate: today,
        reason: spec.credit.reason,
        reasonText: spec.credit.reasonText,
        by: spec.credit.by,
        lines: spec.credit.lines.map((l) => {
          const line = invoice.lines[l.line]
          if (!line) throw new Error(`invoice ${spec.key} has no line ${l.line}`)
          return spec.credit!.by === 'quantity'
            ? { invoiceLineId: line.id, qty: l.qty }
            : { invoiceLineId: line.id, amount: l.amount }
        }),
        countedElsewhere: null,
        notes: null,
      })
      credit = 1
    }
    if (note.status === 'draft') {
      await mutate(c, 'creditNote.issue', { id: noteId, version: note.version })
      credit = 1
    }
  }

  let payments = 0
  for (const pay of spec.payments ?? []) {
    const paymentId = demoId(c.businessId, `invoice-payment:${spec.key}:${pay.key}`)
    const listed = await query<{ items: { id: string }[] }>(c, 'customerPayment.list', {
      invoiceId: id,
    })
    if (listed.items.some((p) => p.id === paymentId)) continue
    const current = await query<InvoiceDto>(c, 'invoice.get', { id })
    const amount = pay.amount === 'owed' ? (current.payment?.owed ?? '0') : pay.amount
    if (compareDecimal(amount, '0') <= 0) continue
    await mutate(c, 'customerPayment.record', {
      id: paymentId,
      invoiceId: id,
      businessDate: today,
      method: pay.method,
      amount,
      note: null,
    })
    payments += 1
  }
  return { invoice: written, credit, payments }
}

export async function seedInvoices(
  api: DemoApi,
  token: string,
  businessId: string,
  spec: DemoInvoices,
): Promise<InvoicesResult> {
  const c: Calls = { api, token, businessId }
  const { today } = await query<BooksDto>(c, 'books.get')
  for (const address of spec.addresses ?? []) await ensureAddress(c, address)
  for (const ref of spec.accept ?? []) {
    const quote = await quotationOf(c, ref)
    if (quote?.status === 'sent') {
      await mutate(c, 'quotation.accept', { id: quote.id, version: quote.version, note: null })
    }
  }
  let invoices = 0
  let creditNotes = 0
  let payments = 0
  for (const invoice of spec.invoices) {
    const done = await seedInvoice(c, today, invoice)
    invoices += done.invoice
    creditNotes += done.credit
    payments += done.payments
  }
  return { invoices, creditNotes, payments }
}

// ---------------------------------------------------------------------------------------------------
// Each business's invoices
// ---------------------------------------------------------------------------------------------------

/**
 * The fit-out company: the first two of the villa's three stages (50 / 35 / 15; the last waits for the
 * handover), the second paid; the office's partitions billed in full, then a credit note for the glass
 * not fitted.
 */
export const FITOUT_INVOICES: DemoInvoices = {
  addresses: [
    { customer: 'office', addressLine: 'مكتب 1204، برج الأعمال، الخليج التجاري', city: 'دبي' },
  ],
  invoices: [
    { key: 'villa-stage-1', from: { quotation: 'DEMO-FO-118', stage: 0 }, dueIn: 7 },
    {
      key: 'villa-stage-2',
      from: { quotation: 'DEMO-FO-118', stage: 1 },
      dueIn: 7,
      payments: [{ key: 'transfer', method: 'bank_transfer', amount: 'owed' }],
    },
    {
      key: 'office-partitions',
      from: { quotation: 'DEMO-FO-131' },
      supplyDaysAgo: 2,
      dueIn: 30,
      credit: {
        key: 'office-glass',
        reason: 'price_changed',
        reasonText: 'لم يُركَّب 4 م² من الزجاج المقسّى، واتفقنا على خصمها من الفاتورة.',
        by: 'quantity',
        lines: [{ line: 1, qty: '4' }],
      },
    },
  ],
}

/**
 * The factory: this month's delivered orders invoiced, each with its customer's LPO (the cleaning
 * company's paid by transfer); the hotel's 4,000 paid on its order counts toward its invoice.
 */
export const FACTORY_INVOICES: DemoInvoices = {
  addresses: [
    { customer: 'hotel', addressLine: 'شارع الشيخ زايد، مبنى 12', city: 'دبي' },
    { customer: 'supermarket', addressLine: 'شارع الوحدة، النهدة', city: 'الشارقة' },
    { customer: 'cleaning', addressLine: 'مستودع 4، القوز الصناعية 2', city: 'دبي' },
  ],
  invoices: [
    {
      key: 'cleaning-oct',
      from: { order: 'cleaning-oct' },
      supplyDaysAgo: 11,
      dueIn: 30,
      payments: [{ key: 'transfer', method: 'bank_transfer', amount: 'owed' }],
    },
    { key: 'supermarket-oct', from: { order: 'supermarket-oct' }, supplyDaysAgo: 6, dueIn: 30 },
    { key: 'hotel-lpo', from: { order: 'hotel-lpo' }, supplyDaysAgo: 5, dueIn: 30 },
  ],
}

/** The designer: a plain invoice of the brand identity she sold five days ago, to be paid later. */
export const DESIGNER_INVOICES: DemoInvoices = {
  invoices: [{ key: 'identity-brew', from: { sale: 'identity' }, supplyDaysAgo: 5, dueIn: 14 }],
}

/**
 * The workshop: the clinic's kitchen unit (a deposit tax invoice for the transfer it paid, then the
 * final invoice once delivered, the deposit taken off), the developer's wardrobes billed in full
 * against its LPO, and the waiting table's deposit invoice for its cheque.
 */
export const WORKSHOP_INVOICES: DemoInvoices = {
  addresses: [
    { customer: 'clinic', addressLine: 'شارع الملك فيصل، بناية الشفاء', city: 'الشارقة' },
    { customer: 'developer', addressLine: 'برج الريم، جزيرة الريم', city: 'أبوظبي' },
  ],
  invoices: [
    {
      key: 'clinic-kitchen-deposit',
      from: { order: 'clinic-kitchen', deposit: true },
      supplyDaysAgo: 9,
    },
    {
      key: 'clinic-kitchen-final',
      from: { order: 'clinic-kitchen', bills: 'rest' },
      supplyDaysAgo: 1,
      dueIn: 14,
    },
    { key: 'wardrobes', from: { order: 'wardrobes' }, supplyDaysAgo: 2, dueIn: 10 },
    { key: 'table-deposit', from: { order: 'table', deposit: true }, supplyDaysAgo: 4 },
  ],
}
