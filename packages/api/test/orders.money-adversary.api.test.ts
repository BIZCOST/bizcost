import type { CustomerPaymentListDto, DocumentPaymentsDto, OrderDto } from '@bizcost/contracts'
import type { Db } from '@bizcost/db'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  connectAdmin,
  connectApi,
  handlerFor,
  mutate,
  SECRET_KEY,
  type CallResult,
} from './helpers'
import { FACTORY, orderDelivery, orderItem, OrderScope, OrdersApi } from './orders'
import { codeOf, ok, type Handler } from './purchasing'
import { BAKER } from './settings'

// Money adversary of M3 Step 5 (orders, customer payments, refunds): each test below states a rule of
// the plan or of D-263–D-271 that the API broke as first built; each is fixed by D-273.
//
//   1. A delivery works the order's sale out again from the product's VAT settings as they are on the
//      delivery day, not from the order's own lines. A product edited between the order and its
//      delivery changes what a paid order comes to: it owes again, or is suddenly paid beyond its
//      total (BELOW_PAID bypassed). orders.ts deliverOrder says "they change only when VAT
//      registration did".
//   2. A cancelled order (its obligation is 0) ends up owing money that nothing can settle: its deposit
//      is reversed after the money was given back, and a payment on it is ORDER_CANCELLED.
//   3. Undo delivery drops the delivery cost entered on the delivered sale (sale.fillDeliveryCost,
//      D-230): delivered again, the order has none and Real profit/Delivery margin lose it.
//   4. The same, the other way round (the fix's check): the cost entered on the order's sale after
//      the undo, or by a fill that waited on the sale's row while the undo committed, lands on a
//      reversed sale that counts nowhere, and the order delivered again has none. Both orders of the
//      race are forced on the sale's row (an admin transaction holds it, as sales.concurrency does).

let api: OrdersApi

beforeAll(() => {
  api = new OrdersApi()
})

afterAll(async () => {
  await api.close()
})

describe('a delivery keeps the amounts the order was paid on', () => {
  let factory: OrderScope

  beforeAll(async () => {
    factory = await OrderScope.open(api, FACTORY)
  }, 60_000)

  it('the product’s "price includes VAT" changed after the order was paid in full: still 105, still paid', async () => {
    // AED 105 with VAT included: net 100, VAT 5, paid in full with the order.
    const product = await factory.service('105', { priceIncludesVat: true })
    const order = await factory.order({
      lines: [orderItem(product.id, '1', '105')],
      payment: { id: newId(), method: 'bank_transfer', amount: '105' },
    })
    expect(order).toMatchObject({
      vatRegistered: true,
      netTotal: '100',
      vatTotal: '5',
      total: '105',
      payment: { state: 'paid', owed: '0' },
    })
    // The owner later prices the product before VAT (a catalogue change, not this order's).
    await factory.updateProduct(product, { priceIncludesVat: false })

    const delivered = await factory.deliver(order)
    // The VAT registration did not change: the order and its sale keep 105, and nothing is owed.
    expect(delivered).toMatchObject({ total: '105', vatTotal: '5' })
    expect(delivered.payment).toMatchObject({ state: 'paid', owed: '0', overpaid: '0' })
    const sale = await factory.sale(delivered.saleId!)
    expect(sale.total).toBe('105')
  })

  it('the product’s VAT category changed after the order was paid in full: never paid beyond its total', async () => {
    // AED 100 before VAT, standard-rated: 105 with VAT, paid in full with the order.
    const product = await factory.service('100')
    const order = await factory.order({
      lines: [orderItem(product.id, '1', '100')],
      payment: { id: newId(), method: 'bank_transfer', amount: '105' },
    })
    expect(order).toMatchObject({ total: '105', payment: { state: 'paid', owed: '0' } })
    // An edit to less than was paid is refused (BELOW_PAID) ...
    expect(
      codeOf(
        await factory.as(factory.owner, 'order.update', {
          id: order.id,
          version: order.version,
          businessDate: order.businessDate,
          lines: [orderItem(product.id, '1', '95')],
        }),
      ),
    ).toBe('below_paid')
    // ... but the product's category changing makes the delivery do just that.
    await factory.updateProduct(product, { vatCategory: 'zero_rated' })

    const delivered = await factory.deliver(order)
    expect(delivered.total).toBe('105')
    expect(delivered.payment).toMatchObject({ state: 'paid', owed: '0', overpaid: '0' })
  })

  it('an order with a discount on the whole order is still delivered after one product’s "price includes VAT" changed', async () => {
    const first = await factory.service('100')
    const second = await factory.service('50')
    // 10 % off the whole order: (100 + 50) × 0.9 = 135 + VAT 6.75 = 141.75, a deposit of 50.
    const order = await factory.order({
      lines: [orderItem(first.id, '1', '100'), orderItem(second.id, '1', '50')],
      discount: { percent: '10' },
      payment: { id: newId(), method: 'card', amount: '50' },
    })
    expect(order).toMatchObject({ total: '141.75', payment: { state: 'deposit', owed: '91.75' } })
    await factory.updateProduct(second, { priceIncludesVat: true })

    // The order was valid when entered and nothing about it changed: it is delivered as it is.
    const delivered = await factory.as<{ data: OrderDto }>(factory.owner, 'order.deliver', {
      id: order.id,
      version: order.version,
    })
    expect(delivered.error?.message, delivered.raw).toBeUndefined()
    expect(delivered.data?.data).toMatchObject({ status: 'delivered', total: '141.75' })
  })
})

