import type { InvoiceDto, SaleListItemDto } from '@bizcost/contracts'
import { newId, subtractDecimals, sumDecimals } from '@bizcost/domain'
import { afterAll, describe, expect, it } from 'vitest'
import { codeOf, ok } from './purchasing'
import { quoteTyped } from './quotations'
import { InvoiceScope, InvoicesApi, typed } from './invoices'

// Credit notes that bill less and credit notes that lower the price (ROADMAP.md M3 Step 8; Q3, A2;
// D-305): a credit note posts a negative sale only once the work its invoice bills has counted (a
// deposit invoice once a final invoice took it off, an order's invoice once the order is delivered);
// before that it posts nothing and the source's later invoices bill it again, so the customer is billed
// the work once and the work counts once. An order is cancelled once its issued invoices are fully
// credited. A part's lines name no sale line of the order (a credit by quantity takes no cost back).

const api = new InvoicesApi()
afterAll(() => api.close())

async function opened() {
  const scope = await InvoiceScope.open(api)
  await scope.taxReady()
  const customer = await scope.buyer()
  return { scope, customer, channelId: await scope.channelId() }
}

/** The posted sales of a source. */
async function salesOf(scope: InvoiceScope, source: string): Promise<SaleListItemDto[]> {
  return (await scope.sales({ source })).items.filter((s) => s.status === 'posted')
}

/** Every line of `invoice`, credited whole by amount (as its prices are typed). */
function wholeBy(invoice: InvoiceDto) {
  return invoice.lines
    .filter((l) => l.kind !== 'deduction')
    .map((l) => ({ invoiceLineId: l.id, amount: l.priceIncludesVat ? l.left.total : l.left.net }))
}

describe('a deposit invoice credited before the final invoice', () => {
  it('posts no sale, and the final invoice bills the whole work: billed once, counted once', async () => {
    const { scope, customer, channelId } = await opened()
    const service = await scope.service('10000')
    const order = await scope.order({
      customerId: customer.id,
      channelId,
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '10000' }],
    })
    const deposit = await scope.issue(
      await scope.fromOrder(order.id, { bills: 'part', part: { amount: '2100' }, isDeposit: true }),
    )
    const note = await scope.credit(deposit.id, {
      by: 'amount',
      reason: 'cancelled',
      reasonText: 'The deposit was not paid',
      lines: wholeBy(deposit),
    })
    expect(note).toMatchObject({ counts: false, total: '2100' })
    expect(await salesOf(scope, 'credit_note')).toEqual([])

    const delivered = await scope.deliver(await scope.getOrder(order.id))
    const final = await scope.issue(await scope.fromOrder(delivered.id, { bills: 'rest' }))
    expect(final.lines.filter((l) => l.kind === 'deduction')).toEqual([])
    expect(final).toMatchObject({ payable: '10500', counts: false })
    expect((await salesOf(scope, 'order')).map((s) => s.total)).toEqual(['10500'])
    const owed = await scope.receivables({ customerId: customer.id })
    expect(owed.owed).toBe('10500')
  }, 60_000)
})

