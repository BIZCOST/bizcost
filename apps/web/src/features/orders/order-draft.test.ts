import type { OrderDto, ProductDto } from '@bizcost/contracts'
import { describe, expect, it } from 'vitest'
import { checkOrder, orderDraft, type OrderDraft, type OrderFormContext } from './order-draft'

// An order as typed (M3 Step 5; Q16, Q17, D-265): the baker's #1001 (a cake at 150, delivery charged
// 20, a deposit of 50 by bank transfer) and the workshop's (VAT, a discount on the whole order, the
// customer's LPO). The running amounts are the domain's sale maths (D-220).

const CAKE = '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f31'
const WARDROBE = '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f32'
const FATIMA = '0190a4f2-7b5c-7c3e-9b1a-2f3c4d5e6f33'
const TODAY = '2026-10-08'

function product(id: string, name: string, price: string) {
  return {
    id,
    name,
    description: null,
    type: 'product',
    unit: 'piece',
    defaultPrice: price,
    vatCategory: 'standard',
    priceIncludesVat: false,
    locationIds: [],
    resaleMaterialId: null,
    archivedAt: null,
    version: 1,
  } as unknown as ProductDto
}

const PRODUCTS = new Map([
  [CAKE, product(CAKE, 'Chocolate cake', '150')],
  [WARDROBE, product(WARDROBE, 'Wardrobe', '4000')],
])

function context(extra: Partial<OrderFormContext> = {}): OrderFormContext {
  return {
    currency: 'AED',
    vatRegistered: false,
    today: TODAY,
    products: PRODUCTS,
    deliveryCostShown: true,
    storedDeliveryCost: '',
    paymentAsked: true,
    ...extra,
  }
}

function bakerOrder(): OrderDraft {
  const draft = orderDraft(undefined, { today: TODAY, locationId: null })
  return {
    ...draft,
    customer: {
      id: FATIMA,
      name: 'Fatima',
      kind: 'individual',
      phone: null,
      phoneLast4: '4567',
      archived: false,
    },
    dueDate: '2026-10-10',
    lines: [{ ...draft.lines[0]!, id: 'l1', productId: CAKE, price: '150' }],
    deliveryNeeded: true,
    deliveryArea: 'Al Barsha',
    deliveryCharged: '20',
    deliveryCost: '25',
    notes: 'Happy birthday Sara',
    paidNow: 'deposit',
    paidAmount: '50',
    paidMethod: 'bank_transfer',
  }
}

