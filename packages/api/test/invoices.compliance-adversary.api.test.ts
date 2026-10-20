import type {
  CreditNoteDto,
  DepositsWithoutInvoiceDto,
  InvoiceDto,
  SaleListItemDto,
} from '@bizcost/contracts'
import type { Db } from '@bizcost/db'
import {
  compareDecimal,
  newId,
  plusDays,
  proportionOf,
  subtractDecimals,
  sumDecimals,
} from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pdfFullText } from '../src/documents/pdf/text-layer'
import {
  connectAdmin,
  connectApi,
  handlerFor,
  mutate,
  SECRET_KEY,
  type CallResult,
} from './helpers'
import { codeOf, ok, type Handler } from './purchasing'
import { quoteTyped } from './quotations'
import { InvoiceScope, InvoicesApi, typed } from './invoices'

// UAE compliance and money adversary of M3 Step 8 (invoices, credit notes, payments on invoices,
// statements). Each test states a rule of the plan, of D-302–D-310 or of VAT ER Art. 59 / VAT DL
// Arts 25, 26, 67 that the API breaks as built. They are written to fail until fixed (not fixed here).
//
//   1. A quotation billed by an invoice (a deposit or a stage) can still be made into an order, and
//      the order is billed and counted again in full: the work is invoiced (and VAT charged) twice,
//      and a stage invoice's sale plus the order's delivery count it twice (Q3, Q22).
//   2. A delivered order with only its deposit invoice is no obligation any more (A2 as built): What
//      customers owe and the customer's statement lose everything the deposit invoice does not bill.
//   3. An invoice made from a delivered order or a recorded sale is dated "supplied" on its issue day,
//      not on the delivery or the sale: ER Art. 59(1)(f) prints the wrong date of supply (no date at
//      all), the tax point (VAT DL Art. 25) moves, and the 14-day note (Art. 67(1)) never shows.
//   4. A deposit invoice's credit note issued while its final invoice is being issued (no common
//      lock): the final invoice takes the whole deposit off while the credit note "only bills less"
//      (D-305), so the customer is never billed the credited part again and VAT on the work is short.
//   5. A stage or deposit invoice's only line is "Payment 1 of quotation Q-0001": ER Art. 59(1)(g)
//      asks for a description of the goods or services supplied.
//   6. "Deposits without a tax invoice" (M6) counts a fully credited deposit invoice as covering the
//      deposit, so a deposit that stands without any tax invoice is never listed again.
//   7. A payment received before the invoice was issued cannot be dated on the day it was received
//      once the order is invoiced (orders refuse it, invoices refuse a day before their issue).
//   8. An issued invoice's PDF never prints what its order or sale paid toward it before its issue
//      (D-307: "the payments it had when issued print beside its totals"): the "as of its issue" read
//      cuts issued_at to milliseconds, so the invoice is not yet issued at that instant.
//   9. Goods returned in full after a deposit invoice and its final invoice: the final invoice can be
//      credited by quantity only up to its value after the deposit, and the deposit's line names no
//      product, so part of the goods (and their cost) stays counted as sold with no revenue.
//  10. A tax credit note of whole lines carries their shared-out VAT: its VAT per rate is several fils
//      from its taxable amount × the rate (PINT-AE aligned-ibrp-s-09; the invoice itself is exact).

const api = new InvoicesApi()
afterAll(() => api.close())

const decode = (base64: string) => new Uint8Array(Buffer.from(base64, 'base64'))

/** Posted sales of the business of these sources (the sales an invoice, a delivery or a credit note posted). */
async function postedSales(scope: InvoiceScope, sources: readonly string[]) {
  const rows: SaleListItemDto[] = []
  for (const source of sources) {
    rows.push(...(await scope.sales({ source })).items.filter((s) => s.status === 'posted'))
  }
  return rows
}

