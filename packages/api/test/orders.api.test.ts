import type { ProductDto, SaleDto } from '@bizcost/contracts'
import { addMonths } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { orderDelivery, OrderScope, OrdersApi } from './orders'
import { dayOf, lastOf, type Summary } from './profit'
import { codeOf, ok } from './purchasing'
import { item } from './sales'
import { BAKER } from './settings'

// Orders with delivery, deposits and refunds (ROADMAP.md M3 Step 5; Q16, Q17; the definition of
// done), through the API with the dev-only preview of Customers, Sales, Payments, Reports and Orders
// (D-125). The home baker's order #1001, with months counted from the business's today so it holds
// on any day ("September" is the last full month):
//   - a chocolate cake at 150 plus delivery charged 20, a deposit of 50 by bank transfer: still owed 120;
//   - delivered on the 14th: a sale of 170 on that day; the delivery cost 25: margin −5;
//   - the month's 1,000 ÷ 4,000 = 25 %, materials 32.40 and her 60 minutes at AED 40/h: real profit
//     35.10;
//   - paid in full, then refunded 20 by amount for a damaged cake: the month's sales from it 150, its
//     materials still 32.40, its real profit 20.10, and with the refund payment of 20 nothing is owed;
//   - undo delivery takes the 170 out of the month; delivering again on the 16th counts it there;
//   - a cancelled order with a deposit of 50 shows "money back to the customer: 50" until refunded;
//   - no VAT anywhere (not registered).

let api: OrdersApi

beforeAll(() => {
  api = new OrdersApi()
})

afterAll(async () => {
  await api.close()
})

const groupOf = (summary: Summary, key: string) => {
  const group = summary.groups.find((g) => g.key === key)
  if (!group) throw new Error(`no group ${key}`)
  return group
}

/**
 * The baker: her hourly rate 40, running costs of 1,000 a month, a cake made of a kit bought at
 * 32.40 with her 60 minutes, a first sale the month before (so the last month is a month of its own),
 * and `others` of item sales on the month's 20th.
 */
async function bakery(others: string) {
  const baker = await OrderScope.open(api, BAKER)
  const { last } = await baker.months()
  const before = addMonths(last, -1)
  await baker.settings({ ownerHourlyRate: '40' })
  await baker.monthly('1000', dayOf(addMonths(last, -2), 1))
  const kit = await baker.pieceMaterial('Cake ingredients', '32.4', dayOf(before, 1), '50')
  const cake = await baker.madeOf(kit, '150', { ownerMinutes: '60' })
  const other = await baker.service('1')
  const channel = await baker.channelId()
  await baker.sell({
    businessDate: dayOf(before, 3),
    channelId: channel,
    lines: [item(other.id, '1', '1')],
  })
  await baker.sell({
    businessDate: dayOf(last, 20),
    channelId: channel,
    lines: [item(other.id, others, '1')],
  })
  const fatima = await baker.customer({ name: 'Fatima', phone: '050 123 4567' })
  return { baker, last, cake, fatima }
}

/** The order #1001: the cake at 150, delivery charged 20 (it cost 25), a deposit of 50. */
async function cakeOrder(baker: OrderScope, last: string, cake: ProductDto, customerId: string) {
  return baker.order({
    customerId,
    businessDate: dayOf(last, 10),
    dueDate: dayOf(last, 14),
    lines: [item(cake.id, '1', '150'), orderDelivery('20')],
    deliveryNeeded: true,
    deliveryArea: 'Al Barsha',
    deliveryCost: '25',
    notes: 'Happy birthday Sara',
    payment: { id: crypto.randomUUID(), method: 'bank_transfer', amount: '50' },
  })
}

