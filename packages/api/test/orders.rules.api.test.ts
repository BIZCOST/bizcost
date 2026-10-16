import type {
  CustomerDto,
  CustomerListDto,
  CustomerPickDto,
  CustomerSimilarDto,
  DocumentPaymentsDto,
  OrderDto,
  ProductDto,
  RecordManyCustomerPaymentsDto,
} from '@bizcost/contracts'
import type { Db } from '@bizcost/db'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectApi, handlerFor, mutate, SECRET_KEY, type CallResult } from './helpers'
import { FACTORY, orderItem, OrderScope, OrdersApi } from './orders'
import { codeOf, ok, type Handler, type Person } from './purchasing'
import { item } from './sales'
import { BAKER } from './settings'

// The rules of orders, customer payments and refunds (ROADMAP.md M3 Step 5; Q2, Q16–Q18, D-160,
// D-181, D-214), through the API with the dev-only preview of Customers, Sales, Payments, Reports and
// Orders (D-125):
//   - at the same time (separate API instances, like serverless functions): a delivery racing a
//     payment and a cancel, two payments racing for what is owed, a refund racing an undo;
//   - never more than is owed: with the order, one payment, several at once (in the order given);
//   - an order with payments keeps its customer and never comes to less than was paid (BELOW_PAID);
//   - undo delivery refused when the delivery's day is closed (BOOKS_CLOSED);
//   - a sale "they'll pay later" owes; it is reversed or corrected only once its payments are;
//   - a refund by quantity takes off the frozen unit cost, one by amount takes off none;
//   - a member who does not see every order works only on their own; customers' phones are masked
//     for whoever does not see customers, and "Did you mean" finds the same name written otherwise;
//   - money given back stands on the payments it came from: such a payment is reversed after it
//     (a cancelled order's deposit never owed again, D-273);
//   - a delivery keeps the order's amounts, worked out again only when VAT registration changed.

const INSTANCES = 3

let api: OrdersApi
let dbs: Db[]
let handlers: Handler[]
let baker: OrderScope
let today: string
let product: ProductDto
let customer: CustomerDto

beforeAll(async () => {
  api = new OrdersApi()
  dbs = Array.from({ length: INSTANCES }, () => connectApi())
  handlers = dbs.map((db) => handlerFor(db, undefined, { supabaseSecretKey: SECRET_KEY }))
  baker = await OrderScope.open(api, BAKER)
  today = await baker.today()
  product = await baker.service('100')
  customer = await baker.customer({ name: 'Mariam Al Ali', phone: '050 123 4567' })
}, 60_000)

afterAll(async () => {
  for (const db of dbs) await db.$client.end()
  await api.close()
})

/** Calls a mutation as the baker's owner on instance `i`. */
function on<T>(i: number, path: string, input: object): Promise<CallResult<T>> {
  return mutate<T>(handlers[i % INSTANCES]!, path, {
    token: baker.owner.token,
    businessId: baker.id,
    input,
  })
}

/** A pending order of `qty` × the service at 100 for the customer. */
function newOrder(extra: object = {}, scope: OrderScope = baker, person?: Person) {
  return scope.order(
    { customerId: customer.id, lines: [orderItem(product.id, '1', '100')], ...extra },
    person,
  )
}

function payment(document: object, amount: string, extra: object = {}) {
  return { id: newId(), ...document, businessDate: today, method: 'cash', amount, ...extra }
}

/** The order's sales that stand (its delivery's, never more than one), as postgres. */
async function liveSales(orderId: string): Promise<number> {
  const [row] = await api.admin<{ n: number }[]>`
    select count(*)::int as n from app.sales
     where business_id = ${baker.id} and order_id = ${orderId} and source = 'order'
       and status = 'posted'`
  return row?.n ?? 0
}

