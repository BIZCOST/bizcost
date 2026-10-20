import type {
  CreditNoteDto,
  CustomerPaymentListDto,
  CustomerStatementDto,
  DocumentImageUploadUrlDto,
  DocumentPdfDto,
  InvoiceDto,
  QuotationDto,
} from '@bizcost/contracts'
import { newId, plusDays } from '@bizcost/domain'
import { afterAll, describe, expect, it } from 'vitest'
import { downloadObject } from '../src/admin/storage-admin'
import { pdfFullText } from '../src/documents/pdf/text-layer'
import { PNG, uploadTo } from './hardening/fixture'
import { SECRET_KEY, testConfig } from './helpers'
import { BUYER_TRN, InvoiceScope, InvoicesApi, typed } from './invoices'
import { codeOf, ok } from './purchasing'
import { quoteTyped } from './quotations'

// M3 Step 8 review fixes (D-313–D-316): what the review found, now kept by the API. Stages billed in
// their order, each once, saying their share and when they are due, with the work and the quotation's
// site; a quotation an issued invoice bills never becomes an order; an invoice's own payments and what
// its order paid toward it said apart; an order invoiced in part still takes payments for its rest; an
// invoiced order keeps its branch; an issued document's images kept; a credit note by amount prints no
// quantity; a statement says what each entry was and when the customer paid ahead; a draft names a
// customer's particulars only to a member who sees customers. And (the second pass): a statement's
// past period never changes when an invoice is issued after it, and the next period starts where it
// ended; a deposit invoice drafted before its money came is dated supplied the day it was received.
// Every business, customer and figure is fictional.

const api = new InvoicesApi()
afterAll(() => api.close())

const decode = (base64: string) => new Uint8Array(Buffer.from(base64, 'base64'))
const textOf = async (pdf: DocumentPdfDto) => pdfFullText(decode(pdf.base64))
const compact = (text: string) => text.replace(/\s+/g, '')
const storageAdmin = { ...testConfig, supabaseSecretKey: SECRET_KEY }

async function ready() {
  const scope = await InvoiceScope.open(api)
  await scope.taxReady()
  const customer = await scope.buyer({ phone: '050 987 6543' })
  return { scope, customer }
}

describe('stages of a quotation (Q22): in their order, each once, saying what they bill', () => {
  it('refuses a stage out of order or twice, names its share, due, work and site, and keeps the quotation from becoming an order', async () => {
    const { scope, customer } = await ready()
    const quote = await scope.quote({
      customerId: customer.id,
      site: 'Villa 18, Al Barsha South',
      lines: [
        quoteTyped('Ceiling and lights', '1', '6000'),
        quoteTyped('Gypsum partitions', '1', '4000'),
      ],
      stages: [
        { due: 'On signing', percent: '30' },
        { due: 'On delivery', percent: '40' },
        { due: 'After handover', percent: '30' },
      ],
    })
    const accepted = await scope.accept(await scope.send(quote))
    // The last stage first (it would bill everything), or the second: refused.
    for (const stage of [2, 1]) {
      const out = await scope.as(scope.owner, 'invoice.fromQuotation', {
        id: accepted.id,
        newId: newId(),
        stage,
      })
      expect(codeOf(out)).toBe('validation')
    }
    const first = await scope.fromQuotation(accepted.id, { stage: 0 })
    const twice = await scope.fromQuotation(accepted.id, { stage: 0 })
    expect(first).toMatchObject({
      billStage: 0,
      site: 'Villa 18, Al Barsha South',
      payable: '3150',
    })
    const [line] = first.lines
    expect(line!.description).toContain('30%, On signing')
    expect(line!.details).toContain('Ceiling and lights')
    expect(line!.details).toContain('Gypsum partitions')
    const issued = await scope.issue(first)
    // The same stage again: its other draft is refused at issue, a new one when it is made.
    expect(codeOf(await scope.issueRaw(twice))).toBe('conflict')
    const again = await scope.as(scope.owner, 'invoice.fromQuotation', {
      id: accepted.id,
      newId: newId(),
      stage: 0,
    })
    expect(codeOf(again)).toBe('validation')
    // ER Art. 59(1)(g): the PDF describes the work; the quotation's site prints with the customer.
    const text = compact(await textOf(await scope.invoicePdf(issued.id)))
    expect(text).toContain(compact('Ceiling and lights'))
    expect(text).toContain(compact('Villa 18, Al Barsha South'))
    // Invoiced from the quotation, it is never made an order (the work billed and counted twice).
    const converted = await scope.as(scope.owner, 'quotation.toOrder', {
      id: accepted.id,
      orderId: newId(),
    })
    expect(codeOf(converted)).toBe('quotation_invoiced')
    expect(
      ok(await scope.as<QuotationDto>(scope.owner, 'quotation.get', { id: accepted.id })),
    ).toMatchObject({ invoiced: true })
    // The second and the last stage, in their order: the three add up to the quotation.
    const second = await scope.issue(await scope.fromQuotation(accepted.id, { stage: 1 }))
    const last = await scope.issue(await scope.fromQuotation(accepted.id, { stage: 2 }))
    expect([issued.payable, second.payable, last.payable]).toEqual(['3150', '4200', '3150'])
    expect(last.lines[0]!.description).toContain('30%, After handover')
  }, 90_000)
})