describe('1. a quotation billed by an invoice, then made into an order (Q3, Q22)', () => {
  it('a deposit invoice of the quotation, then the order made from it: the work is never billed twice', async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const customer = await scope.buyer()
    const quote = await scope.quote({
      customerId: customer.id,
      lines: [quoteTyped('Kitchen cabinets', '1', '10000')],
    })
    const accepted = await scope.accept(await scope.send(quote))
    expect(accepted.payable).toBe('10500')
    const deposit = await scope.issue(
      await scope.fromQuotation(accepted.id, {
        bills: 'part',
        part: { amount: '3150' },
        isDeposit: true,
      }),
    )
    expect(deposit.payable).toBe('3150')

    const converted = await scope.as<{ orderId: string }>(scope.owner, 'quotation.toOrder', {
      id: accepted.id,
      orderId: newId(),
    })
    // Refusing the order once the quotation is invoiced is one fix; the order is checked below.
    if (converted.error) return
    const orderId = converted.data!.orderId
    const full = await scope.as<InvoiceDto>(scope.owner, 'invoice.fromOrder', {
      orderId,
      newId: newId(),
      bills: 'everything',
    })
    const issued = full.error ? null : await scope.issueRaw(full.data!)
    const billed = sumDecimals([deposit.payable, issued?.data?.payable ?? '0'])
    // What the customer accepted: 10,500.00 with its VAT of 500.00, billed once.
    expect(compareDecimal(billed, accepted.payable), `billed ${billed}`).toBeLessThanOrEqual(0)
  }, 60_000)

  it('a stage invoice of the quotation (it counts), then the order made from it and delivered: the work counts once', async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const customer = await scope.buyer()
    const quote = await scope.quote({
      customerId: customer.id,
      lines: [quoteTyped('Gypsum ceiling', '1', '10000')],
      stages: [
        { due: 'On signing', percent: '30' },
        { due: 'On handover', percent: '70' },
      ],
    })
    const accepted = await scope.accept(await scope.send(quote))
    const stage = await scope.issue(await scope.fromQuotation(accepted.id, { stage: 0 }))
    expect(stage).toMatchObject({ payable: '3150', counts: true })

    const converted = await scope.as<{ orderId: string }>(scope.owner, 'quotation.toOrder', {
      id: accepted.id,
      orderId: newId(),
    })
    if (converted.error) return
    const order = await scope.getOrder(converted.data!.orderId)
    await scope.deliver(order)
    const counted = sumDecimals(
      (await postedSales(scope, ['invoice', 'order'])).map((s) => s.total),
    )
    // 10,500.00 of work, counted once (Q3): never 13,650.00.
    expect(compareDecimal(counted, accepted.payable), `counted ${counted}`).toBeLessThanOrEqual(0)
  }, 60_000)
})

describe('2. a delivered order with only its deposit invoice (A2: one owed figure)', () => {
  it('What customers owe and the statement still owe the whole delivered order', async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const customer = await scope.buyer({ name: `Al Noor Clinic ${newId().slice(-4)}` })
    const service = await scope.service('10000')
    const order = await scope.order({
      customerId: customer.id,
      channelId: await scope.channelId(),
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '10000' }],
    })
    expect(order.payable).toBe('10500')
    expect((await scope.receivables({ customerId: customer.id })).owed).toBe('10500')

    // A 30% deposit invoice, then the delivery; the final invoice is not issued yet.
    await scope.issue(
      await scope.fromOrder(order.id, { bills: 'part', part: { percent: '30' }, isDeposit: true }),
    )
    await scope.deliver(await scope.getOrder(order.id))

    // Nothing was paid: the customer owes the whole delivered work, 10,500.00, not only 3,150.00.
    expect((await scope.receivables({ customerId: customer.id })).owed).toBe('10500')
    const today = await scope.today()
    const statement = await scope.statement(customer.id, `${today.slice(0, 8)}01`, today)
    expect(statement.closing).toBe('10500')
  }, 60_000)
})

describe('3. the date of supply of an invoice made from a delivered order or a recorded sale (ER Art. 59(1)(f))', () => {
  it('an order delivered 20 days ago: the invoice says so, and warns it is past 14 days (VAT DL Art. 67(1))', async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const customer = await scope.buyer()
    const service = await scope.service('1000')
    const today = await scope.today()
    const deliveredOn = plusDays(today, -20)
    const order = await scope.order({
      businessDate: deliveredOn,
      customerId: customer.id,
      channelId: await scope.channelId(),
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '2', unitPrice: '1000' }],
    })
    const delivered = await scope.deliver(order, deliveredOn)
    expect(delivered.status).toBe('delivered')
    const draft = await scope.fromOrder(delivered.id)
    const issued = await scope.issue(draft)
    expect(issued.issueDate).toBe(today)
    // As built: the date of supply is the issue day (null on the draft), so the PDF prints no date of
    // supply and the draft never says a tax invoice was due 6 days ago.
    expect(issued.supplyDate).toBe(deliveredOn)
    expect(draft.warnings).toContain('late')
  }, 60_000)

  it('a recorded sale of 5 days ago: its invoice is dated supplied on the sale day', async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const customer = await scope.buyer()
    const service = await scope.service('2000')
    const soldOn = plusDays(await scope.today(), -5)
    const sale = await scope.sell({
      businessDate: soldOn,
      customerId: customer.id,
      payLater: true,
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '2000' }],
    })
    const issued = await scope.issue(await scope.fromSale(sale.id))
    expect(issued.supplyDate).toBe(soldOn)
  }, 60_000)
})

