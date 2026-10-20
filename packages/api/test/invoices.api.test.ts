import type { InvoiceDto, OwedDocumentDto, ReceivableListDto } from '@bizcost/contracts'
import { newId, plusDays } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { formatDate } from '../src/documents/pdf/build'
import { normalizeText, pdfFullText } from '../src/documents/pdf/text-layer'
import { FACTORY } from './orders'
import { codeOf, ok } from './purchasing'
import { DESIGNER, quoteTyped } from './quotations'
import { BUYER_TRN, InvoiceScope, InvoicesApi, SELLER_TRN, typed } from './invoices'

// Invoices and credit notes through the API (ROADMAP.md M3 Step 8; the plan's definition of done):
// the fit-out company's tax invoice from its accepted quotation and its credit note, the 12
// particulars of VAT ER Art. 59(1) and the 7 of Art. 60(1) in the PDFs' text, stage invoices that add
// up to the quote, the workshop's deposit and final invoice, the designer's plain invoice from her
// recorded sale, counting once, one owed figure, the factory's statement, closed books.

const api = new InvoicesApi()
afterAll(() => api.close())

const decode = (base64: string) => new Uint8Array(Buffer.from(base64, 'base64'))

describe("the fit-out company's tax invoice (definition of done)", () => {
  let scope: InvoiceScope
  let invoice: InvoiceDto
  beforeAll(async () => {
    scope = await InvoiceScope.open(api)
    await scope.taxReady()
  })

  it('INV-0001 from accepted Q-0001: 13,725.00 + VAT 686.25 = 14,411.25', async () => {
    const customer = await scope.buyer({ name: 'Gulf Horizon Properties LLC' })
    const quote = await scope.quote({
      customerId: customer.id,
      customerRef: 'LPO-GH-2207',
      lines: [
        quoteTyped('Gypsum partition', '120', '45', { unit: 'm2' }),
        quoteTyped('Painting', '300', '18', { unit: 'm2' }),
        quoteTyped('Labour', '5', '650', { discount: { percent: '10' } }),
      ],
    })
    const accepted = await scope.accept(await scope.send(quote))
    const draft = await scope.fromQuotation(accepted.id)
    expect(draft).toMatchObject({
      status: 'draft',
      number: null,
      kind: 'tax_invoice',
      lpoReference: 'LPO-GH-2207',
      netTotal: '13725',
      vatTotal: '686.25',
      payable: '14411.25',
    })
    invoice = await scope.issue(draft)
    expect(invoice).toMatchObject({ status: 'issued', number: 'INV-0001', counts: true })
    expect(invoice.seller).toMatchObject({ trn: SELLER_TRN })
    expect(invoice.customer).toMatchObject({ trn: BUYER_TRN, name: 'Gulf Horizon Properties LLC' })
    expect(invoice.pdfStored).toBe(true)
  })

  it('its PDF holds the 12 particulars of VAT ER Art. 59(1)', async () => {
    const pdf = await scope.invoicePdf(invoice.id)
    const text = await pdfFullText(decode(pdf.base64))
    // (a) "Tax Invoice" clearly displayed, in both languages.
    expect(text).toContain('Tax Invoice')
    // The Arabic title as drawn; its ض‍ر ligature reads reversed in pdf.js (D-224's known limit).
    expect(text).toContain(normalizeText('فاتورة'))
    expect(text).toContain(normalizeText('يبية'))
    // (b) the supplier's name, address and TRN; (c) the recipient's.
    expect(text).toContain(normalizeText(invoice.seller!.name))
    expect(text).toContain('Warehouse 7, Al Quoz Industrial 3')
    expect(text).toContain(SELLER_TRN)
    expect(text).toContain('Gulf Horizon Properties LLC')
    expect(text).toContain('Office 1402, Marina Plaza')
    expect(text).toContain(BUYER_TRN)
    // (d) its sequential number; (e) the date of issue ((f) the date of supply is printed only when it
    // is another day: the next test).
    expect(text).toContain('INV-0001')
    expect(text).toContain(formatDate(invoice.issueDate!).en)
    // (g) each line's description; (h) unit price, quantity, VAT rate and amount; (i) the discount.
    expect(text).toContain('Gypsum partition')
    expect(text).toContain('45.00')
    expect(text).toContain('5,400.00')
    expect(text).toContain('5%')
    expect(text).toContain('325.00')
    // (j) the gross amount and (k) the VAT in AED.
    expect(text).toContain('14,411.25')
    expect(text).toContain('686.25')
    expect(text).toContain('AED')
    // It is the stored copy: the same bytes again.
    const again = await scope.invoicePdf(invoice.id)
    expect(again.base64).toBe(pdf.base64)
  })

  it('(f) the date of supply: an invoice of an order delivered 6 days before it prints both dates', async () => {
    const shop = await InvoiceScope.open(api)
    await shop.taxReady()
    const customer = await shop.buyer()
    const service = await shop.service('1000')
    const today = await shop.today()
    const deliveredOn = plusDays(today, -6)
    const order = await shop.order({
      businessDate: deliveredOn,
      customerId: customer.id,
      channelId: await shop.channelId(),
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '1000' }],
    })
    const issued = await shop.issue(
      await shop.fromOrder((await shop.deliver(order, deliveredOn)).id),
    )
    expect(issued).toMatchObject({ issueDate: today, supplyDate: deliveredOn })
    const text = await pdfFullText(decode((await shop.invoicePdf(issued.id)).base64))
    expect(text).toContain('Date of supply')
    expect(text).toContain(formatDate(deliveredOn).en)
    expect(text).toContain(formatDate(today).en)
  }, 60_000)

  it('a credit note for 100 m² of painting: CN-0001, credited 1,890.00, still owed 12,521.25', async () => {
    const painting = invoice.lines[1]!
    const note = await scope.credit(invoice.id, {
      by: 'quantity',
      reason: 'price_changed',
      reasonText: '100 m² of painting were not done',
      lines: [{ invoiceLineId: painting.id, qty: '100' }],
    })
    expect(note).toMatchObject({
      number: 'CN-0001',
      kind: 'tax_credit_note',
      netTotal: '1800',
      vatTotal: '90',
      total: '1890',
      values: { valueBefore: '13725', valueAfter: '11925' },
      reasonLaw: { pintAe: 'DL8.61.1.C', vatLaw: 'c', md243: 'reduced' },
    })
    const after = await scope.getInvoice(invoice.id)
    expect(after.payment).toMatchObject({ credited: '1890', owed: '12521.25' })
    expect(after.creditState).toBe('partly')
    // The invoice itself never changed.
    expect(after.payable).toBe('14411.25')
    expect(after.lines[1]!.left.qty).toBe('200')
  })

  it("the credit note's PDF holds the particulars of VAT ER Art. 60(1)", async () => {
    const [note] = (await scope.getInvoice(invoice.id)).creditNotes
    const pdf = await scope.creditNotePdf(note!.id)
    const text = await pdfFullText(decode(pdf.base64))
    // (a) "Tax Credit Note" clearly displayed, in both languages.
    expect(text).toContain('Tax Credit Note')
    expect(text).toContain(normalizeText('إشعار دائن'))
    // (b) the supplier's name, address and TRN; (c) the recipient's (registered).
    expect(text).toContain(normalizeText(invoice.seller!.name))
    expect(text).toContain('Warehouse 7, Al Quoz Industrial 3')
    expect(text).toContain(SELLER_TRN)
    expect(text).toContain('Gulf Horizon Properties LLC')
    expect(text).toContain('Office 1402, Marina Plaza')
    expect(text).toContain(BUYER_TRN)
    expect(text).toContain('CN-0001')
    // (d) its date of issue, and (g) the invoice's number and date (both today here).
    const today = formatDate(await scope.today()).en
    expect(text.split(today).length - 1).toBeGreaterThanOrEqual(2)
    expect(text).toContain('INV-0001')
    // (e) the value on the invoice, the correct value, the difference and its VAT, in AED.
    expect(text).toContain('13,725.00')
    expect(text).toContain('11,925.00')
    expect(text).toContain('1,800.00')
    expect(text).toContain('90.00')
    expect(text).toContain('AED')
    // (f) the reason: its kind and the explanation as typed.
    expect(text).toContain('Price changed')
    expect(text).toContain(normalizeText('100 m² of painting were not done'))
  })

  it('a credit note never takes more than is left (EXCEEDS_INVOICE)', async () => {
    const painting = invoice.lines[1]!
    const result = await scope.as(scope.owner, 'creditNote.create', {
      id: newId(),
      invoiceId: invoice.id,
      eventDate: await scope.today(),
      reason: 'goods_returned',
      reasonText: 'Too much',
      by: 'quantity',
      lines: [{ invoiceLineId: painting.id, qty: '201' }],
    })
    expect(codeOf(result)).toBe('exceeds_invoice')
  })

  it('a second credit note starts from the reduced value: its four AED figures of ER Art. 60(1)(e)', async () => {
    const gypsum = invoice.lines[0]!
    const second = await scope.credit(invoice.id, {
      by: 'amount',
      reason: 'price_changed',
      reasonText: 'Partition price agreed again',
      lines: [{ invoiceLineId: gypsum.id, amount: '925' }],
    })
    expect(second).toMatchObject({
      number: 'CN-0002',
      netTotal: '925',
      vatTotal: '46.25',
      values: { valueBefore: '11925', valueAfter: '11000' },
    })
    const text = await pdfFullText(decode((await scope.creditNotePdf(second.id)).base64))
    // The value before (the first credit note's correct value), the correct value, the difference
    // and its VAT, each in AED.
    for (const figure of ['11,925.00', '11,000.00', '925.00', '46.25'])
      expect(text).toContain(figure)
    expect(text).toContain('AED')
    expect((await scope.getInvoice(invoice.id)).payment).toMatchObject({
      credited: '2861.25',
      owed: '11550',
    })
  })

  it('an issued invoice is never edited or discarded', async () => {
    const current = await scope.getInvoice(invoice.id)
    const result = await scope.as(scope.owner, 'invoice.discard', {
      id: invoice.id,
      version: current.version,
    })
    expect(codeOf(result)).toBe('document_posted')
  })
})