describe('at the same time', () => {
  it('a delivery racing a payment and a cancel: one of the two wins, never a payment on a cancelled order', async () => {
    const outcomes = new Set<string>()
    for (let round = 0; round < 6; round++) {
      const order = await newOrder()
      const calls: Record<string, () => Promise<CallResult>> = {
        deliver: () => on(0, 'order.deliver', { id: order.id, version: order.version }),
        pay: () => on(1, 'customerPayment.record', payment({ orderId: order.id }, '100')),
        cancel: () => on(2, 'order.cancel', { id: order.id, version: order.version }),
      }
      // A different one starts first each round.
      const names = ['deliver', 'pay', 'cancel']
      const started = names.map((_, i) => names[(i + round) % 3]!)
      const settled = await Promise.all(
        started.map(async (name) => [name, await calls[name]!()] as const),
      )
      const results = new Map(settled)
      const delivered = results.get('deliver')!
      const paid = results.get('pay')!
      const cancelled = results.get('cancel')!
      const final = await baker.getOrder(order.id)
      expect(delivered.error === undefined, delivered.raw).not.toBe(cancelled.error === undefined)
      if (delivered.error === undefined) {
        outcomes.add(`delivered, ${paid.error === undefined ? 'paid' : 'unpaid'}`)
        expect(codeOf(cancelled)).toMatch(/^(conflict|document_posted)$/)
        expect(final.status).toBe('delivered')
        expect(await liveSales(order.id)).toBe(1)
        // Delivered, the payment always goes in: it is owed either way.
        expect(paid.error, paid.raw).toBeUndefined()
        expect(final.payment).toMatchObject({ state: 'paid', paid: '100', owed: '0' })
      } else {
        expect(codeOf(delivered)).toMatch(/^(conflict|order_cancelled)$/)
        expect(final.status).toBe('cancelled')
        expect(await liveSales(order.id)).toBe(0)
        if (paid.error === undefined) {
          // Paid before it was cancelled: the deposit is money to give back.
          outcomes.add('cancelled, paid before')
          expect(final.payment).toMatchObject({ state: 'overpaid', overpaid: '100', owed: '0' })
        } else {
          outcomes.add('cancelled, payment refused')
          expect(codeOf(paid)).toBe('order_cancelled')
          expect(final.payment).toMatchObject({ paid: '0', owed: '0' })
        }
      }
    }
    expect(outcomes.size).toBeGreaterThan(0)
  }, 120_000)

  it('two payments racing for what is owed: one goes in, the other is more than is owed', async () => {
    for (let round = 0; round < 3; round++) {
      const order = await newOrder()
      const results = await Promise.all([
        on(0, 'customerPayment.record', payment({ orderId: order.id }, '100')),
        on(1, 'customerPayment.record', payment({ orderId: order.id }, '100')),
      ])
      expect(results.filter((r) => r.error === undefined)).toHaveLength(1)
      expect(results.map(codeOf).filter(Boolean)).toEqual(['exceeds_outstanding'])
      expect((await baker.getOrder(order.id)).payment).toMatchObject({ paid: '100', owed: '0' })
    }
  }, 60_000)

  it('a refund racing an undo of the delivery: never both', async () => {
    for (let round = 0; round < 3; round++) {
      const delivered = await baker.deliver(await newOrder())
      const sale = await baker.sale(delivered.saleId!)
      const [refund, undo] = await Promise.all([
        on(round % 2, 'sale.refund', {
          id: newId(),
          orderId: delivered.id,
          by: 'amount',
          lines: [{ lineId: sale.lines[0]!.id, amount: '10' }],
        }),
        on((round + 1) % 2, 'order.undoDelivery', { id: delivered.id }),
      ])
      expect([refund, undo].filter((r) => r.error === undefined)).toHaveLength(1)
      if (refund.error === undefined) {
        expect(codeOf(undo)).toBe('sale_has_refunds')
        expect((await baker.getOrder(delivered.id)).status).toBe('delivered')
      } else {
        expect(codeOf(refund)).toBe('document_not_posted')
        expect((await baker.getOrder(delivered.id)).status).toBe('pending')
        expect(await liveSales(delivered.id)).toBe(0)
      }
    }
  }, 60_000)
})