describe("an invoice's payments and its order's (A2, D-313)", () => {
  it("lists only its own payments, says what its order paid toward it, and its order's delivery", async () => {
    const { scope, customer } = await ready()
    const service = await scope.service('20000')
    const order = await scope.order({
      customerId: customer.id,
      channelId: await scope.channelId(),
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '20000' }],
      payment: { id: newId(), method: 'bank_transfer', amount: '5000' },
    })
    const deposit = await scope.issue(
      await scope.fromOrder(order.id, { bills: 'part', part: { amount: '5250' }, isDeposit: true }),
    )
    const onDeposit = ok(
      await scope.as<CustomerPaymentListDto>(scope.owner, 'customerPayment.list', {
        invoiceId: deposit.id,
      }),
    )
    expect(onDeposit.items).toEqual([])
    expect(onDeposit.fromSource).toMatchObject({ kind: 'order', id: order.id, amount: '5000' })
    expect(onDeposit.document).toMatchObject({ paid: '5000', owed: '250' })
    // Delivered, the rest not invoiced yet is owed on the order; the customer pays it there.
    const delivered = await scope.deliver(await scope.getOrder(order.id))
    expect((await scope.receivables({ customerId: customer.id })).owed).toBe('16000')
    ok(
      await scope.as(scope.owner, 'customerPayment.record', {
        id: newId(),
        orderId: order.id,
        businessDate: await scope.today(),
        method: 'cash',
        amount: '1000',
      }),
    )
    // The order's payments count toward its deposit invoice first, then its rest.
    expect((await scope.getInvoice(deposit.id)).payment).toMatchObject({ owed: '0' })
    expect((await scope.getOrder(order.id)).payment).toMatchObject({ paid: '6000', owed: '15000' })
    const final = await scope.issue(await scope.fromOrder(order.id, { bills: 'rest' }))
    expect(final.orderDeliveredOn).toBe(delivered.deliveredOn)
    expect(final.supplyDate).toBe(delivered.deliveredOn)
    const onFinal = ok(
      await scope.as<CustomerPaymentListDto>(scope.owner, 'customerPayment.list', {
        invoiceId: final.id,
      }),
    )
    expect(onFinal.items).toEqual([])
    expect(onFinal.fromSource).toMatchObject({ amount: '750' })
    // Invoiced in full now: a payment goes on its invoices.
    const onOrder = await scope.as(scope.owner, 'customerPayment.record', {
      id: newId(),
      orderId: order.id,
      businessDate: await scope.today(),
      method: 'cash',
      amount: '100',
    })
    expect(codeOf(onOrder)).toBe('validation')
    expect((await scope.receivables({ customerId: customer.id })).owed).toBe('15000')
  }, 90_000)

  it('a waiting order invoiced in part keeps its branch', async () => {
    const { scope, customer } = await ready()
    const service = await scope.service('1000')
    const channelId = await scope.channelId()
    const lines = [
      { kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '1000' },
    ]
    const order = await scope.order({ customerId: customer.id, channelId, lines })
    await scope.issue(
      await scope.fromOrder(order.id, { bills: 'part', part: { percent: '50' }, isDeposit: true }),
    )
    const branch = ok(
      await scope.run<{ id: string }>('location.create', { id: newId(), name: 'Fictional JLT' }),
    )
    const current = await scope.getOrder(order.id)
    const moved = await scope.as(scope.owner, 'order.update', {
      id: order.id,
      version: current.version,
      customerId: customer.id,
      businessDate: current.businessDate,
      dueDate: null,
      locationId: branch.id,
      channelId,
      discount: null,
      roundTo: null,
      deliveryNeeded: false,
      deliveryArea: null,
      notes: null,
      lines: current.lines.map((l) => ({
        kind: 'item',
        id: l.id,
        productId: l.productId,
        qty: l.qty,
        unitPrice: l.unitPrice,
      })),
    })
    expect(codeOf(moved)).toBe('validation')
  }, 90_000)
})