describe('a cancelled order never owes', () => {
  it('its deposit reversed after the money was given back: nothing is owed on it', async () => {
    const baker = await OrderScope.open(api, BAKER)
    const service = await baker.service('100')
    const customer = await baker.customer({ name: `Moza ${newId().slice(-6)}` })
    const order = await baker.order({
      customerId: customer.id,
      lines: [orderItem(service.id, '1', '100')],
      payment: { id: newId(), method: 'cash', amount: '50' },
    })
    const cancelled = await baker.cancel(order)
    expect(cancelled.payment).toMatchObject({ state: 'overpaid', overpaid: '50', owed: '0' })
    // The deposit is given back ...
    await baker.pay({ orderId: order.id }, '50', { kind: 'refund' })
    // ... then the deposit is reversed ("recorded by mistake").
    const listed = ok(
      await baker.as<CustomerPaymentListDto>(baker.owner, 'customerPayment.list', {
        orderId: order.id,
      }),
    )
    const deposit = listed.items.find((p) => p.kind === 'payment')!
    const reversed = await baker.as<DocumentPaymentsDto>(baker.owner, 'customerPayment.reverse', {
      id: deposit.id,
    })

    // Either the reversal is refused (the money given back stands on it), or the order still owes
    // nothing: a cancelled order comes to 0 (D-267), and no payment can be recorded on it.
    const final: OrderDto = await baker.getOrder(order.id)
    expect(final.payment?.owed, JSON.stringify(reversed.data ?? reversed.error)).toBe('0')
    const owed = await baker.receivables({ customerId: customer.id })
    expect(owed.owed).toBe('0')
    // What it would take to settle it is refused.
    expect(
      codeOf(
        await baker.as(baker.owner, 'customerPayment.record', {
          id: newId(),
          orderId: order.id,
          businessDate: await baker.today(),
          method: 'cash',
          amount: '50',
        }),
      ),
    ).toBe('order_cancelled')
  })
})

describe('undo delivery keeps what the delivery cost', () => {
  it('a delivery cost entered after the delivery is still there when it is delivered again', async () => {
    const baker = await OrderScope.open(api, BAKER)
    const service = await baker.service('100')
    // Delivery charged 20; what it cost was not known when the order was entered.
    const order = await baker.order({
      lines: [orderItem(service.id, '1', '100'), orderDelivery('20')],
      deliveryNeeded: true,
      deliveryArea: 'Mirdif',
    })
    const delivered = await baker.deliver(order)
    expect(delivered.deliveryCost).toBeNull()
    // The courier's 25 is entered on the delivered sale (D-230: filled once later).
    ok(await baker.run('sale.fillDeliveryCost', { id: delivered.saleId, deliveryCost: '25' }))
    expect((await baker.getOrder(order.id)).deliveryCost).toBe('25')

    // Delivered on the wrong day: undone, then delivered again.
    const undone = await baker.undo(order.id)
    expect(undone.deliveryCost).toBe('25')
    const again = await baker.deliver(undone)
    expect(again.deliveryCost).toBe('25')
    expect((await baker.sale(again.saleId!)).deliveryCost).toBe('25')
  })

  it('a delivery cost entered on its sale after the undo is refused: the order takes it instead', async () => {
    const baker = await OrderScope.open(api, BAKER)
    const service = await baker.service('100')
    const order = await baker.order({
      lines: [orderItem(service.id, '1', '100'), orderDelivery('20')],
      deliveryNeeded: true,
      deliveryArea: 'Mirdif',
    })
    const delivered = await baker.deliver(order)
    const undone = await baker.undo(order.id)
    expect(undone.deliveryCost).toBeNull()

    // The courier's 25 typed on the old sale (still open from the sales list, reversed): refused,
    // since it would count nowhere.
    expect(
      codeOf(
        await baker.run('sale.fillDeliveryCost', { id: delivered.saleId, deliveryCost: '25' }),
      ),
    ).toBe('document_not_posted')
    expect((await baker.sale(delivered.saleId!)).deliveryCost).toBeNull()

    // It is entered on the order, which its next delivery keeps.
    const changed = ok(
      await baker.as<{ data: OrderDto }>(baker.owner, 'order.update', {
        id: undone.id,
        version: undone.version,
        businessDate: undone.businessDate,
        lines: [orderItem(service.id, '1', '100'), orderDelivery('20')],
        deliveryNeeded: true,
        deliveryArea: 'Mirdif',
        deliveryCost: '25',
      }),
    ).data
    const again = await baker.deliver(changed)
    expect((await baker.sale(again.saleId!)).deliveryCost).toBe('25')
  })
})

