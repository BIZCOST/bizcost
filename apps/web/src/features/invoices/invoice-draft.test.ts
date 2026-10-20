import type { InvoiceDto, ProductDto } from '@bizcost/contracts'
import { describe, expect, it } from 'vitest'
import { newQuotationLine } from '../quotations/quotation-draft'
import { creditNoteKindKey, invoiceKindKey, invoiceStateOf } from './states'
import {
  checkInvoice,
  invoiceDraft,
  isScratch,
  type InvoiceDraft,
  type InvoiceFormContext,
} from './invoice-draft'
import { periodOf } from './period'

// The invoice editor's model (M3 Step 8): what a draft from scratch and a sourced draft send, the
// header's checks (the date of supply, the due date, the channel), "already in your recorded sales?"
// sent only when asked and never preselected, the list's states and the documents' titles.

const TODAY = '2026-10-20'
const CUSTOMER = {
  id: '0f7c8d3e-1a2b-4c5d-8e9f-a0b1c2d3e4f5',
  name: 'Gulf Towers LLC',
  kind: 'business' as const,
  phone: null,
  phoneLast4: null,
  archived: false,
}

function context(over: Partial<InvoiceFormContext> = {}): InvoiceFormContext {
  return {
    currency: 'AED',
    vatRegistered: true,
    today: TODAY,
    products: new Map<string, ProductDto>(),
    sourced: false,
    asks: false,
    needsChannel: false,
    ...over,
  }
}

function scratch(over: Partial<InvoiceDraft> = {}): InvoiceDraft {
  const line = { ...newQuotationLine(), title: 'Glass partition', qty: '12', price: '850' }
  return {
    ...invoiceDraft(undefined, { locationId: null }),
    customer: CUSTOMER,
    lines: [line],
    ...over,
  }
}

describe('an invoice made from scratch', () => {
  it('needs its customer, then sends its lines, worked out as the API works them out', () => {
    expect(checkInvoice({ ...scratch(), customer: null }, context()).errors.customer?.key).toBe(
      'documents.invoices.editor.errors.customer',
    )
    const checked = checkInvoice(scratch({ lpoReference: ' LPO-4471 ' }), context())
    expect(checked.fields).toMatchObject({
      customerId: CUSTOMER.id,
      lpoReference: 'LPO-4471',
      supplyDate: null,
      dueDate: null,
      countedElsewhere: null,
      lines: [{ description: 'Glass partition', qty: '12', unitPrice: '850' }],
    })
    // 12 × 850 = 10,200.00 before VAT, 510.00 VAT at 5%: 10,710.00 to pay.
    expect(checked.amounts?.net).toBe('10200.00')
    expect(checked.amounts?.payable).toBe('10710.00')
  })

  it('rounds the total as a quotation does', () => {
    const checked = checkInvoice(scratch({ roundTo: '10700' }), context())
    expect(checked.rounding?.wanted).toBe('10700')
    expect(checked.amounts?.payable).toBe('10700.00')
  })
})

describe("a draft's header", () => {
  it('refuses a date of supply after today and a due date before the supply', () => {
    expect(
      checkInvoice(scratch({ supplyDate: '2026-10-21' }), context()).errors.supplyDate?.key,
    ).toBe('errors.future_date')
    expect(
      checkInvoice(scratch({ supplyDate: '2026-10-10', dueDate: '2026-10-09' }), context()).errors
        .dueDate?.key,
    ).toBe('documents.invoices.editor.errors.dueBefore')
    expect(
      checkInvoice(scratch({ supplyDate: '2026-10-10', dueDate: '2026-11-09' }), context()).fields,
    ).toMatchObject({ supplyDate: '2026-10-10', dueDate: '2026-11-09' })
  })

  it('asks for the channel when its sale posts and the business has several', () => {
    const checked = checkInvoice(scratch(), context({ needsChannel: true }))
    expect(checked.errors.channel?.key).toBe('documents.invoices.editor.errors.channel')
    expect(checked.fields).toBeNull()
  })

  it('sends "already in your recorded sales?" only when it is asked, never preselected', () => {
    expect(invoiceDraft(undefined, { locationId: null }).countedElsewhere).toBe('')
    expect(checkInvoice(scratch({ countedElsewhere: 'yes' }), context()).fields).toMatchObject({
      countedElsewhere: null,
    })
    expect(
      checkInvoice(scratch({ countedElsewhere: 'yes' }), context({ asks: true })).fields,
    ).toMatchObject({ countedElsewhere: true })
    expect(
      checkInvoice(scratch({ countedElsewhere: 'no' }), context({ asks: true })).fields,
    ).toMatchObject({ countedElsewhere: false })
    expect(checkInvoice(scratch(), context({ asks: true })).fields).toMatchObject({
      countedElsewhere: null,
    })
  })

  it('a draft made from a source sends its header only: never its customer or lines', () => {
    const fields = checkInvoice(
      {
        ...scratch({ dueDate: '2026-11-19', site: ' Villa 18, Al Barsha ' }),
        customer: null,
        lines: [],
      },
      context({ sourced: true }),
    ).fields
    expect(fields).toEqual({
      locationId: null,
      channelId: null,
      supplyDate: null,
      dueDate: '2026-11-19',
      lpoReference: null,
      // The project or site (D-315), trimmed.
      site: 'Villa 18, Al Barsha',
      countedElsewhere: null,
      terms: null,
      notes: null,
    })
  })
})