describe('the home baker’s order #1001 (definition of done)', () => {
  let baker: OrderScope
  let last: string
  let cake: ProductDto
  let fatimaId: string

  beforeAll(async () => {
    const b = await bakery('3850')
    baker = b.baker
    last = b.last
    cake = b.cake
    // Names may repeat (Q2): a second Fatima, told apart by her phone.
    fatimaId = (await baker.customer({ name: 'Fatima', phone: '055 765 4321' })).id
  }, 180_000)

  it('the cake at 150 + delivery 20 with a deposit of 50: #1001, still owed 120, no VAT', async () => {
    const order = await cakeOrder(baker, last, cake, fatimaId)
    expect(order).toMatchObject({
      number: '#1001',
      seq: 1001,
      status: 'pending',
      customerName: 'Fatima',
      customerPhoneLast4: '4321',
      vatRegistered: false,
      netTotal: '170',
      vatTotal: '0',
      total: '170',
      deliveryCost: '25',
      ownDeliveryCost: '25',
      payment: { state: 'deposit', total: '170', paid: '50', owed: '120', overpaid: '0' },
    })
    expect(order.lines.every((l) => l.vatCategory === null && l.vatRate === null)).toBe(true)
    const owed = await baker.receivables()
    expect(owed.owed).toBe('120')
    expect(owed.groups.map((g) => [g.name, g.owed, g.documents.map((d) => d.number)])).toEqual([
      ['Fatima', '120', ['#1001']],
    ])
    expect(JSON.stringify(owed)).not.toMatch(/"balance"/)
  })

  it('delivered on the 14th: a sale of 170 on that day, delivery margin −5, real profit 35.10', async () => {
    const pending = (await baker.orders({ status: 'pending' })).items[0]!
    const delivered = await baker.deliver(await baker.getOrder(pending.id), dayOf(last, 14))
    expect(delivered).toMatchObject({ status: 'delivered', deliveredOn: dayOf(last, 14) })
    const sale = ok(await baker.run<{ data: SaleDto }>('sale.get', { id: delivered.saleId })).data
    expect(sale).toMatchObject({
      source: 'order',
      status: 'posted',
      businessDate: dayOf(last, 14),
      total: '170',
      orderId: delivered.id,
      orderNumber: '#1001',
      customerName: 'Fatima',
      deliveryCost: '25',
      payment: null,
    })
    // The order's profit, worked out on read once the month is over.
    expect(delivered.profit).toMatchObject({
      sales: '170',
      itemSales: '150',
      materials: '32.4',
      runningCosts: '37.5',
      ownerTime: '40',
      deliveryCharged: '20',
      deliveryCost: '25',
      deliveryMargin: '-5',
      profit: '35.1',
      complete: true,
    })
    const summary = await baker.summary({
      from: dayOf(last, 1),
      to: lastOf(last),
      groupBy: 'order',
    })
    expect(groupOf(summary, delivered.id)).toMatchObject({
      name: '#1001',
      customerName: 'Fatima',
      sales: '170',
      profit: '35.1',
    })
    expect(groupOf(summary, 'none')).toMatchObject({ name: null, sales: '3850' })
    // One figure per obligation: the order owes 120, its sale nothing.
    const owed = await baker.receivables()
    expect(owed.groups[0]?.documents.map((d) => [d.kind, d.owed])).toEqual([['order', '120']])
  })

  it('paid in full: Paid, nothing owed, nothing listed', async () => {
    const order = (await baker.orders({ status: 'delivered' })).items[0]!
    const paid = await baker.pay({ orderId: order.id }, '120', { method: 'card' })
    expect(paid.document).toMatchObject({ state: 'paid', owed: '0', paid: '170' })
    expect(paid.items.map((p) => [p.kind, p.method, p.amount])).toEqual([
      ['payment', 'card', '120'],
      ['payment', 'bank_transfer', '50'],
    ])
    expect((await baker.receivables()).groups).toEqual([])
    // Overpaying is refused.
    const more = await baker.as(baker.owner, 'customerPayment.record', {
      id: crypto.randomUUID(),
      orderId: order.id,
      businessDate: await baker.today(),
      method: 'cash',
      amount: '0.01',
    })
    expect(codeOf(more)).toBe('exceeds_outstanding')
  })
})

describe('the refund of 20 by amount for a damaged cake (definition of done: 20.10)', () => {
  it('the month’s sales from it 150, materials still 32.40, real profit 20.10; with the money back nothing is owed', async () => {
    // 3,870 of other sales: with the refund the month's item sales are 4,000 again (25 %).
    const { baker, last, cake, fatima } = await bakery('3870')
    const created = await cakeOrder(baker, last, cake, fatima.id)
    const delivered = await baker.deliver(created, dayOf(last, 14))
    await baker.pay({ orderId: delivered.id }, '120', { businessDate: dayOf(last, 14) })
    const cakeLine = ok(
      await baker.run<{ data: SaleDto }>('sale.get', { id: delivered.saleId }),
    ).data.lines.find((l) => l.kind === 'item')!
    const refund = await baker.refund({
      orderId: delivered.id,
      by: 'amount',
      businessDate: dayOf(last, 15),
      lines: [{ lineId: cakeLine.id, amount: '20' }],
      notes: 'The cake was damaged',
      payment: { id: crypto.randomUUID(), method: 'cash', amount: '20' },
    })
    expect(refund).toMatchObject({
      source: 'refund',
      status: 'posted',
      refundOfId: delivered.saleId,
      refundBy: 'amount',
      orderId: delivered.id,
      total: '-20',
    })
    // A price cut takes back no cost and no quantity sold.
    expect(refund.lines[0]).toMatchObject({
      qty: '-1',
      net: '-20',
      cost: '0',
      refundOfLineId: cakeLine.id,
    })
    const order = await baker.getOrder(delivered.id)
    expect(order.payment).toMatchObject({
      state: 'paid',
      total: '170',
      credited: '20',
      paid: '170',
      refunded: '20',
      owed: '0',
      overpaid: '0',
    })
    expect(order.refunds).toEqual([
      expect.objectContaining({ id: refund.id, by: 'amount', total: '20', status: 'posted' }),
    ])
    expect(order.profit).toMatchObject({
      sales: '150',
      materials: '32.4',
      runningCosts: '32.5',
      profit: '20.1',
    })
    const byProduct = await baker.summary({
      from: dayOf(last, 1),
      to: lastOf(last),
      groupBy: 'product',
    })
    expect(groupOf(byProduct, cake.id)).toMatchObject({ quantity: '1', sales: '130' })
    expect(byProduct.months[0]).toMatchObject({ rate: '0.25', rateSales: '4000' })
    // What is left of the cake's line: 1 cake worth 130.
    const sale = ok(await baker.run<{ data: SaleDto }>('sale.get', { id: delivered.saleId })).data
    expect(sale.lines.find((l) => l.id === cakeLine.id)?.left).toMatchObject({
      qty: '1',
      net: '130',
      typed: '130',
    })
    expect(sale.refunds.map((r) => r.id)).toEqual([refund.id])
    // Never more than is left: 131 of the 130 left is refused.
    const tooMuch = await baker.as(baker.owner, 'sale.refund', {
      id: crypto.randomUUID(),
      orderId: delivered.id,
      by: 'amount',
      lines: [{ lineId: cakeLine.id, amount: '130.01' }],
    })
    expect(codeOf(tooMuch)).toBe('exceeds_sale')
    // The undo is refused while the refund stands (it is reversed first).
    expect(codeOf(await baker.as(baker.owner, 'order.undoDelivery', { id: delivered.id }))).toBe(
      'sale_has_refunds',
    )
  }, 180_000)
})