describe('never more than is owed', () => {
  it('with the order, a payment, or several at once', async () => {
    // A deposit beyond the order's total.
    const tooMuch = await baker.as(baker.owner, 'order.create', {
      id: newId(),
      businessDate: today,
      customerId: customer.id,
      lines: [orderItem(product.id, '1', '100')],
      payment: { id: newId(), method: 'cash', amount: '100.01' },
    })
    expect(codeOf(tooMuch)).toBe('exceeds_outstanding')
    // The method is never preselected: required.
    const noMethod = await baker.as(baker.owner, 'order.create', {
      id: newId(),
      businessDate: today,
      lines: [orderItem(product.id, '1', '100')],
      payment: { id: newId(), amount: '10' },
    })
    expect(codeOf(noMethod)).toBe('validation')

    const order = await newOrder({ payment: { id: newId(), method: 'card', amount: '40' } })
    expect(order.payment).toMatchObject({ state: 'deposit', paid: '40', owed: '60' })
    expect(
      codeOf(
        await baker.as(
          baker.owner,
          'customerPayment.record',
          payment({ orderId: order.id }, '60.01'),
        ),
      ),
    ).toBe('exceeds_outstanding')
    // Money given back only of what was paid beyond (nothing here).
    expect(
      codeOf(
        await baker.as(
          baker.owner,
          'customerPayment.record',
          payment({ orderId: order.id }, '1', { kind: 'refund' }),
        ),
      ),
    ).toBe('exceeds_outstanding')
  })

  it('pay several at once: in the order given, each up to what it owes, one payment each', async () => {
    const buyer = await baker.customer({ name: `Noura ${newId().slice(-6)}` })
    const first = await newOrder({ customerId: buyer.id })
    const second = await newOrder({
      customerId: buyer.id,
      lines: [orderItem(product.id, '1', '50')],
    })
    const ids = [newId(), newId()]
    const many = (amount: string) => ({
      customerId: buyer.id,
      businessDate: today,
      method: 'bank_transfer',
      amount,
      documents: [
        { id: ids[0], orderId: first.id },
        { id: ids[1], orderId: second.id },
      ],
    })
    // More than they owe in all (150).
    expect(codeOf(await baker.as(baker.owner, 'customerPayment.recordMany', many('150.01')))).toBe(
      'exceeds_outstanding',
    )
    const paid = ok(
      await baker.as<RecordManyCustomerPaymentsDto>(
        baker.owner,
        'customerPayment.recordMany',
        many('120'),
      ),
    )
    expect(paid.payments.map((p) => [p.id, p.documentId, p.amount])).toEqual([
      [ids[0], first.id, '100'],
      [ids[1], second.id, '20'],
    ])
    expect(paid.documents.map((d) => [d.id, d.state, d.owed])).toEqual([
      [first.id, 'paid', '0'],
      [second.id, 'deposit', '30'],
    ])
    // A retry is answered as recorded, taking nothing more.
    ok(await baker.as(baker.owner, 'customerPayment.recordMany', many('120')))
    const owed = await baker.receivables({ customerId: buyer.id })
    expect(owed.groups.map((g) => [g.customerId, g.owed])).toEqual([[buyer.id, '30']])
  })
})