describe('An order', () => {
  it("adds up the baker's #1001: a cake at 150 + delivery 20 = 170, a deposit of 50", () => {
    const draft = bakerOrder()
    const check = checkOrder(draft, context())
    expect(check.amounts).toMatchObject({ net: '170.00', vat: '0.00', total: '170.00' })
    expect(check.payment).toEqual({ method: 'bank_transfer', amount: '50' })
    expect(check.fields).toMatchObject({
      customerId: FATIMA,
      customerRef: null,
      businessDate: TODAY,
      dueDate: '2026-10-10',
      discount: null,
      deliveryNeeded: true,
      deliveryArea: 'Al Barsha',
      deliveryCost: '25',
      notes: 'Happy birthday Sara',
    })
    expect(check.fields?.lines).toEqual([
      {
        kind: 'item',
        id: 'l1',
        productId: CAKE,
        description: undefined,
        qty: '1',
        unitPrice: '150',
        discount: null,
      },
      { kind: 'delivery', id: draft.deliveryLineId, amount: '20', amountIncludesVat: false },
    ])
    expect(check.fields).not.toHaveProperty('periodFrom')
    expect(check.fields).not.toHaveProperty('payLater')
  })

  it('pays all of it now, or asks how it was paid (never picked) and never more than the total', () => {
    const all = checkOrder({ ...bakerOrder(), paidNow: 'all', paidAmount: '' }, context())
    expect(all.payment).toEqual({ method: 'bank_transfer', amount: '170.00' })
    const noMethod = checkOrder({ ...bakerOrder(), paidMethod: '' }, context())
    expect(noMethod.errors.paidMethod?.key).toBe('orders.editor.errors.paidMethod')
    expect(noMethod.fields).toBeNull()
    const over = checkOrder({ ...bakerOrder(), paidAmount: '170.01' }, context())
    expect(over.errors.paidAmount?.key).toBe('orders.editor.errors.depositOverTotal')
    const nothing = checkOrder({ ...bakerOrder(), paidNow: 'none', paidMethod: '' }, context())
    expect(nothing.payment).toBeNull()
    expect(nothing.fields).not.toBeNull()
    // An order already saved is paid from its page: nothing is asked here.
    const saved = checkOrder({ ...bakerOrder(), paidMethod: '' }, context({ paymentAsked: false }))
    expect(saved.payment).toBeNull()
    expect(saved.fields).not.toBeNull()
  })

  it('is due on or after the day it was taken', () => {
    const early = checkOrder({ ...bakerOrder(), dueDate: '2026-10-07' }, context())
    expect(early.errors.dueDate?.key).toBe('orders.editor.errors.dueBefore')
    expect(early.fields).toBeNull()
    const none = checkOrder({ ...bakerOrder(), dueDate: '' }, context())
    expect(none.fields?.dueDate).toBeNull()
  })

  it("takes a discount on the whole order off the items before VAT (the workshop's LPO)", () => {
    const draft: OrderDraft = {
      ...bakerOrder(),
      customerRef: ' LPO-7781 ',
      lines: [{ ...bakerOrder().lines[0]!, productId: WARDROBE, qty: '2', price: '4000' }],
      deliveryNeeded: false,
      discountKind: 'percent',
      discount: '10',
      paidNow: 'none',
    }
    const check = checkOrder(draft, context({ vatRegistered: true }))
    // 8,000 − 10% = 7,200 + 5% VAT 360 = 7,560.
    expect(check.amounts).toMatchObject({ net: '7200.00', vat: '360.00', total: '7560.00' })
    expect(check.fields).toMatchObject({ customerRef: 'LPO-7781', discount: { percent: '10' } })
    const over = checkOrder({ ...draft, discountKind: 'amount', discount: '8000.01' }, context())
    expect(over.errors.discount?.key).toBe('orders.editor.errors.discountOverItems')
    expect(over.fields).toBeNull()
    // The amounts stay shown without the discount until it is fixed.
    expect(over.amounts?.net).toBe('8000.00')
  })

  it('opens a pending order as it is stored', () => {
    const stored = {
      businessDate: '2026-10-07',
      dueDate: '2026-10-09',
      channelId: 'c1',
      locationId: 'loc1',
      customerId: FATIMA,
      customerName: 'Fatima',
      customerPhoneLast4: '4567',
      customerRef: 'LPO-1',
      discount: { amount: '10' },
      deliveryNeeded: true,
      deliveryArea: 'Mirdif',
      deliveryCost: undefined,
      ownDeliveryCost: '15',
      notes: null,
      lines: [
        {
          id: 'l1',
          kind: 'item',
          productId: CAKE,
          description: 'Chocolate cake',
          qty: '1',
          unitPrice: '150',
          discount: null,
          priceIncludesVat: false,
        },
        { id: 'd1', kind: 'delivery', productId: null, unitPrice: '20', priceIncludesVat: false },
      ],
    } as unknown as OrderDto
    const draft = orderDraft(stored, { today: TODAY, locationId: null })
    expect(draft).toMatchObject({
      businessDate: '2026-10-07',
      dueDate: '2026-10-09',
      customerRef: 'LPO-1',
      discountKind: 'amount',
      discount: '10',
      deliveryLineId: 'd1',
      deliveryCharged: '20',
      deliveryCost: '15',
      customer: { id: FATIMA, name: 'Fatima', phoneLast4: '4567' },
      paidNow: 'none',
    })
    expect(draft.lines).toHaveLength(1)
  })
})