describe('a saved draft in the editor', () => {
  it('keeps its items (never a deposit taken off) and its answer', () => {
    const line = {
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'item',
      productId: null,
      typed: true,
      area: 'Kitchen',
      description: 'Kitchen island',
      details: null,
      note: null,
      qty: '1',
      unit: null,
      unitPrice: '8000',
      priceIncludesVat: false,
      discount: null,
      vatCategory: 'standard',
      vatRate: '5',
      picture: null,
    }
    const invoice = {
      customerId: CUSTOMER.id,
      customer: { name: CUSTOMER.name, kind: 'business' },
      customerPhoneLast4: null,
      locationId: '22222222-2222-4222-8222-222222222222',
      channelId: null,
      supplyDate: '2026-10-12',
      dueDate: null,
      lpoReference: 'LPO-CLN-131',
      countedElsewhere: false,
      terms: null,
      notes: 'Thank you.',
      discount: null,
      roundTo: null,
      quotationId: null,
      orderId: null,
      saleId: null,
      lines: [line, { ...line, id: '33333333-3333-4333-8333-333333333333', kind: 'deduction' }],
    } as unknown as InvoiceDto
    const draft = invoiceDraft(invoice, { locationId: null })
    expect(draft.lines.map((l) => l.title)).toEqual(['Kitchen island'])
    expect(draft.countedElsewhere).toBe('no')
    expect(draft.supplyDate).toBe('2026-10-12')
    expect(isScratch(invoice)).toBe(true)
    expect(isScratch({ ...invoice, orderId: line.id })).toBe(false)
  })
})

describe('what the list shows', () => {
  const base = {
    status: 'issued',
    creditState: 'none',
    overdue: false,
    paymentState: null,
  } as const
  it('a draft, credited in full, overdue, owed, part paid, paid, or just issued', () => {
    expect(invoiceStateOf({ ...base, status: 'draft' })).toBe('draft')
    expect(invoiceStateOf({ ...base, creditState: 'credited', overdue: true })).toBe('credited')
    expect(invoiceStateOf({ ...base, overdue: true, paymentState: 'unpaid' })).toBe('overdue')
    expect(invoiceStateOf({ ...base, paymentState: 'unpaid' })).toBe('owed')
    expect(invoiceStateOf({ ...base, paymentState: 'deposit' })).toBe('partPaid')
    expect(invoiceStateOf({ ...base, paymentState: 'paid' })).toBe('paid')
    expect(invoiceStateOf(base)).toBe('issued')
  })

  it('titles a plain invoice and credit note without "tax" (Q26)', () => {
    expect(invoiceKindKey('tax_invoice')).toBe('documents.invoices.kinds.taxInvoice')
    expect(invoiceKindKey('invoice')).toBe('documents.invoices.kinds.invoice')
    expect(creditNoteKindKey('tax_credit_note')).toBe('documents.invoices.kinds.taxCreditNote')
    expect(creditNoteKindKey('credit_note')).toBe('documents.invoices.kinds.creditNote')
  })
})

describe("a statement's periods", () => {
  it('this month to today, last month whole, the last three months, this year', () => {
    expect(periodOf('thisMonth', TODAY)).toEqual({ from: '2026-10-01', to: TODAY })
    expect(periodOf('lastMonth', TODAY)).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(periodOf('last3', TODAY)).toEqual({ from: '2026-08-01', to: TODAY })
    expect(periodOf('thisYear', TODAY)).toEqual({ from: '2026-01-01', to: TODAY })
    // Across the year's start.
    expect(periodOf('lastMonth', '2027-01-15')).toEqual({ from: '2026-12-01', to: '2026-12-31' })
    expect(periodOf('last3', '2027-02-03')).toEqual({ from: '2026-12-01', to: '2027-02-03' })
  })
})