describe('a whole job cancelled after its final invoice', () => {
  it('the final and the deposit credited in full take the whole work back once', async () => {
    const { scope, customer } = await opened()
    const quote = await scope.quote({
      customerId: customer.id,
      lines: [quoteTyped('Shop fit-out', '1', '10000')],
    })
    const accepted = await scope.accept(await scope.send(quote))
    const deposit = await scope.issue(
      await scope.fromQuotation(accepted.id, {
        bills: 'part',
        part: { percent: '30' },
        isDeposit: true,
      }),
    )
    expect(deposit).toMatchObject({ payable: '3150', counts: false })
    const final = await scope.issue(await scope.fromQuotation(accepted.id, { bills: 'rest' }))
    expect(final).toMatchObject({ netTotal: '7000', payable: '7350', counts: true })
    // The final invoice counted the whole work.
    expect((await salesOf(scope, 'invoice')).map((s) => s.total)).toEqual(['10500'])

    const work = final.lines.find((l) => l.kind === 'item')!
    const onFinal = await scope.credit(final.id, {
      by: 'amount',
      reason: 'cancelled',
      reasonText: 'The customer cancelled the shop',
      lines: [{ invoiceLineId: work.id, amount: '7000' }],
    })
    expect(onFinal).toMatchObject({ counts: true, total: '7350' })
    // Never more than the final invoice's value of the supply.
    const more = await scope.as(scope.owner, 'creditNote.create', {
      id: newId(),
      invoiceId: final.id,
      eventDate: await scope.today(),
      reason: 'cancelled',
      reasonText: 'Again',
      by: 'amount',
      lines: [{ invoiceLineId: work.id, amount: '1' }],
    })
    expect(codeOf(more)).toBe('exceeds_invoice')
    // The deposit's credit note follows the final invoice that took it off: it counts now.
    const onDeposit = await scope.credit(deposit.id, {
      by: 'amount',
      reason: 'cancelled',
      reasonText: 'The customer cancelled the shop',
      lines: wholeBy(deposit),
    })
    expect(onDeposit).toMatchObject({ counts: true, total: '3150' })
    const counted = [
      ...(await salesOf(scope, 'invoice')),
      ...(await salesOf(scope, 'credit_note')),
    ].map((s) => s.total)
    expect(sumDecimals(counted)).toBe('0')
    const owed = await scope.receivables({ customerId: customer.id })
    expect(owed.owed).toBe('0')
  }, 60_000)
})

describe('a waiting order whose deposit invoice is credited', () => {
  it('is cancelled once its invoices are fully credited and the deposit is given back', async () => {
    const { scope, customer, channelId } = await opened()
    const service = await scope.service('2000')
    const order = await scope.order({
      customerId: customer.id,
      channelId,
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '2000' }],
      payment: { id: newId(), method: 'bank_transfer', amount: '1050' },
    })
    const deposit = await scope.issue(
      await scope.fromOrder(order.id, { bills: 'part', part: { amount: '1050' }, isDeposit: true }),
    )
    expect(deposit.payment).toMatchObject({ owed: '0', state: 'paid' })
    const refused = await scope.as(scope.owner, 'order.cancel', {
      id: order.id,
      version: (await scope.getOrder(order.id)).version,
    })
    expect(codeOf(refused)).toBe('sale_has_invoice')

    const half = await scope.credit(deposit.id, {
      by: 'amount',
      reason: 'cancelled',
      reasonText: 'The customer cancelled the table',
      lines: [{ invoiceLineId: deposit.lines[0]!.id, amount: '525' }],
    })
    expect(half.counts).toBe(false)
    const stillRefused = await scope.as(scope.owner, 'order.cancel', {
      id: order.id,
      version: (await scope.getOrder(order.id)).version,
    })
    expect(codeOf(stillRefused)).toBe('sale_has_invoice')
    await scope.credit(deposit.id, {
      by: 'amount',
      reason: 'cancelled',
      reasonText: 'The customer cancelled the table',
      lines: wholeBy(await scope.getInvoice(deposit.id)),
    })
    const credited = await scope.getInvoice(deposit.id)
    expect(credited).toMatchObject({ creditState: 'credited' })
    // The waiting order still owes its whole work, not invoiced now (D-313): the deposit paid on it
    // counts toward that, until the order is cancelled.
    expect(credited.payment).toMatchObject({ owed: '0', overpaid: '0' })
    expect((await scope.receivables({ customerId: customer.id })).owed).toBe('1050')
    const cancelled = await scope.cancel(await scope.getOrder(order.id))
    expect(cancelled.status).toBe('cancelled')
    // Cancelled, nothing is owed: the deposit is money back to the customer, given back on its invoice.
    expect((await scope.getInvoice(deposit.id)).payment).toMatchObject({
      owed: '0',
      overpaid: '1050',
    })
    await scope.payInvoice(deposit.id, '1050', { kind: 'refund', method: 'bank_transfer' })
    expect(await salesOf(scope, 'credit_note')).toEqual([])
    const owed = await scope.receivables({ customerId: customer.id })
    expect(owed.owed).toBe('0')
  }, 60_000)
})