describe("an issued document's letterhead images (D-307)", () => {
  it('a stamp taken off after an invoice was issued with it stays in Storage for that invoice', async () => {
    const { scope, customer } = await ready()
    const url = ok(
      await scope.run<DocumentImageUploadUrlDto>('document.imageUploadUrl', {
        kind: 'stamp',
        contentType: 'image/png',
      }),
    )
    expect((await uploadTo(url.uploadUrl, PNG, 'image/png')).ok).toBe(true)
    ok(await scope.run('document.setImage', { kind: 'stamp', path: url.path }))
    await scope.issued({ customerId: customer.id, lines: [typed('Site survey', '1', '500')] })
    ok(await scope.run('document.removeImage', { kind: 'stamp' }))
    expect(await downloadObject(storageAdmin, url.path)).not.toBeNull()
  }, 90_000)
})

describe('a credit note by amount (a price cut)', () => {
  it('prints no quantity, unit or unit price on its lines', async () => {
    const { scope, customer } = await ready()
    const invoice = await scope.issued({
      customerId: customer.id,
      lines: [typed('Office chair', '3', '100', { unit: 'piece' })],
    })
    const note = await scope.credit(invoice.id, {
      by: 'amount',
      reason: 'price_changed',
      reasonText: 'Agreed a lower price',
      lines: [{ invoiceLineId: invoice.lines[0]!.id, amount: '50' }],
    })
    const text = await textOf(
      ok(await scope.as<DocumentPdfDto>(scope.owner, 'creditNote.pdf', { id: note.id })),
    )
    expect(text).toContain('Office chair')
    expect(text).not.toMatch(/\b1\s*pcs\b/)
    expect(text).toContain('—')
  }, 90_000)
})

describe('a statement says what each entry was (Q27)', () => {
  it('names a sale by its items and a payment by how it was paid, and says when the customer paid ahead', async () => {
    const { scope, customer } = await ready()
    const service = await scope.service('2000', { name: `Kitchen survey ${newId().slice(-4)}` })
    const today = await scope.today()
    await scope.sell({
      businessDate: today,
      customerId: customer.id,
      channelId: await scope.channelId(),
      payLater: true,
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '2000' }],
    })
    // A waiting order paid ahead (it is no charge yet).
    await scope.order({
      customerId: customer.id,
      channelId: await scope.channelId(),
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '3', unitPrice: '2000' }],
      payment: { id: newId(), method: 'bank_transfer', amount: '6000' },
    })
    const from = `${today.slice(0, 8)}01`
    const statement = await scope.statement(customer.id, from, today)
    const sale = statement.entries.find((e) => e.kind === 'sale')
    expect(sale?.itemNames[0]).toContain('Kitchen survey')
    const payment = statement.entries.find((e) => e.kind === 'payment')
    expect(payment?.method).toBe('bank_transfer')
    expect(statement.closing).toBe('-3900')
    const pdf = ok(
      await scope.as<DocumentPdfDto>(scope.owner, 'customer.statementPdf', {
        customerId: customer.id,
        from,
        to: today,
      }),
    )
    const text = await textOf(pdf)
    expect(text).toContain('Kitchen survey')
    expect(text).toContain('Bank transfer')
    expect(text).toContain('Paid ahead at the end')
    expect(
      ok(
        await scope.as<CustomerStatementDto>(scope.owner, 'customer.statement', {
          customerId: customer.id,
          from,
          to: today,
        }),
      ).closing,
    ).toBe('-3900')
  }, 90_000)
})

