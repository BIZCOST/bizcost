import type {
  AttachmentDto,
  AttachmentUploadUrlDto,
  CustomerDto,
  LocationDto,
  MemberLocationsDto,
  OrderDto,
  ProductDto,
  SaleDto,
} from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PNG, uploadTo } from '../hardening/fixture'
import { FACTORY, orderDelivery, orderItem, OrderScope, OrdersApi } from '../orders'
import { tag } from '../product-costs'
import { codeOf, ok } from '../purchasing'
import { BAKER } from '../settings'

// ADVERSARY (M3 Step 5: Customers, Orders with delivery, customer payments, refunds). Cases 1–3 failed
// on the code as first built and name the rule they broke (fixed by D-273); case 4 was refuted and
// holds the documented rule instead:
//   1. A member without the costs switch who delivers an order someone else entered becomes the
//      "entered by" of the order's sale, and sale.get hands them its delivery cost in
//      `ownDeliveryCost` (D-269: an order's delivery cost is `cost`, except the ENTERING member's own;
//      D-230: `ownDeliveryCost` is what the caller typed).
//   2. A member without customers.items.view who replays their own `customer.create` gets the
//      customer as it is NOW: the phone, email, TRN, address and notes the owner added since (D-263:
//      "a member who adds a customer without it gets back what they typed"; personal data is a
//      permission).
//   3. An order's files ignore "Branches they work in": a member limited to one branch lists and adds
//      files on another branch's order, which order.get answers NOT_FOUND (Q12, D-265: "within their
//      branches").
//   4. A member who may not see payments may still cancel their own order with a deposit on it:
//      `.manage` "enters, changes and cancels" (D-265; the Q10 table), cancelling changes nothing in
//      the books and its deposit shows as money back to the customer (the plan's Step 5). The refusal
//      of an edit (D-265: "changed only by a member who sees payments") is about changing what it
//      comes to; a cancel tells them nothing about the payments, which stay hidden from them.

let api: OrdersApi

beforeAll(() => {
  api = new OrdersApi()
})

afterAll(async () => {
  await api.close()
})

describe('1. the delivery cost of an order is the entering member’s own, not the deliverer’s', () => {
  it('a Sales member (no costs switch) delivers the owner’s order and reads its delivery cost on the sale', async () => {
    const baker = await OrderScope.open(api, BAKER)
    const cake = await baker.service('150')
    // The Sales template: sees every order and every sale, enters and delivers orders; no costs.
    const seller = await api.member(baker, 'sales')
    const order = await baker.order({
      lines: [orderItem(cake.id, '1', '150'), orderDelivery('20')],
      deliveryNeeded: true,
      deliveryArea: 'Al Barsha',
      deliveryCost: '25',
    })
    // Control: on the order, the delivery cost is hidden from them (it is the owner's, and a cost).
    const seen = await baker.getOrder(order.id, seller)
    expect(seen.ownDeliveryCost).toBeNull()
    expect(seen.deliveryCost ?? null).toBeNull()

    const delivered = await baker.deliver(seen, undefined, seller)
    expect(delivered.status).toBe('delivered')
    expect(delivered.ownDeliveryCost).toBeNull()

    // The order's sale was "entered" by whoever delivered it: its cost comes back as their own.
    const sale = ok(
      await baker.as<{ data: SaleDto }>(seller, 'sale.get', { id: delivered.saleId }),
    ).data
    expect(sale.deliveryCost ?? null).toBeNull()
    expect(sale.ownDeliveryCost).toBeNull()
  })
})

describe('2. personal data: a member without customers.items.view gets back only what they typed', () => {
  it('a replayed customer.create returns the details the owner added since', async () => {
    const baker = await OrderScope.open(api, BAKER)
    const employee = await api.member(baker, 'employee')
    const create = { id: newId(), name: `Salem ${tag()}`, phone: '050 111 2222' }
    const added = ok(await baker.as<CustomerDto>(employee, 'customer.create', create))
    expect(added).toMatchObject({ phone: '050 111 2222', email: null, notes: null })
    // Control: they may not read customers.
    expect(codeOf(await baker.as(employee, 'customer.get', { id: create.id }))).toBe('forbidden')

    // The owner completes the customer's record.
    const current = ok(await baker.run<CustomerDto>('customer.get', { id: create.id }))
    ok(
      await baker.run<CustomerDto>('customer.update', {
        id: create.id,
        version: current.version,
        name: create.name,
        kind: 'individual',
        phone: '050 999 8888',
        email: 'salem.private@example.com',
        trn: '100123456700003',
        addressLine: 'Villa 12, Street 5',
        city: 'Sharjah',
        emirate: 'sharjah',
        country: 'AE',
        notes: 'Pays late; ID copy kept at the shop',
      }),
    )

    // The employee's client retries its create (same id, same payload).
    const replayed = await baker.as<CustomerDto>(employee, 'customer.create', create)
    const answer = JSON.stringify(replayed.data ?? null)
    for (const secret of [
      '050 999 8888',
      'salem.private@example.com',
      '100123456700003',
      'Villa 12',
      'Pays late',
    ]) {
      expect(answer, secret).not.toContain(secret)
    }
  })
})