describe('an order billed before its delivery', () => {
  it('a credit note before the delivery bills less, and its last invoice bills it again', async () => {
    const { scope, customer, channelId } = await opened()
    const service = await scope.service('1000')
    const order = await scope.order({
      customerId: customer.id,
      channelId,
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '1000' }],
    })
    const billed = await scope.issue(await scope.fromOrder(order.id))
    const note = await scope.credit(billed.id, {
      by: 'amount',
      lines: [{ invoiceLineId: billed.lines[0]!.id, amount: '200' }],
    })
    expect(note).toMatchObject({ counts: false, total: '210' })
    const delivered = await scope.deliver(await scope.getOrder(order.id))
    const rest = await scope.issue(await scope.fromOrder(delivered.id, { bills: 'rest' }))
    expect(rest).toMatchObject({ payable: '210', vatTotal: '10' })
    expect(sumDecimals([subtractDecimals(billed.payable, note.total), rest.payable])).toBe('1050')
    expect((await salesOf(scope, 'order')).map((s) => s.total)).toEqual(['1050'])
    expect(await salesOf(scope, 'credit_note')).toEqual([])
    // Once delivered, a credit note lowers the price: a negative sale.
    const after = await scope.credit(rest.id, {
      by: 'amount',
      lines: [{ invoiceLineId: rest.lines[0]!.id, amount: '105' }],
    })
    expect(after).toMatchObject({ counts: true })
    expect((await salesOf(scope, 'credit_note')).map((s) => s.total)).toEqual([
      subtractDecimals('0', after.total),
    ])
  }, 60_000)
})

describe("the sale lines an order's invoices name", () => {
  it("a part names none; a copy of the order's lines names its delivered sale's", async () => {
    const { scope, customer, channelId } = await opened()
    const service = await scope.service('400')
    const order = await scope.order({
      customerId: customer.id,
      channelId,
      lines: [
        { kind: 'item', id: newId(), productId: service.id, qty: '2', unitPrice: '400' },
        { kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '400' },
      ],
    })
    const delivered = await scope.deliver(order)
    const part = await scope.issue(
      await scope.fromOrder(delivered.id, { bills: 'part', part: { percent: '50' } }),
    )
    const whole = await scope.issue(
      await scope.fromOrder(
        (
          await scope.deliver(
            await scope.order({
              customerId: customer.id,
              channelId,
              lines: [typedOrderLine(service.id)],
            }),
          )
        ).id,
      ),
    )
    const rows = await api.admin<{ invoice_id: string; sale_line_id: string | null }[]>`
      select invoice_id, sale_line_id from app.invoice_lines
       where invoice_id = any(${[part.id, whole.id]}::uuid[]) and deleted_at is null`
    expect(rows.filter((r) => r.invoice_id === part.id).map((r) => r.sale_line_id)).toEqual([null])
    expect(
      rows.filter((r) => r.invoice_id === whole.id).every((r) => r.sale_line_id !== null),
    ).toBe(true)
    // A part credited by quantity takes no cost back (its line counted in no sale line).
    const note = await scope.credit(part.id, {
      by: 'quantity',
      reason: 'goods_returned',
      reasonText: 'Returned',
      lines: [{ invoiceLineId: part.lines[0]!.id, qty: '1' }],
    })
    expect(note.counts).toBe(true)
    const [sale] = await salesOf(scope, 'credit_note')
    const lines = await api.admin<{ cost: string | null; refund_of_line_id: string | null }[]>`
      select cost::text, refund_of_line_id from app.sale_lines where sale_id = ${sale!.id}`
    expect(lines.map((l) => l.refund_of_line_id)).toEqual([null])
  }, 60_000)
})