describe("a draft names a customer's particulars only to a member who sees customers (D-263)", () => {
  it("neither a draft invoice's PDF nor a draft credit note reads them back", async () => {
    const { scope, customer } = await ready()
    const issued = await scope.issued({
      customerId: customer.id,
      lines: [typed('Gypsum partition', '2', '1000')],
    })
    const employee = await scope.api.member({ id: scope.id, owner: scope.owner }, 'employee')
    const current = ok(
      await scope.run<{ version: number }>('member.permissions', { memberId: employee.memberId }),
    )
    ok(
      await scope.run('member.updatePermissions', {
        memberId: employee.memberId,
        version: current.version,
        overrides: [
          { key: 'sales.documents.view', effect: 'allow' },
          { key: 'invoices.documents.view', effect: 'allow' },
          { key: 'invoices.documents.manage', effect: 'allow' },
          { key: 'invoices.documents.credit', effect: 'allow' },
        ],
      }),
    )
    expect(codeOf(await scope.as(employee, 'customer.get', { id: customer.id }))).toBe('forbidden')
    const draft = ok(
      await scope.as<InvoiceDto>(employee, 'invoice.create', {
        id: newId(),
        customerId: customer.id,
        lines: [typed('Site visit', '1', '100')],
      }),
    )
    const text = compact(
      await textOf(ok(await scope.as<DocumentPdfDto>(employee, 'invoice.pdf', { id: draft.id }))),
    )
    expect(text).not.toContain(BUYER_TRN)
    expect(text).not.toContain('9876543')
    expect(text).not.toContain('MarinaPlaza')
    const note = ok(
      await scope.as<CreditNoteDto>(employee, 'creditNote.create', {
        id: newId(),
        invoiceId: issued.id,
        eventDate: await scope.today(),
        reason: 'price_changed',
        reasonText: 'Agreed a lower price',
        by: 'amount',
        lines: [{ invoiceLineId: issued.lines[0]!.id, amount: '100' }],
      }),
    )
    expect(note.customer).toMatchObject({ trn: null, tradeLicence: null, addressLine: null })
    // The owner, who sees customers, reads them on the draft.
    expect(
      ok(await scope.as<CreditNoteDto>(scope.owner, 'creditNote.get', { id: note.id })).customer
        .trn,
    ).toBe(BUYER_TRN)
  }, 90_000)
})