describe('3. an order’s files stay within "Branches they work in" (Q12)', () => {
  let factory: OrderScope
  let product: ProductDto
  let branch: LocationDto
  let limited: Awaited<ReturnType<OrdersApi['member']>>
  let mainOrder: OrderDto

  beforeAll(async () => {
    factory = await OrderScope.open(api, { ...FACTORY, branches: true })
    product = await factory.service('100')
    branch = ok(
      await factory.run<LocationDto>('location.create', { id: newId(), name: `Musaffah ${tag()}` }),
    )
    // The Sales template sees every order and adds files to orders; limited to the new branch.
    limited = await api.member(factory, 'sales')
    const scope = ok(
      await factory.run<MemberLocationsDto>('member.locations', { memberId: limited.memberId }),
    )
    ok(
      await factory.run<MemberLocationsDto>('member.updateLocations', {
        memberId: limited.memberId,
        version: scope.version,
        locationIds: [branch.id],
      }),
    )
    // An order at the main location (the default), out of the limited member's branches.
    mainOrder = await factory.order({ lines: [orderItem(product.id, '1', '100')] })
  }, 120_000)

  it('the order itself is not theirs to see (control)', async () => {
    expect(codeOf(await factory.as(limited, 'order.get', { id: mainOrder.id }))).toBe('not_found')
  })

  it('attachment.list of another branch’s order is NOT_FOUND', async () => {
    const listed = await factory.as(limited, 'attachment.list', {
      entity: 'order',
      entityId: mainOrder.id,
    })
    expect(codeOf(listed)).toBe('not_found')
  })

  it('attachment.uploadUrl for another branch’s order is NOT_FOUND', async () => {
    const upload = await factory.as(limited, 'attachment.uploadUrl', {
      entity: 'order',
      entityId: mainOrder.id,
      contentType: 'image/png',
    })
    expect(codeOf(upload)).toBe('not_found')
  })

  it('attachment.add and .remove on another branch’s order are NOT_FOUND (D-273)', async () => {
    // The owner attaches the customer's LPO to the main location's order.
    const upload = ok(
      await factory.run<AttachmentUploadUrlDto>('attachment.uploadUrl', {
        entity: 'order',
        entityId: mainOrder.id,
        contentType: 'image/png',
      }),
    )
    expect((await uploadTo(upload.uploadUrl, PNG, 'image/png')).ok).toBe(true)
    // Attaching the owner's open upload to that order as the limited member: refused.
    expect(
      codeOf(
        await factory.as(limited, 'attachment.add', {
          entity: 'order',
          entityId: mainOrder.id,
          path: upload.path,
          fileName: 'lpo.png',
        }),
      ),
    ).toBe('not_found')
    const added = ok(
      await factory.run<{ data: AttachmentDto }>('attachment.add', {
        entity: 'order',
        entityId: mainOrder.id,
        path: upload.path,
        fileName: 'lpo.png',
      }),
    ).data
    // Taking it off as the limited member: refused, and it stays.
    expect(codeOf(await factory.as(limited, 'attachment.remove', { id: added.id }))).toBe(
      'not_found',
    )
    const listed = ok(
      await factory.run<{ data: { items: AttachmentDto[] } }>('attachment.list', {
        entity: 'order',
        entityId: mainOrder.id,
      }),
    ).data.items
    expect(listed.map((a) => a.id)).toEqual([added.id])
  })

  it('their own branch’s order keeps its files working (control)', async () => {
    const own = await factory.order(
      { lines: [orderItem(product.id, '1', '100')], locationId: branch.id },
      limited,
    )
    const listed = ok(
      await factory.as<{ data: { items: AttachmentDto[] } }>(limited, 'attachment.list', {
        entity: 'order',
        entityId: own.id,
      }),
    )
    expect(listed.data.items).toEqual([])
  })
})

describe('4. an order with payments is changed only by a member who sees them; cancelled by its own', () => {
  it('an Employee cancels their own order that carries the owner’s deposit, and still sees no payment', async () => {
    const baker = await OrderScope.open(api, BAKER)
    const cake = await baker.service('150')
    const employee = await api.member(baker, 'employee')
    const own = await baker.order({ lines: [orderItem(cake.id, '1', '150')] }, employee)
    // The owner records the customer's deposit on it; the employee cannot see payments.
    await baker.pay({ orderId: own.id }, '50')
    expect((await baker.getOrder(own.id, employee)).payment).toBeNull()
    // Control: changing it is refused for that reason.
    expect(
      codeOf(
        await baker.as(employee, 'order.update', {
          id: own.id,
          version: own.version,
          businessDate: own.businessDate,
          lines: [orderItem(cake.id, '1', '150')],
        }),
      ),
    ).toBe('forbidden')

    // Cancelling it is theirs to do (D-265), and the answer still hides what was paid.
    const cancelled = ok(
      await baker.as<{ data: OrderDto }>(employee, 'order.cancel', {
        id: own.id,
        version: own.version,
      }),
    ).data
    expect(cancelled).toMatchObject({ status: 'cancelled', payment: null })
    // The owner sees the deposit as money back to the customer.
    expect((await baker.getOrder(own.id)).payment).toMatchObject({
      state: 'overpaid',
      overpaid: '50',
      owed: '0',
    })
  })
})