describe("4. a deposit invoice's credit note issued while its final invoice is issued (forced on the invoice counter)", () => {
  // Two more API instances, each with its own database connection; an admin transaction holds the
  // business's invoice counter row (the last lock of an invoice issue) while the final invoice's issue
  // waits on it, and the deposit's credit note (its own series) is issued meanwhile.
  let dbs: Db[]
  let handlers: Handler[]
  beforeAll(() => {
    dbs = [connectApi(), connectApi()]
    handlers = dbs.map((db) =>
      handlerFor(db, undefined, {
        supabaseSecretKey: SECRET_KEY,
        previewModules: ['quotations', 'invoices'],
      }),
    )
  })
  afterAll(async () => {
    for (const db of dbs) await db.$client.end()
  })

  async function pidOf(db: Db): Promise<number> {
    const [row] = await db.$client<{ pid: number }[]>`select pg_backend_pid() as pid`
    return row!.pid
  }

  async function waiting(pid: number): Promise<boolean> {
    const [row] = await api.admin<{ n: number }[]>`
      select count(*)::int as n from pg_locks where not granted and pid = ${pid}`
    return row!.n > 0
  }

  it('the final invoice takes off only what is left of the deposit, or the credit note counts', async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const customer = await scope.buyer()
    const quote = await scope.quote({
      customerId: customer.id,
      lines: [quoteTyped('Joinery works', '1', '10000')],
    })
    const accepted = await scope.accept(await scope.send(quote))
    const deposit = await scope.issue(
      await scope.fromQuotation(accepted.id, {
        bills: 'part',
        part: { amount: '3150' },
        isDeposit: true,
      }),
    )
    const finalDraft = await scope.fromQuotation(accepted.id, { bills: 'rest' })
    const noteDraft = await scope.creditDraft(deposit.id, {
      by: 'amount',
      reason: 'price_changed',
      reasonText: 'Deposit agreed lower',
      lines: [{ invoiceLineId: deposit.lines[0]!.id, amount: '1050' }],
    })

    const holder = connectAdmin()
    let issuedFinal: CallResult<InvoiceDto>
    let issuedNote: CallResult<CreditNoteDto>
    try {
      let release!: () => void
      const released = new Promise<void>((resolve) => (release = resolve))
      let holding!: () => void
      const held = new Promise<void>((resolve) => (holding = resolve))
      const transaction = holder.begin(async (sql) => {
        await sql`select id from app.document_counters
                   where business_id = ${scope.id} and series = 'invoice' for update`
        holding()
        await released
      })
      await held
      const [finalPid, notePid] = await Promise.all(dbs.map(pidOf))
      const finalDone = mutate<InvoiceDto>(handlers[0]!, 'invoice.issue', {
        token: scope.owner.token,
        businessId: scope.id,
        input: { id: finalDraft.id, version: finalDraft.version },
      })
      for (let i = 0; i < 600 && !(await waiting(finalPid!)); i++) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      let noteFinished = false
      const noteDone = mutate<CreditNoteDto>(handlers[1]!, 'creditNote.issue', {
        token: scope.owner.token,
        businessId: scope.id,
        input: { id: noteDraft.id, version: noteDraft.version },
      }).then((result) => {
        noteFinished = true
        return result
      })
      for (let i = 0; i < 200 && !noteFinished && !(await waiting(notePid!)); i++) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      release()
      await transaction
      issuedFinal = await finalDone
      issuedNote = await noteDone
    } finally {
      await holder.end()
    }

    // Both went through (neither was told the other changed what it bills).
    if (issuedFinal.error || issuedNote.error) return
    const final = issuedFinal.data!
    const note = issuedNote.data!
    const deducted = sumDecimals(
      final.lines.filter((l) => l.kind === 'deduction').map((l) => subtractDecimals('0', l.total)),
    )
    if (note.countedOn !== null) return // the credit note lowered the price: it counted (fine)
    // It only billed less (D-305): the final invoice takes off only what is left of the deposit
    // (3,150.00 − 1,050.00), so the customer is billed the work once, with its VAT of 500.00 once.
    expect(deducted).toBe(subtractDecimals(deposit.total, note.total))
    const billed = sumDecimals([deposit.payable, final.payable, subtractDecimals('0', note.total)])
    expect(billed).toBe(accepted.payable)
    expect(
      sumDecimals([deposit.vatTotal, final.vatTotal, subtractDecimals('0', note.vatTotal)]),
    ).toBe(accepted.vatTotal)
  }, 90_000)
})