describe('stage invoices of a quotation (Q22)', () => {
  it('30 / 40 / 30 of 10,000.00 + VAT give 3,150.00, 4,200.00 and 3,150.00, the last the rest', async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const customer = await scope.buyer()
    const quote = await scope.quote({
      customerId: customer.id,
      lines: [quoteTyped('Ceiling and lights', '1', '10000')],
      stages: [
        { due: 'On signing', percent: '30' },
        { due: 'On delivery', percent: '40' },
        { due: 'On handover', percent: '30' },
      ],
    })
    const accepted = await scope.accept(await scope.send(quote))
    const payables: string[] = []
    for (const stage of [0, 1, 2]) {
      const draft = await scope.fromQuotation(accepted.id, { stage })
      const issued = await scope.issue(draft)
      payables.push(issued.payable)
    }
    expect(payables).toEqual(['3150', '4200', '3150'])
    const all = (await scope.invoices({ quotationId: accepted.id })).items
    expect(all.map((i) => i.number)).toEqual(['INV-0003', 'INV-0002', 'INV-0001'])
    // Nothing is left to bill.
    const more = await scope.as(scope.owner, 'invoice.fromQuotation', {
      id: accepted.id,
      newId: newId(),
      bills: 'rest',
    })
    expect(codeOf(more)).toBe('validation')
  })
})