describe('an order with payments', () => {
  it('keeps its customer and never comes to less than was paid', async () => {
    const order = await newOrder({ payment: { id: newId(), method: 'cash', amount: '80' } })
    const other = await baker.customer({ name: `Hessa ${newId().slice(-6)}` })
    const fields = {
      id: order.id,
      version: order.version,
      businessDate: order.businessDate,
      customerId: customer.id,
      lines: [orderItem(product.id, '1', '100')],
    }
    expect(
      codeOf(await baker.as(baker.owner, 'order.update', { ...fields, customerId: other.id })),
    ).toBe('validation')
    expect(
      codeOf(
        await baker.as(baker.owner, 'order.update', {
          ...fields,
          lines: [orderItem(product.id, '1', '79.99')],
        }),
      ),
    ).toBe('below_paid')
    const changed = ok(
      await baker.as<{ data: OrderDto }>(baker.owner, 'order.update', {
        ...fields,
        lines: [orderItem(product.id, '1', '80')],
      }),
    ).data
    expect(changed.payment).toMatchObject({ state: 'paid', total: '80', owed: '0' })
  })

  it('undo delivery is refused when the delivery’s day is closed', async () => {
    const own = await OrderScope.open(api, BAKER)
    const day = await own.today()
    const service = await own.service('100')
    const delivered = await own.deliver(
      await own.order({ lines: [orderItem(service.id, '1', '100')] }),
    )
    ok(await own.run('books.close', { closedThrough: day }))
    expect(codeOf(await own.as(own.owner, 'order.undoDelivery', { id: delivered.id }))).toBe(
      'books_closed',
    )
    ok(await own.run('books.close', { closedThrough: null }))
    expect((await own.undo(delivered.id)).status).toBe('pending')
  })
})

describe('a sale “they’ll pay later”', () => {
  it('owes; reversed or corrected only once its payments are reversed', async () => {
    const sale = await baker.sell({
      businessDate: today,
      customerId: customer.id,
      payLater: true,
      lines: [item(product.id, '1', '100')],
    })
    expect(sale).toMatchObject({ payLater: true, customerId: customer.id })
    expect(sale.payment).toMatchObject({ state: 'unpaid', owed: '100' })
    const owed = await baker.receivables({ customerId: customer.id })
    expect(owed.groups[0]?.documents.find((d) => d.id === sale.id)).toMatchObject({
      kind: 'sale',
      owed: '100',
    })
    const paid = ok(
      await baker.as<DocumentPaymentsDto>(
        baker.owner,
        'customerPayment.record',
        payment({ saleId: sale.id }, '40'),
      ),
    )
    expect(paid.document).toMatchObject({ state: 'deposit', owed: '60' })
    expect(codeOf(await baker.as(baker.owner, 'sale.reverse', { id: sale.id }))).toBe(
      'sale_has_payments',
    )
    expect(
      codeOf(await baker.as(baker.owner, 'sale.correct', { id: sale.id, newId: newId() })),
    ).toBe('sale_has_payments')
    ok(await baker.as(baker.owner, 'customerPayment.reverse', { id: paid.items[0]!.id }))
    expect((await baker.reverseSale(sale.id)).status).toBe('reversed')

    // A sale paid when made, and a day sheet, take no payment and name no customer to pay later.
    const cash = await baker.sell({ businessDate: today, lines: [item(product.id, '1', '100')] })
    expect(
      codeOf(
        await baker.as(baker.owner, 'customerPayment.record', payment({ saleId: cash.id }, '1')),
      ),
    ).toBe('validation')
    expect(
      codeOf(
        await baker.as(baker.owner, 'sale.create', {
          businessDate: today,
          id: newId(),
          source: 'single',
          channelId: await baker.channelId(),
          payLater: true,
          lines: [item(product.id, '1', '100')],
        }),
      ),
    ).toBe('validation')
  })
})