describe('undo delivery, and delivering again', () => {
  it('the undo takes the 170 out of the month; delivered again on the 16th it counts there', async () => {
    const { baker, last, cake, fatima } = await bakery('3850')
    const created = await cakeOrder(baker, last, cake, fatima.id)
    const first = await baker.deliver(created, dayOf(last, 14))
    const undone = await baker.undo(first.id)
    expect(undone).toMatchObject({
      status: 'pending',
      deliveredOn: null,
      saleId: null,
      profit: null,
    })
    // Its deposit stays on the order.
    expect(undone.payment).toMatchObject({ state: 'deposit', owed: '120' })
    const reversed = ok(await baker.run<{ data: SaleDto }>('sale.get', { id: first.saleId })).data
    expect(reversed).toMatchObject({ status: 'reversed', reversalBusinessDate: dayOf(last, 14) })
    const between = await baker.summary({ from: dayOf(last, 1), to: lastOf(last), groupBy: 'day' })
    expect(between.groups.find((g) => g.key === dayOf(last, 14))).toBeUndefined()
    // Undo again: nothing to do.
    expect((await baker.undo(first.id)).status).toBe('pending')
    const again = await baker.deliver(undone, dayOf(last, 16))
    expect(again.saleId).not.toBe(first.saleId)
    const summary = await baker.summary({ from: dayOf(last, 1), to: lastOf(last), groupBy: 'day' })
    expect(groupOf(summary, dayOf(last, 16))).toMatchObject({ sales: '170' })
    expect(summary.groups.find((g) => g.key === dayOf(last, 14))).toBeUndefined()
    // A repeated deliver returns the recorded result.
    const repeated = await baker.deliver(again, dayOf(last, 20))
    expect(repeated).toMatchObject({ saleId: again.saleId, deliveredOn: dayOf(last, 16) })
  }, 180_000)
})

describe('a cancelled order with a deposit', () => {
  it('shows "money back to the customer: 50" until the refund is recorded', async () => {
    const { baker, last, cake, fatima } = await bakery('3850')
    const created = await cakeOrder(baker, last, cake, fatima.id)
    const cancelled = await baker.cancel(created)
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      payment: { state: 'overpaid', total: '0', paid: '50', overpaid: '50', owed: '0' },
    })
    const owed = await baker.receivables()
    expect(owed).toMatchObject({ owed: '0', overpaid: '50' })
    expect(owed.groups[0]?.documents[0]).toMatchObject({
      number: created.number,
      orderStatus: 'cancelled',
      overpaid: '50',
    })
    // A payment on it is refused; money given back up to the deposit is not.
    const payment = await baker.as(baker.owner, 'customerPayment.record', {
      id: crypto.randomUUID(),
      orderId: created.id,
      businessDate: await baker.today(),
      method: 'cash',
      amount: '10',
    })
    expect(codeOf(payment)).toBe('order_cancelled')
    const tooMuch = await baker.as(baker.owner, 'customerPayment.record', {
      id: crypto.randomUUID(),
      orderId: created.id,
      kind: 'refund',
      businessDate: await baker.today(),
      method: 'cash',
      amount: '50.01',
    })
    expect(codeOf(tooMuch)).toBe('exceeds_outstanding')
    const back = await baker.pay({ orderId: created.id }, '50', { kind: 'refund' })
    expect(back.document).toMatchObject({ state: 'paid', overpaid: '0', refunded: '50' })
    expect((await baker.receivables()).groups).toEqual([])
    // A cancelled order never changes again.
    const deliver = await baker.as(baker.owner, 'order.deliver', {
      id: created.id,
      version: cancelled.version,
    })
    expect(codeOf(deliver)).toBe('order_cancelled')
  }, 180_000)
})