describe('5. a stage invoice describes the work it bills (ER Art. 59(1)(g))', () => {
  it("stage 1 of a quotation names the quotation's goods or services, not only «Payment 1»", async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const customer = await scope.buyer()
    const quote = await scope.quote({
      customerId: customer.id,
      lines: [quoteTyped('Ceiling and lights', '1', '10000')],
      stages: [
        { due: 'On signing', percent: '30' },
        { due: 'On handover', percent: '70' },
      ],
    })
    const accepted = await scope.accept(await scope.send(quote))
    const stage = await scope.issue(await scope.fromQuotation(accepted.id, { stage: 0 }))
    const text = await pdfFullText(decode((await scope.invoicePdf(stage.id)).base64))
    expect(text).toContain('Ceiling and lights')
  }, 60_000)
})

describe('6. deposits without a tax invoice (M6, VAT DL Arts 26, 67(1))', () => {
  it('a deposit whose tax invoice was credited in full, the money kept: listed again', async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const customer = await scope.buyer()
    const service = await scope.service('5000')
    const order = await scope.order({
      customerId: customer.id,
      channelId: await scope.channelId(),
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '5000' }],
      payment: { id: newId(), method: 'bank_transfer', amount: '1050' },
    })
    const listed = async () =>
      ok(await scope.run<DepositsWithoutInvoiceDto>('invoice.depositsWithoutInvoice')).items.filter(
        (d) => d.orderId === order.id,
      )
    expect((await listed()).map((d) => d.amount)).toEqual(['1050'])
    const deposit = await scope.issue(
      await scope.fromOrder(order.id, { bills: 'part', part: { amount: '1050' }, isDeposit: true }),
    )
    expect(await listed()).toEqual([])
    // The deposit invoice named the wrong customer's details: cancelled by a tax credit note; the
    // customer's 1,050.00 is still held, and its new deposit invoice is not issued yet.
    await scope.credit(deposit.id, {
      by: 'amount',
      reason: 'cancelled',
      reasonText: 'Issued in error',
      lines: [{ invoiceLineId: deposit.lines[0]!.id, amount: '1050' }],
    })
    expect((await listed()).map((d) => d.amount)).toEqual(['1050'])
  }, 60_000)
})

describe('7. a payment received before the invoice was issued (its real day)', () => {
  it('a transfer received 3 days ago on an order invoiced since: recorded on its own day', async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const customer = await scope.buyer()
    const service = await scope.service('2000')
    const today = await scope.today()
    const order = await scope.order({
      businessDate: plusDays(today, -5),
      customerId: customer.id,
      channelId: await scope.channelId(),
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '2000' }],
    })
    const invoice = await scope.issue(await scope.fromOrder(order.id))
    const receivedOn = plusDays(today, -3)
    const onOrder = await scope.as(scope.owner, 'customerPayment.record', {
      id: newId(),
      orderId: order.id,
      businessDate: receivedOn,
      method: 'bank_transfer',
      amount: '1000',
    })
    const onInvoice = await scope.as(scope.owner, 'customerPayment.record', {
      id: newId(),
      invoiceId: invoice.id,
      businessDate: receivedOn,
      method: 'bank_transfer',
      amount: '1000',
    })
    // One of the two must take it, dated the day the money came in.
    expect(
      [onOrder, onInvoice].some((r) => r.error === undefined),
      `${onOrder.error?.message} / ${onInvoice.error?.message}`,
    ).toBe(true)
  }, 60_000)
})

describe("8. an issued invoice's PDF prints what was paid toward it before its issue (D-307)", () => {
  it("the workshop's deposit of 5,250.00 paid on the order: its deposit tax invoice prints it as paid", async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const customer = await scope.buyer()
    const service = await scope.service('20000')
    const order = await scope.order({
      customerId: customer.id,
      channelId: await scope.channelId(),
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '20000' }],
      payment: { id: newId(), method: 'bank_transfer', amount: '5250' },
    })
    const deposit = await scope.issue(
      await scope.fromOrder(order.id, { bills: 'part', part: { amount: '5250' }, isDeposit: true }),
    )
    // The API knows it is paid (the order's deposit pays the deposit invoice first, A2).
    expect(deposit.payment).toMatchObject({ owed: '0', state: 'paid' })
    // Its issued PDF says so ("Paid before this invoice" 5,250.00, "Balance due" 0.00). As built, the
    // PDF reads the obligations "as it stood at its issue" with issued_at cut to milliseconds (a JS
    // Date) while Postgres keeps microseconds: the invoice itself is not issued yet at that instant, so
    // no payment prints (unless its issue time happens to end in 000 µs).
    const text = await pdfFullText(decode((await scope.invoicePdf(deposit.id)).base64))
    expect(text).toContain('Paid before this invoice')
    expect(text).toContain('Balance due')
  }, 60_000)
})