describe('refunds', () => {
  it('by quantity take off the frozen unit cost; by amount none; never more than is left', async () => {
    const kit = await baker.pieceMaterial('Cake kit', '32.4', today, '50')
    const cake = await baker.madeOf(kit, '150')
    const delivered = await baker.deliver(
      await baker.order({ customerId: customer.id, lines: [orderItem(cake.id, '2', '150')] }),
    )
    const sale = await baker.sale(delivered.saleId!)
    const line = sale.lines[0]!
    expect(line).toMatchObject({ qty: '2', cost: '64.8' })

    const byQty = await baker.refund({
      orderId: delivered.id,
      by: 'quantity',
      lines: [{ lineId: line.id, qty: '1' }],
    })
    expect(byQty.lines[0]).toMatchObject({ qty: '-1', net: '-150', cost: '-32.4' })
    const byAmount = await baker.refund({
      saleId: delivered.saleId,
      by: 'amount',
      lines: [{ lineId: line.id, amount: '50' }],
    })
    expect(byAmount.lines[0]).toMatchObject({ qty: '-1', net: '-50', cost: '0' })
    expect((await baker.sale(delivered.saleId!)).lines[0]?.left).toMatchObject({
      qty: '1',
      net: '100',
    })
    // More than is left (1 cake), by quantity: refused.
    expect(
      codeOf(
        await baker.as(baker.owner, 'sale.refund', {
          id: newId(),
          orderId: delivered.id,
          by: 'quantity',
          lines: [{ lineId: line.id, qty: '1.5' }],
        }),
      ),
    ).toBe('exceeds_sale')
    const order = await baker.getOrder(delivered.id)
    expect(order.profit).toMatchObject({ sales: '100', materials: '32.4' })
    // The order owes what is left: 100; a refund is reversed like a sale.
    expect(order.payment).toMatchObject({ total: '300', credited: '200', owed: '100' })
    expect((await baker.reverseSale(byAmount.id)).status).toBe('reversed')
    expect((await baker.getOrder(delivered.id)).payment).toMatchObject({ owed: '150' })
  })
})

describe('who sees what', () => {
  it('a member who does not see every order works only on their own', async () => {
    const employee = await api.member(baker, 'employee')
    const owners = await newOrder()
    const own = await newOrder({}, baker, employee)
    expect(own.payment).toBeNull()
    // The owner's order is not theirs: not found, for reading and changing alike.
    expect(codeOf(await baker.as(employee, 'order.get', { id: owners.id }))).toBe('not_found')
    expect(
      codeOf(await baker.as(employee, 'order.cancel', { id: owners.id, version: owners.version })),
    ).toBe('not_found')
    const listed = await baker.orders({}, employee)
    expect(listed.items.map((o) => o.id)).toEqual([own.id])
    // Their own they deliver; its profit and payments are not theirs to see.
    const delivered = await baker.deliver(own, undefined, employee)
    expect(delivered).toMatchObject({ status: 'delivered', payment: null, profit: null })
    // No payments with the order without payments.customers.record.
    expect(
      codeOf(
        await baker.as(employee, 'order.create', {
          id: newId(),
          businessDate: today,
          lines: [orderItem(product.id, '1', '100')],
          payment: { id: newId(), method: 'cash', amount: '10' },
        }),
      ),
    ).toBe('forbidden')
  })

  it('customers: phones masked for whoever does not see customers; "Did you mean" and phone search', async () => {
    const employee = await api.member(baker, 'employee')
    const picked = ok(
      await baker.as<CustomerPickDto>(employee, 'customer.pick', { search: 'Mariam Al' }),
    )
    expect(picked.items.find((c) => c.id === customer.id)).toMatchObject({
      name: 'Mariam Al Ali',
      phone: null,
      phoneLast4: '4567',
    })
    expect(codeOf(await baker.as(employee, 'customer.list', {}))).toBe('forbidden')
    expect(codeOf(await baker.as(employee, 'customer.get', { id: customer.id }))).toBe('forbidden')
    // They add customers.
    const added = ok(
      await baker.as<CustomerDto>(employee, 'customer.create', { id: newId(), name: 'Salem' }),
    )
    expect(added.name).toBe('Salem')

    // The owner sees the phone; finds a customer by a part of it, spaces or not.
    const owner = ok(
      await baker.as<CustomerPickDto>(baker.owner, 'customer.pick', { search: 'Mariam' }),
    )
    expect(owner.items.find((c) => c.id === customer.id)?.phone).toBe('050 123 4567')
    for (const search of ['1234567', '123 45', '4567']) {
      const found = ok(await baker.as<CustomerListDto>(baker.owner, 'customer.list', { search }))
      expect(
        found.items.map((c) => c.id),
        search,
      ).toContain(customer.id)
    }
    // "Did you mean": the same name written otherwise, then names like it.
    const same = ok(
      await baker.as<CustomerSimilarDto>(baker.owner, 'customer.similar', {
        name: '  mariam  AL ALI ',
      }),
    )
    expect(same.same.map((c) => c.id)).toContain(customer.id)
    const self = ok(
      await baker.as<CustomerSimilarDto>(baker.owner, 'customer.similar', {
        name: 'Mariam Al Ali',
        excludeId: customer.id,
      }),
    )
    expect(self.same.map((c) => c.id)).not.toContain(customer.id)
  })
})

