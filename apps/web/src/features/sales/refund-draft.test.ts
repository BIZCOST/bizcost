import type { SaleLineDto } from '@bizcost/contracts'
import { compareDecimal } from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import { checkRefund, refundableLines, type RefundDraft } from './refund-draft'

// A refund as typed (M3 Step 5; D-266): what it gives back is worked out as sale.refund works it out
// (the domain's credit maths), and the money given back with it is never more than was then paid
// beyond what the order comes to.

const TODAY = '2026-10-16'

function line(fields: Partial<SaleLineDto> & { id: string }): SaleLineDto {
  return {
    kind: 'item',
    productId: 'p',
    description: 'Item',
    qty: '1',
    unit: 'piece',
    unitPrice: '0',
    priceIncludesVat: false,
    discount: null,
    vatCategory: null,
    vatRate: null,
    subtotal: '0',
    lineDiscount: '0',
    net: '0',
    vat: '0',
    total: '0',
    refundOfLineId: null,
    left: null,
    ...fields,
  } as unknown as SaleLineDto
}

/** The baker's #1001: the cake at 150 and delivery charged 20, no VAT. */
const BAKER = [
  line({
    id: 'cake',
    description: 'Chocolate cake',
    qty: '1',
    unitPrice: '150',
    net: '150',
    total: '150',
    left: { qty: '1', net: '150', vat: '0', total: '150', typed: '150' },
  }),
  line({
    id: 'delivery',
    kind: 'delivery',
    productId: null,
    qty: '1',
    unitPrice: '20',
    net: '20',
    total: '20',
    left: { qty: '1', net: '20', vat: '0', total: '20', typed: '20' },
  }),
]

const PAID_IN_FULL = {
  state: 'paid' as const,
  total: '170',
  credited: '0',
  paid: '170',
  refunded: '0',
  owed: '0',
  overpaid: '0',
}

function draft(extra: Partial<RefundDraft> = {}): RefundDraft {
  return {
    by: 'amount',
    businessDate: TODAY,
    values: {},
    notes: '',
    giveBack: true,
    method: '',
    amount: '',
    ...extra,
  }
}

const baker = {
  lines: BAKER,
  currency: 'AED' as const,
  vatRegistered: false,
  saleDate: '2026-10-14',
  today: TODAY,
  closedThrough: null,
  owed: PAID_IN_FULL,
  canGiveBack: true,
}

const same = (a: string | undefined, b: string) => a !== undefined && compareDecimal(a, b) === 0

describe('A refund', () => {
  it('takes 20 off the cake by amount, and gives the 20 back on an order paid in full', () => {
    const check = checkRefund(
      draft({ values: { cake: '20' }, method: 'cash', amount: '20' }),
      baker,
    )
    expect(same(check.amounts?.total, '20')).toBe(true)
    expect(same(check.canGiveBack, '20')).toBe(true)
    expect(same(check.owedAfter ?? undefined, '0')).toBe(true)
    expect(check.lines).toEqual([{ lineId: 'cake', amount: '20' }])
    expect(check.payment).toEqual({ method: 'cash', amount: '20' })
  })

  it('never takes more than is left, nor gives back more than was paid beyond', () => {
    const over = checkRefund(draft({ values: { cake: '150.01' } }), baker)
    expect(over.errors.lines.cake?.key).toBe('orders.refund.errors.exceedsLeft')
    expect(over.lines).toBeNull()
    const tooMuchBack = checkRefund(
      draft({ values: { cake: '20' }, method: 'cash', amount: '20.01' }),
      baker,
    )
    expect(tooMuchBack.errors.amount?.key).toBe('orders.payment.overMoneyBack')
    const noMethod = checkRefund(draft({ values: { cake: '20' }, amount: '20' }), baker)
    expect(noMethod.errors.method?.key).toBe('orders.payment.methodRequired')
    // With only the deposit paid, the refund lowers what is owed: nothing to give back.
    const deposit = checkRefund(draft({ values: { cake: '20' } }), {
      ...baker,
      owed: { ...PAID_IN_FULL, state: 'deposit', paid: '50', owed: '120' },
    })
    expect(deposit.canGiveBack).toBe('0')
    expect(same(deposit.owedAfter ?? undefined, '100')).toBe(true)
    expect(deposit.lines).toEqual([{ lineId: 'cake', amount: '20' }])
    expect(deposit.payment).toBeNull()
  })

  it('takes back by quantity with VAT worked out as the server does, and all that is left exactly', () => {
    const cups = [
      line({
        id: 'cups',
        qty: '3',
        unitPrice: '10',
        vatCategory: 'standard',
        vatRate: '5',
        net: '30',
        vat: '1.5',
        total: '31.5',
        left: { qty: '3', net: '30', vat: '1.5', total: '31.5', typed: '30' },
      }),
    ]
    const context = { ...baker, lines: cups, vatRegistered: true, owed: null }
    const one = checkRefund(draft({ by: 'quantity', values: { cups: '1' } }), context)
    expect(same(one.amounts?.net, '10')).toBe(true)
    expect(same(one.amounts?.vat, '0.5')).toBe(true)
    expect(same(one.amounts?.total, '10.5')).toBe(true)
    const all = checkRefund(draft({ by: 'quantity', values: { cups: '3' } }), context)
    expect(same(all.amounts?.total, '31.5')).toBe(true)
    expect(all.lines).toEqual([{ lineId: 'cups', qty: '3' }])
    const more = checkRefund(draft({ by: 'quantity', values: { cups: '4' } }), context)
    expect(more.errors.lines.cups?.key).toBe('orders.refund.errors.exceedsLeft')
  })

  it('asks for something to take back, on a day from the sale to today', () => {
    const nothing = checkRefund(draft(), baker)
    expect(nothing.errors.nothing?.key).toBe('orders.refund.errors.nothing')
    expect(nothing.lines).toBeNull()
    const early = checkRefund(draft({ values: { cake: '20' }, businessDate: '2026-10-13' }), baker)
    expect(early.errors.businessDate?.key).toBe('orders.refund.errors.beforeSale')
    const closed = checkRefund(draft({ values: { cake: '20' } }), {
      ...baker,
      closedThrough: TODAY,
    })
    expect(closed.errors.businessDate?.key).toBe('orders.refund.errors.booksClosed')
  })

  it('lists the lines with something left: by quantity, by amount', () => {
    const taken = [
      ...BAKER,
      line({
        id: 'gone',
        qty: '1',
        unitPrice: '5',
        net: '5',
        total: '5',
        left: { qty: '0', net: '2', vat: '0', total: '2', typed: '2' },
      }),
    ]
    expect(refundableLines(taken, 'quantity').map((l) => l.id)).toEqual(['cake', 'delivery'])
    expect(refundableLines(taken, 'amount').map((l) => l.id)).toEqual(['cake', 'delivery', 'gone'])
  })
})