describe('9. goods returned in full after a deposit invoice and its final invoice (counting once, D-305)', () => {
  it('4 units delivered, then all returned: every unit comes back out of sales', async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const customer = await scope.buyer()
    const product = await scope.service('5000')
    const order = await scope.order({
      customerId: customer.id,
      channelId: await scope.channelId(),
      lines: [{ kind: 'item', id: newId(), productId: product.id, qty: '4', unitPrice: '5000' }],
    })
    const deposit = await scope.issue(
      await scope.fromOrder(order.id, { bills: 'part', part: { percent: '25' }, isDeposit: true }),
    )
    await scope.deliver(await scope.getOrder(order.id))
    const final = await scope.issue(await scope.fromOrder(order.id, { bills: 'rest' }))
    expect(final.netTotal).toBe('15000')
    const work = final.lines.find((l) => l.kind === 'item')!

    // All 4 units come back. The final invoice's value of the supply is 15,000.00 (ER Art. 60(1)(e)),
    // so by quantity it takes 3 at most; the deposit invoice is credited for the rest.
    const all = await scope.as(scope.owner, 'creditNote.create', {
      id: newId(),
      invoiceId: final.id,
      eventDate: await scope.today(),
      reason: 'goods_returned',
      reasonText: 'All four units returned',
      by: 'quantity',
      lines: [{ invoiceLineId: work.id, qty: '4' }],
    })
    expect(codeOf(all)).toBe('exceeds_invoice')
    await scope.credit(final.id, {
      by: 'quantity',
      reason: 'goods_returned',
      reasonText: 'Three units returned',
      lines: [{ invoiceLineId: work.id, qty: '3' }],
    })
    await scope.credit(deposit.id, {
      by: 'quantity',
      reason: 'goods_returned',
      reasonText: 'The fourth unit returned',
      lines: [{ invoiceLineId: deposit.lines[0]!.id, qty: '1' }],
    })

    // Revenue back to zero, and so is what was sold of the product (its cost with it).
    const posted = await postedSales(scope, ['order', 'credit_note'])
    expect(sumDecimals(posted.map((s) => s.total))).toBe('0')
    const lines = []
    for (const s of posted) lines.push(...(await scope.sale(s.id)).lines)
    const sold = sumDecimals(lines.filter((l) => l.productId === product.id).map((l) => l.qty))
    expect(sold, 'units of the product still counted as sold').toBe('0')
  }, 60_000)
})

describe('10. VAT once per rate (PINT-AE aligned-ibrp-s-09) on a tax credit note', () => {
  it('crediting whole lines of a long invoice: the VAT on the difference is the difference × 5%, within a fils', async () => {
    const scope = await InvoiceScope.open(api)
    await scope.taxReady()
    const customer = await scope.buyer()
    // 40 fittings of 1,234.57: the invoice's VAT (2,469.14) is exact per rate, shared over its lines
    // a fils apart (61.72 or 61.73 each).
    const invoice = await scope.issued({
      customerId: customer.id,
      lines: Array.from({ length: 40 }, (_, i) => typed(`Fitting ${i + 1}`, '1', '1234.57')),
    })
    expect(invoice.vatTotal).toBe('2469.14')
    const top = invoice.lines.filter((l) => l.vat === '61.73')
    expect(top.length).toBeGreaterThan(20)
    // Those fittings come back (goods returned), each whole.
    const note = await scope.credit(invoice.id, {
      by: 'quantity',
      reason: 'goods_returned',
      reasonText: 'Fittings returned',
      lines: top.map((l) => ({ invoiceLineId: l.id, qty: '1' })),
    })
    const [rate] = note.vatRates
    const expected = proportionOf(rate!.net, '5', '100', 2)
    const off = subtractDecimals(rate!.vat, expected)
    expect(
      compareDecimal(off, '0.01') <= 0 && compareDecimal(off, '-0.01') >= 0,
      `VAT ${rate!.vat} on ${rate!.net} (5% is ${expected})`,
    ).toBe(true)
  }, 60_000)
})