describe('an invoice issued before its order was delivered', () => {
  it('a return after the delivery takes back the cost of the line the delivery counted', async () => {
    const { scope, customer, channelId } = await opened()
    const service = await scope.service('300')
    const order = await scope.order({
      customerId: customer.id,
      channelId,
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '3', unitPrice: '300' }],
    })
    const invoice = await scope.issue(await scope.fromOrder(order.id))
    const delivered = await scope.deliver(await scope.getOrder(order.id))
    const note = await scope.credit(invoice.id, {
      by: 'quantity',
      reason: 'goods_returned',
      reasonText: 'One returned',
      lines: [{ invoiceLineId: invoice.lines[0]!.id, qty: '1' }],
    })
    expect(note).toMatchObject({ counts: true, total: '315' })
    const [sale] = await salesOf(scope, 'credit_note')
    const [line] = await api.admin<{ refund_of_line_id: string | null; qty: string }[]>`
      select refund_of_line_id, trim_scale(qty)::text as qty from app.sale_lines
       where sale_id = ${sale!.id}`
    const [counted] = await api.admin<{ id: string }[]>`
      select id from app.sale_lines where sale_id = ${delivered.saleId!}`
    expect(line).toEqual({ refund_of_line_id: counted!.id, qty: '-1' })
  }, 60_000)
})

describe("an invoiced order's own pages", () => {
  it('its list, page, payments and the Dashboard show what its invoices are paid and owe', async () => {
    const { scope, customer, channelId } = await opened()
    const service = await scope.service('2000')
    const order = await scope.order({
      customerId: customer.id,
      channelId,
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '2000' }],
      payment: { id: newId(), method: 'cash', amount: '1050' },
    })
    await scope.issue(
      await scope.fromOrder(order.id, { bills: 'part', part: { amount: '1050' }, isDeposit: true }),
    )
    // Its deposit invoice is paid, and the rest of the order, not invoiced yet, is still owed (D-313).
    const [listed] = (await scope.orders()).items.filter((o) => o.id === order.id)
    expect(listed).toMatchObject({ paymentState: 'deposit', owed: '1050' })
    expect((await scope.getOrder(order.id)).payment).toMatchObject({
      total: '2100',
      paid: '1050',
      owed: '1050',
    })
    const payments = ok(
      await scope.as<{ items: { amount: string }[] }>(scope.owner, 'customerPayment.list', {
        orderId: order.id,
      }),
    )
    expect(payments.items.map((p) => p.amount)).toEqual(['1050'])
    ok(await scope.run('dashboard.cards'))
    const final = await scope.issue(
      await scope.fromOrder((await scope.deliver(await scope.getOrder(order.id))).id, {
        bills: 'rest',
      }),
    )
    expect(final.payment).toMatchObject({ owed: '1050' })
    const [after] = (await scope.orders()).items.filter((o) => o.id === order.id)
    expect(after).toMatchObject({ paymentState: 'deposit', owed: '1050' })
  }, 60_000)
})

/** One product line of an order. */
function typedOrderLine(productId: string) {
  return { kind: 'item', id: newId(), productId, qty: '1', unitPrice: '400' }
}

describe('a draft that no longer bills what its source would', () => {
  it('is refused at issue (CONFLICT) and takes no number', async () => {
    const { scope, customer, channelId } = await opened()
    const service = await scope.service('500')
    const order = await scope.order({
      customerId: customer.id,
      channelId,
      lines: [{ kind: 'item', id: newId(), productId: service.id, qty: '1', unitPrice: '500' }],
    })
    const first = await scope.fromOrder(order.id)
    const second = await scope.fromOrder(order.id)
    expect((await scope.issue(first)).number).toBe('INV-0001')
    expect(codeOf(await scope.issueRaw(second))).toBe('conflict')
    const next = await scope.issued({
      customerId: customer.id,
      lines: [typed('Survey', '1', '50')],
    })
    expect(next.number).toBe('INV-0002')
    ok(await scope.as(scope.owner, 'invoice.discard', { id: second.id, version: second.version }))
  }, 60_000)
})