describe("the workshop's deposit and final invoice", () => {
  it('a deposit of 5,250 on 20,000 + VAT, then the final 15,750.00: VAT charged once, owed once', async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const customer = await scope.buyer({ name: `Faisal ${newId().slice(-4)}` })
    const service = await scope.service('20000')
    const order = await scope.order({
      customerId: customer.id,
      channelId: await scope.channelId(),
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '20000' }],
      payment: { id: newId(), method: 'bank_transfer', amount: '5250' },
    })
    expect(order.payable).toBe('21000')
    const deposit = await scope.issue(
      await scope.fromOrder(order.id, { bills: 'part', part: { amount: '5250' }, isDeposit: true }),
    )
    expect(deposit).toMatchObject({
      netTotal: '5000',
      vatTotal: '250',
      payable: '5250',
      counts: false,
    })
    // The deposit paid on the order pays the deposit invoice.
    expect(deposit.payment).toMatchObject({ owed: '0', state: 'paid' })
    const delivered = await scope.deliver(await scope.getOrder(order.id))
    const final = await scope.issue(await scope.fromOrder(delivered.id, { bills: 'rest' }))
    expect(final).toMatchObject({
      netTotal: '15000',
      vatTotal: '750',
      payable: '15750',
      counts: false,
    })
    expect(final.lines.filter((l) => l.kind === 'deduction')).toHaveLength(1)
    // VAT once: 250 + 750 = 1,000 on the work.
    expect(Number(deposit.vatTotal) + Number(final.vatTotal)).toBe(1000)
    // What customers owe: 15,750 once, on the final invoice.
    const owed = await scope.receivables({ customerId: customer.id })
    const docs = owed.groups.flatMap((g) => g.documents)
    expect(docs.map((d: OwedDocumentDto) => [d.kind, d.number, d.owed])).toEqual([
      ['invoice', final.number, '15750'],
    ])
    expect(owed.owed).toBe('15750')
    // The order's delivery is not undone while invoiced; its sale counted once.
    const undo = await scope.as(scope.owner, 'order.undoDelivery', { id: order.id })
    expect(codeOf(undo)).toBe('sale_has_invoice')
  })
})

