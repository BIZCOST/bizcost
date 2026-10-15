// Orders (M3 Step 5; the owner's answer Q16 = A of D-218): a customer's order goes Pending → Delivered
// (it counts as a sale from its delivery day) or Cancelled; "Undo delivery" puts a delivered order back
// to Pending (its sale is reversed), so it may be delivered again. Payment is shown apart (paymentState,
// payments/state.ts). The API applies orderTransition under the order's row lock; the web asks
// orderActions which actions to offer.
//
//   pending ──deliver──► delivered ──undo_delivery──► pending
//      │  ▲                  │
//      │  └── update          └── refunds by quantity or amount (sale.refund), never edited
//      └──cancel──► cancelled (nothing in the books changes; a deposit is money back to the customer)
//
// Delivering, cancelling and undoing again are no-ops (idempotent: a repeated deliver returns the
// recorded result). A delivered order is never edited (DOCUMENT_POSTED): its delivery is undone first.
// A cancelled order is closed for good (ORDER_CANCELLED).

/** `orders.status`. */
export const ORDER_STATUSES = ['pending', 'delivered', 'cancelled'] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

export const ORDER_ACTIONS = ['update', 'cancel', 'deliver', 'undo_delivery'] as const
export type OrderAction = (typeof ORDER_ACTIONS)[number]

/** Why an action is refused; each is an API error code of the same name. */
export type OrderRefusal = 'document_posted' | 'order_cancelled'

export interface OrderActionContext {
  readonly status: OrderStatus
}

export type OrderTransition =
  | {
      readonly ok: true
      /** The status after the action. */
      readonly to: OrderStatus
      /** False when the order already is where the action leads (nothing to write). */
      readonly changes: boolean
    }
  | { readonly ok: false; readonly refusal: OrderRefusal }

const to = (status: OrderStatus, changes = true): OrderTransition => ({
  ok: true,
  to: status,
  changes,
})
const refuse = (refusal: OrderRefusal): OrderTransition => ({ ok: false, refusal })

/** Where `action` takes an order in `ctx`, or why it is refused. */
export function orderTransition(action: OrderAction, ctx: OrderActionContext): OrderTransition {
  const { status } = ctx
  switch (action) {
    case 'update':
      if (status === 'cancelled') return refuse('order_cancelled')
      if (status === 'delivered') return refuse('document_posted')
      return to('pending')
    case 'cancel':
      if (status === 'cancelled') return to('cancelled', false)
      if (status === 'delivered') return refuse('document_posted')
      return to('cancelled')
    case 'deliver':
      if (status === 'cancelled') return refuse('order_cancelled')
      if (status === 'delivered') return to('delivered', false)
      return to('delivered')
    case 'undo_delivery':
      if (status === 'cancelled') return refuse('order_cancelled')
      if (status === 'pending') return to('pending', false)
      return to('pending')
  }
}

/** The actions that would change the order in `ctx` (what the web offers; keys are the caller's). */
export function orderActions(ctx: OrderActionContext): OrderAction[] {
  return ORDER_ACTIONS.filter((action) => {
    const transition = orderTransition(action, ctx)
    return transition.ok && transition.changes
  })
}

// ---------------------------------------------------------------------------------------------------
// Document numbers (the plan's numbering design; Q25: orders #1001…, which may skip)
// ---------------------------------------------------------------------------------------------------

/**
 * `document_counters.series`: what a running number counts. M3 Step 5: orders. Quotations, invoices
 * and credit notes come with their steps (7 and 8), on the same design.
 */
export const DOCUMENT_SERIES = ['order'] as const
export type DocumentSeries = (typeof DOCUMENT_SERIES)[number]

/** A series' first number, prefix and zero padding, until the business changes them (Step 8). */
export const DOCUMENT_COUNTER_DEFAULTS: Readonly<
  Record<
    DocumentSeries,
    { readonly first: number; readonly prefix: string; readonly padding: number }
  >
> = {
  order: { first: 1001, prefix: '#', padding: 0 },
}

/** The most digits a number is padded to. */
export const DOCUMENT_NUMBER_PADDING_MAX = 12

/**
 * A document's number as printed: its prefix, then its integer padded with zeros to `padding` digits
 * ("#1001", "INV-0001"). The integer is stored apart (UNIQUE per business and series), so editing a
 * prefix later never renumbers anything.
 */
export function documentNumber(prefix: string, seq: number, padding: number): string {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new RangeError(`Not a document number: ${seq}`)
  if (!Number.isInteger(padding) || padding < 0 || padding > DOCUMENT_NUMBER_PADDING_MAX) {
    throw new RangeError(`Not a padding: ${padding}`)
  }
  return `${prefix}${String(seq).padStart(padding, '0')}`
}