describe('a statement period stays as it was when an invoice is issued after it (D-313)', () => {
  it("an order delivered 5 days ago, then today its deposit invoice, the deposit's credit note and the final invoice: the past is the same, today starts where it ended", async () => {
    const { scope, customer } = await ready()
    const service = await scope.service('10000')
    const today = await scope.today()
    const deliveredOn = plusDays(today, -5)
    const order = await scope.order({
      businessDate: deliveredOn,
      customerId: customer.id,
      channelId: await scope.channelId(),
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '10000' }],
    })
    await scope.deliver(order, deliveredOn)
    const past = { from: plusDays(today, -30), to: plusDays(today, -1) }
    const before = await scope.statement(customer.id, past.from, past.to)
    expect(before).toMatchObject({ opening: '0', invoiced: '10500', closing: '10500' })
    expect(before.entries.map((e) => [e.kind, e.charge])).toEqual([['order', '10500']])

    // Today: a 30% deposit invoice, credited in full before the final invoice (it only billed less,
    // D-305), then the final invoice of the rest, and 4,000.00 paid on it.
    const deposit = await scope.issue(
      await scope.fromOrder(order.id, { bills: 'part', part: { percent: '30' }, isDeposit: true }),
    )
    expect(deposit.payable).toBe('3150')
    const note = await scope.credit(deposit.id, {
      by: 'amount',
      reason: 'cancelled',
      reasonText: 'Billed in error',
      lines: [{ invoiceLineId: deposit.lines[0]!.id, amount: deposit.lines[0]!.left.total }],
    })
    expect(note).toMatchObject({ counts: false, total: '3150' })
    const final = await scope.issue(await scope.fromOrder(order.id, { bills: 'rest' }))
    expect(final.payable).toBe('10500')
    await scope.payInvoice(final.id, '4000')

    // The past period, read again: the same, entry by entry.
    expect(await scope.statement(customer.id, past.from, past.to)).toEqual(before)
    // Today starts where it ended: the invoices and the credit note bill what the delivery charged.
    const day = await scope.statement(customer.id, today, today)
    expect(day).toMatchObject({
      opening: before.closing,
      invoiced: '0',
      credited: '0',
      paid: '4000',
      closing: '6500',
    })
    const byId = new Map(day.entries.map((e) => [e.id, e]))
    expect(byId.get(deposit.id)).toMatchObject({
      charge: '0',
      owedThrough: { amount: '3150', orderNumber: order.number },
    })
    expect(byId.get(note.id)).toMatchObject({
      credit: '0',
      owedThrough: { amount: '3150', orderNumber: order.number },
    })
    expect(byId.get(final.id)).toMatchObject({
      charge: '0',
      owedThrough: { amount: '10500', orderNumber: order.number },
    })
    // The whole month: the delivery charged once; one owed figure with What customers owe.
    const month = await scope.statement(customer.id, past.from, today)
    expect(month).toMatchObject({ opening: '0', invoiced: '10500', closing: '6500' })
    expect((await scope.receivables({ customerId: customer.id })).owed).toBe('6500')
    // Each day starts where the day before ended.
    for (let back = 6; back >= 0; back--) {
      const from = plusDays(today, -back)
      const upTo = await scope.statement(customer.id, past.from, plusDays(from, -1))
      expect((await scope.statement(customer.id, from, today)).opening, from).toBe(upTo.closing)
    }
    const text = await textOf(
      ok(
        await scope.as<DocumentPdfDto>(scope.owner, 'customer.statementPdf', {
          customerId: customer.id,
          from: today,
          to: today,
        }),
      ),
    )
    expect(text).toContain(`Already owed for order ${order.number}: 10,500.00`)
    expect(text).toContain(`Still owed for order ${order.number}: 3,150.00`)
  }, 120_000)

  it('sales of 5 and 4 days ago invoiced today (one paid later, one paid when made): the past is the same', async () => {
    const { scope, customer } = await ready()
    const service = await scope.service('1000')
    const today = await scope.today()
    const later = await scope.sell({
      businessDate: plusDays(today, -5),
      customerId: customer.id,
      channelId: await scope.channelId(),
      payLater: true,
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '2', unitPrice: '1000' }],
    })
    const paid = await scope.sell({
      businessDate: plusDays(today, -4),
      customerId: customer.id,
      channelId: await scope.channelId(),
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '1000' }],
    })
    const past = { from: plusDays(today, -30), to: plusDays(today, -1) }
    const before = await scope.statement(customer.id, past.from, past.to)
    expect(before).toMatchObject({ invoiced: '2100', closing: '2100' })

    const onLater = await scope.issue(await scope.fromSale(later.id))
    const onPaid = await scope.issue(await scope.fromSale(paid.id))
    expect(await scope.statement(customer.id, past.from, past.to)).toEqual(before)
    const day = await scope.statement(customer.id, today, today)
    expect(day).toMatchObject({ opening: '2100', invoiced: '1050', paid: '1050', closing: '2100' })
    const byId = new Map(day.entries.map((e) => [e.id, e]))
    expect(byId.get(onLater.id)).toMatchObject({
      charge: '0',
      owedThrough: { amount: '2100', orderNumber: null },
    })
    expect(byId.get(onPaid.id)).toMatchObject({ charge: '1050', owedThrough: null })
    expect(byId.get(paid.id)).toMatchObject({ kind: 'payment', paidWhenMade: true, credit: '1050' })
    expect((await scope.receivables({ customerId: customer.id })).owed).toBe('2100')

    // A sale of today invoiced today: listed through its invoice only.
    const fresh = await scope.sell({
      businessDate: today,
      customerId: customer.id,
      channelId: await scope.channelId(),
      payLater: true,
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '3', unitPrice: '1000' }],
    })
    const onFresh = await scope.issue(await scope.fromSale(fresh.id))
    const again = await scope.statement(customer.id, today, today)
    expect(again.entries.some((e) => e.id === fresh.id)).toBe(false)
    expect(again.entries.find((e) => e.id === onFresh.id)).toMatchObject({
      charge: '3150',
      owedThrough: null,
    })
    expect(again.closing).toBe('5250')
  }, 90_000)
})

describe('a deposit invoice drafted before the money came (ER Art. 59(1)(f), VAT DL Art. 26)', () => {
  it('the deposit received 20 days ago, after the draft: the draft says it is late, and its issue is dated supplied that day', async () => {
    const { scope, customer } = await ready()
    const service = await scope.service('1000')
    const today = await scope.today()
    const order = await scope.order({
      businessDate: plusDays(today, -25),
      customerId: customer.id,
      channelId: await scope.channelId(),
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '2', unitPrice: '1000' }],
    })
    const draft = await scope.fromOrder(order.id, {
      bills: 'part',
      part: { amount: '630' },
      isDeposit: true,
    })
    expect(draft.supplyDate).toBeNull()
    expect(draft.warnings).not.toContain('late')
    // The transfer came 20 days ago; it is recorded today, on its own day.
    const paidOn = plusDays(today, -20)
    await scope.pay({ orderId: order.id }, '630', { businessDate: paidOn, method: 'bank_transfer' })
    const read = await scope.getInvoice(draft.id)
    expect(read.supplyDate).toBeNull()
    expect(read.warnings).toContain('late')
    expect(read.taxInvoiceDueBy).toBe(plusDays(paidOn, 14))
    const issued = await scope.issue(read)
    expect(issued).toMatchObject({ issueDate: today, supplyDate: paidOn })
  }, 60_000)
})