describe("the designer's plain invoice from her recorded sale", () => {
  it('a plain «فاتورة · Invoice» with no VAT anywhere; what she is owed moves to it', async () => {
    const scope = await InvoiceScope.open(api, DESIGNER)
    const customer = await scope.customer({ name: 'Bloom Florists LLC', kind: 'business' })
    const service = await scope.service('2000')
    const sale = await scope.sell({
      businessDate: await scope.today(),
      customerId: customer.id,
      payLater: true,
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '2000' }],
    })
    const invoice = await scope.issue(await scope.fromSale(sale.id))
    expect(invoice).toMatchObject({
      kind: 'invoice',
      vatTotal: '0',
      payable: '2000',
      counts: false,
    })
    const owed: ReceivableListDto = await scope.receivables({ customerId: customer.id })
    expect(owed.groups.flatMap((g) => g.documents).map((d) => [d.kind, d.owed])).toEqual([
      ['invoice', '2000'],
    ])
    const pdf = await scope.invoicePdf(invoice.id)
    const text = await pdfFullText(decode(pdf.base64))
    expect(text).toContain('Invoice')
    expect(text).toContain(normalizeText('فاتورة'))
    expect(text).not.toMatch(/Tax|VAT/)
    expect(text).not.toContain(normalizeText('ضريب'))
    // Its credit note is a plain «إشعار دائن · Credit Note», with no tax reason and no VAT either.
    const taxReason = await scope.as(scope.owner, 'creditNote.create', {
      id: newId(),
      invoiceId: invoice.id,
      eventDate: await scope.today(),
      reason: 'tax_charged_in_error',
      reasonText: 'No VAT here',
      by: 'amount',
      lines: [{ invoiceLineId: invoice.lines[0]!.id, amount: '200' }],
    })
    expect(codeOf(taxReason)).toBe('validation')
    const note = await scope.credit(invoice.id, {
      by: 'amount',
      reason: 'price_changed',
      reasonText: 'One round of changes fewer',
      lines: [{ invoiceLineId: invoice.lines[0]!.id, amount: '200' }],
    })
    expect(note).toMatchObject({ kind: 'credit_note', vatTotal: '0', total: '200' })
    const noteText = await pdfFullText(decode((await scope.creditNotePdf(note.id)).base64))
    expect(noteText).toContain('Credit Note')
    expect(noteText).toContain(normalizeText('إشعار دائن'))
    expect(noteText).not.toMatch(/Tax|VAT/)
    expect(noteText).not.toContain(normalizeText('ضريب'))
    // A recorded sale with an issued invoice is not reversed.
    expect(codeOf(await scope.as(scope.owner, 'sale.reverse', { id: sale.id }))).toBe(
      'sale_has_invoice',
    )
  })
})

describe("the factory's statement", () => {
  it('invoices of 5,250, 3,150 and 2,100; 8,000 paid oldest first leaves 2,500', async () => {
    const scope = await InvoiceScope.open(api, FACTORY)
    await scope.taxReady()
    const customer = await scope.buyer({ name: `Hotel ${newId().slice(-4)}` })
    const ids: string[] = []
    for (const net of ['5000', '3000', '2000']) {
      const issued = await scope.issued({
        customerId: customer.id,
        countedElsewhere: false,
        lines: [typed('Steel brackets', '1', net)],
      })
      ids.push(issued.id)
    }
    const today = await scope.today()
    ok(
      await scope.as(scope.owner, 'customerPayment.recordMany', {
        customerId: customer.id,
        businessDate: today,
        method: 'bank_transfer',
        amount: '8000',
        documents: ids.map((invoiceId) => ({ id: newId(), invoiceId })),
      }),
    )
    const owed = await scope.receivables({ customerId: customer.id })
    expect(owed.owed).toBe('2500')
    const statement = await scope.statement(customer.id, `${today.slice(0, 8)}01`, today)
    expect(statement).toMatchObject({
      opening: '0',
      invoiced: '10500',
      paid: '8000',
      closing: '2500',
    })
  })
})