describe('a delivery cost filled while the delivery is undone (forced on the sale’s row)', () => {
  // Two more API instances, each with its own database connection; an admin transaction holds the
  // sale's row while the two calls start one after the other, each once the one before waits on it.
  let dbs: Db[]
  let handlers: Handler[]
  let baker: OrderScope
  let serviceId: string

  beforeAll(async () => {
    dbs = [connectApi(), connectApi()]
    handlers = dbs.map((db) => handlerFor(db, undefined, { supabaseSecretKey: SECRET_KEY }))
    baker = await OrderScope.open(api, BAKER)
    serviceId = (await baker.service('100')).id
  }, 60_000)

  afterAll(async () => {
    for (const db of dbs) await db.$client.end()
  })

  type Run = (handler: Handler) => Promise<CallResult>

  const undo =
    (orderId: string): Run =>
    (handler) =>
      mutate(handler, 'order.undoDelivery', {
        token: baker.owner.token,
        businessId: baker.id,
        input: { id: orderId },
      })
  const fill =
    (saleId: string): Run =>
    (handler) =>
      mutate(handler, 'sale.fillDeliveryCost', {
        token: baker.owner.token,
        businessId: baker.id,
        input: { id: saleId, deliveryCost: '25' },
      })

  /** A delivered order with a delivery charged 20 and no delivery cost yet. */
  async function delivered(): Promise<OrderDto> {
    const order = await baker.order({
      lines: [orderItem(serviceId, '1', '100'), orderDelivery('20')],
      deliveryNeeded: true,
      deliveryArea: 'Al Barsha',
    })
    return baker.deliver(order)
  }

  /** Until each of `pids` waits on a lock (30 s at most). */
  async function untilWaiting(pids: readonly number[], what: string) {
    for (let tries = 0; tries < 600; tries++) {
      const [row] = await api.admin<{ n: number }[]>`
        select count(distinct pid)::int as n from pg_locks
         where not granted and pid = any(${`{${pids.join(',')}}`}::int[])`
      if (row!.n >= pids.length) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`${what}: ${pids.length} calls were expected to wait on a lock`)
  }

  /** `first` then `second` wait on the sale's row; released, they run in that order. */
  async function race(saleId: string, first: Run, second: Run, what: string) {
    const holder = connectAdmin()
    try {
      let release!: () => void
      const released = new Promise<void>((resolve) => (release = resolve))
      let holding!: () => void
      const held = new Promise<void>((resolve) => (holding = resolve))
      const transaction = holder.begin(async (sql) => {
        await sql`select id from app.sales where id = ${saleId} for update`
        holding()
        await released
      })
      await held
      const pids = await Promise.all(
        dbs.map(async (db) => {
          const [row] = await db.$client<{ pid: number }[]>`select pg_backend_pid() as pid`
          return row!.pid
        }),
      )
      const firstDone = first(handlers[0]!)
      await untilWaiting(pids.slice(0, 1), what)
      const secondDone = second(handlers[1]!)
      await untilWaiting(pids, what)
      release()
      await transaction
      return [await firstDone, await secondDone] as const
    } finally {
      await holder.end()
    }
  }

  it('the undo first: the fill that waited is refused, and the order is still without a cost', async () => {
    const order = await delivered()
    const [undone, filled] = await race(
      order.saleId!,
      undo(order.id),
      fill(order.saleId!),
      'undo then fill',
    )
    expect(undone.error?.message).toBeUndefined()
    expect(codeOf(filled)).toBe('document_not_posted')
    expect((await baker.sale(order.saleId!)).deliveryCost).toBeNull()
    const pending = await baker.getOrder(order.id)
    expect(pending).toMatchObject({ status: 'pending', deliveryCost: null })
  }, 60_000)

  it('the fill first: the undo that waited takes it back onto the order, kept when delivered again', async () => {
    const order = await delivered()
    const [filled, undone] = await race(
      order.saleId!,
      fill(order.saleId!),
      undo(order.id),
      'fill then undo',
    )
    expect(filled.error?.message).toBeUndefined()
    expect(undone.error?.message).toBeUndefined()
    const pending = await baker.getOrder(order.id)
    expect(pending).toMatchObject({ status: 'pending', deliveryCost: '25' })
    const again = await baker.deliver(pending)
    expect((await baker.sale(again.saleId!)).deliveryCost).toBe('25')
  }, 60_000)
})
