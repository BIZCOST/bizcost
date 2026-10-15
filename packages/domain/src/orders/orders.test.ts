import { describe, expect, it } from 'vitest'
import {
  DOCUMENT_COUNTER_DEFAULTS,
  documentNumber,
  ORDER_ACTIONS,
  ORDER_STATUSES,
  orderActions,
  orderTransition,
  type OrderAction,
  type OrderStatus,
} from './orders'

// An order's steps (M3 Step 5; the owner's answer Q16 = A): Pending → Delivered or Cancelled, and
// Undo delivery; every action in every status, and the numbers orders are printed with.

describe('orderTransition', () => {
  const table: Record<OrderStatus, Record<OrderAction, string>> = {
    pending: {
      update: 'pending',
      cancel: 'cancelled',
      deliver: 'delivered',
      undo_delivery: 'pending (no change)',
    },
    delivered: {
      update: 'document_posted',
      cancel: 'document_posted',
      deliver: 'delivered (no change)',
      undo_delivery: 'pending',
    },
    cancelled: {
      update: 'order_cancelled',
      cancel: 'cancelled (no change)',
      deliver: 'order_cancelled',
      undo_delivery: 'order_cancelled',
    },
  }

  it.each(ORDER_STATUSES)('in %s, every action goes where Q16 says', (status) => {
    for (const action of ORDER_ACTIONS) {
      const result = orderTransition(action, { status })
      const said = result.ok
        ? `${result.to}${result.changes ? '' : ' (no change)'}`
        : result.refusal
      expect(said, `${status} ${action}`).toBe(table[status][action])
    }
  })

  it('offers only what changes the order', () => {
    expect(orderActions({ status: 'pending' })).toEqual(['update', 'cancel', 'deliver'])
    expect(orderActions({ status: 'delivered' })).toEqual(['undo_delivery'])
    expect(orderActions({ status: 'cancelled' })).toEqual([])
  })

  it('deliver → undo → deliver again: back to pending, then delivered again', () => {
    let status: OrderStatus = 'pending'
    for (const action of ['deliver', 'undo_delivery', 'deliver'] as const) {
      const result = orderTransition(action, { status })
      expect(result.ok && result.changes).toBe(true)
      if (result.ok) status = result.to
    }
    expect(status).toBe('delivered')
  })
})

describe('documentNumber', () => {
  it('prints the order number #1001 and padded series', () => {
    const order = DOCUMENT_COUNTER_DEFAULTS.order
    expect(documentNumber(order.prefix, order.first, order.padding)).toBe('#1001')
    expect(documentNumber('INV-', 1, 4)).toBe('INV-0001')
    expect(documentNumber('INV-', 12345, 4)).toBe('INV-12345')
    expect(documentNumber('', 7, 0)).toBe('7')
  })

  it('refuses what is not a number or a padding', () => {
    expect(() => documentNumber('#', 0, 0)).toThrow(RangeError)
    expect(() => documentNumber('#', 1.5, 0)).toThrow(RangeError)
    expect(() => documentNumber('#', 1, -1)).toThrow(RangeError)
    expect(() => documentNumber('#', 1, 13)).toThrow(RangeError)
  })
})