// Nothing is cached on the server (D-212): the next read of the Dashboard's cards shows each change.
describe('the Dashboard’s cards', () => {
  it('recent orders, what customers owe and the delivery margin follow each change', async () => {
    const own = await OrderScope.open(api, BAKER)
    const service = await own.service('100')
    const buyer = await own.customer({ name: 'Shamma' })
    const before = await own.cards()
    expect(before.recentOrders).toEqual([])
    expect(before.customersOwe).toMatchObject({ owed: '0', customers: 0, documents: 0 })
    // No delivery this month yet: no card.
    expect(before.deliveryMargin).toBeNull()

    const order = await own.order({
      customerId: buyer.id,
      lines: [orderItem(service.id, '1', '100'), { kind: 'delivery', id: newId(), amount: '20' }],
      deliveryNeeded: true,
      deliveryArea: 'Mirdif',
      deliveryCost: '25',
      payment: { id: newId(), method: 'card', amount: '50' },
    })
    const pending = await own.cards()
    expect(pending.recentOrders).toEqual([
      expect.objectContaining({
        id: order.id,
        number: '#1001',
        itemName: service.name,
        customerName: 'Shamma',
        total: '120',
        status: 'pending',
        paymentState: 'deposit',
      }),
    ])
    expect(pending.customersOwe).toMatchObject({ owed: '70', customers: 1, documents: 1 })

    await own.deliver(order)
    const delivered = await own.cards()
    expect(delivered.recentOrders?.[0]).toMatchObject({ status: 'delivered' })
    expect(delivered.deliveryMargin).toMatchObject({
      deliveries: 1,
      charged: '20',
      cost: '25',
      margin: '-5',
    })

    await own.pay({ orderId: order.id }, '70')
    const paid = await own.cards()
    expect(paid.recentOrders?.[0]).toMatchObject({ paymentState: 'paid' })
    expect(paid.customersOwe).toMatchObject({ owed: '0', customers: 0, documents: 0 })
  })
})

// A refund of a sale whose order was cancelled is not possible: a cancelled order has no sale.
describe('a cancelled order', () => {
  it('is not delivered, refunded or paid; its deposit is given back', async () => {
    const order = await newOrder({ payment: { id: newId(), method: 'cash', amount: '30' } })
    const cancelled = await baker.cancel(order)
    expect(cancelled.status).toBe('cancelled')
    expect(
      codeOf(
        await baker.as(baker.owner, 'order.deliver', { id: order.id, version: cancelled.version }),
      ),
    ).toBe('order_cancelled')
    expect(
      codeOf(
        await baker.as(baker.owner, 'sale.refund', {
          id: newId(),
          orderId: order.id,
          by: 'amount',
          lines: [{ lineId: newId(), amount: '1' }],
        }),
      ),
    ).toBe('order_cancelled')
    const back = await baker.pay({ orderId: order.id }, '30', { kind: 'refund' })
    expect(back.document).toMatchObject({ state: 'paid', overpaid: '0', refunded: '30' })
    // It never had a sale.
    const sales = (await baker.sales({ customerId: customer.id })).items
    expect(sales.length).toBeGreaterThan(0)
    expect(sales.every((s) => s.orderNumber !== order.number)).toBe(true)
  })

  it('its deposit, once given back, is reversed only after the money given back (D-273)', async () => {
    const order = await newOrder({ payment: { id: newId(), method: 'cash', amount: '40' } })
    await baker.cancel(order)
    await baker.pay({ orderId: order.id }, '40', { kind: 'refund' })
    const listed = ok(
      await baker.as<DocumentPaymentsDto>(baker.owner, 'customerPayment.list', {
        orderId: order.id,
      }),
    )
    const deposit = listed.items.find((p) => p.kind === 'payment')!
    const back = listed.items.find((p) => p.kind === 'refund')!
    // The deposit first: refused, nothing changes (it would owe 40 that no payment can settle).
    expect(codeOf(await baker.as(baker.owner, 'customerPayment.reverse', { id: deposit.id }))).toBe(
      'payment_has_money_back',
    )
    expect((await baker.getOrder(order.id)).payment).toMatchObject({ state: 'paid', owed: '0' })
    // The money given back first, then the deposit: it owes nothing, and nothing is back owed.
    ok(await baker.as(baker.owner, 'customerPayment.reverse', { id: back.id }))
    ok(await baker.as(baker.owner, 'customerPayment.reverse', { id: deposit.id }))
    expect((await baker.getOrder(order.id)).payment).toMatchObject({ owed: '0', overpaid: '0' })
  })
})

describe('money given back stands on the payments it came from (D-273)', () => {
  it('a delivered order paid beyond its total: a payment the money given back needs waits for it', async () => {
    // 100, paid 90 with the order and 10 later; a price cut of 30 makes 30 paid beyond it, and 10
    // of that is given back.
    const order = await newOrder({ payment: { id: newId(), method: 'cash', amount: '90' } })
    await baker.pay({ orderId: order.id }, '10')
    const delivered = await baker.deliver(await baker.getOrder(order.id))
    await baker.refund({
      orderId: order.id,
      by: 'amount',
      lines: [{ lineId: (await baker.sale(delivered.saleId!)).lines[0]!.id, amount: '30' }],
    })
    await baker.pay({ orderId: order.id }, '10', { kind: 'refund' })
    const listed = ok(
      await baker.as<DocumentPaymentsDto>(baker.owner, 'customerPayment.list', {
        orderId: order.id,
      }),
    )
    const first = listed.items.find((p) => p.kind === 'payment' && p.amount === '90')!
    const second = listed.items.find((p) => p.kind === 'payment' && p.amount === '10')!
    const back = listed.items.find((p) => p.kind === 'refund')!
    // Without the 90, the 10 given back was never paid beyond it: refused, nothing changes.
    expect(codeOf(await baker.as(baker.owner, 'customerPayment.reverse', { id: first.id }))).toBe(
      'payment_has_money_back',
    )
    // The 10 is not needed by it (20 is still paid beyond): reversed.
    const after = ok(
      await baker.as<DocumentPaymentsDto>(baker.owner, 'customerPayment.reverse', {
        id: second.id,
      }),
    )
    expect(after.document).toMatchObject({ owed: '0', overpaid: '10' })
    // The money given back first, then the 90: it owes the 70 it comes to.
    ok(await baker.as(baker.owner, 'customerPayment.reverse', { id: back.id }))
    const owed = ok(
      await baker.as<DocumentPaymentsDto>(baker.owner, 'customerPayment.reverse', {
        id: first.id,
      }),
    )
    expect(owed.document).toMatchObject({ owed: '70', overpaid: '0' })
  })
})

describe('a delivery keeps the order’s amounts unless VAT registration changed (D-273)', () => {
  it('registered when ordered, not when delivered: worked out again, paid beyond is money back', async () => {
    const factory = await OrderScope.open(api, FACTORY)
    const service = await factory.service('100')
    const order = await factory.order({
      lines: [orderItem(service.id, '1', '100')],
      payment: { id: newId(), method: 'bank_transfer', amount: '105' },
    })
    expect(order).toMatchObject({ vatRegistered: true, total: '105' })
    await factory.deregisterVat()
    const delivered = await factory.deliver(order)
    expect(delivered).toMatchObject({ vatRegistered: false, vatTotal: '0', total: '100' })
    expect(delivered.payment).toMatchObject({ state: 'overpaid', owed: '0', overpaid: '5' })
    expect((await factory.sale(delivered.saleId!)).total).toBe('100')
  })
})
