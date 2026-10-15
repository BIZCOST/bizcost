import { ORDER_STATUSES, PAYMENT_STATES, VAT_CATEGORIES } from '@bizcost/domain'
import { z } from 'zod'
import {
  ORDER_CANCEL_REASON_MAX_LENGTH,
  ORDER_CUSTOMER_REF_MAX_LENGTH,
  ORDER_PAGE_SIZE,
  ORDER_PAGE_SIZE_MAX,
} from '../customers'
import { withMeta } from '../envelope'
import { zBusinessDate, zDecimal, zUuid } from '../primitives'
import { PAYMENT_NOTE_MAX_LENGTH } from '../purchasing'
import { DELIVERY_AREA_MAX_LENGTH, SALE_LINES_MAX } from '../sales'
import { sensitive } from '../sensitivity'
import { standardUnitDto } from './catalog'
import {
  discountDto,
  discountInput,
  moneyInput,
  notesInput,
  positiveMoneyInput,
  settlementMethodDto,
} from './purchases'
import { profitPartsDto } from './reports'
import {
  documentPaymentStateDto,
  refundSummaryDto,
  saleLineInput,
  salesChannelKindDto,
} from './sales'
import { optionalLine } from './suppliers'

// Orders (ROADMAP.md M3 Step 5; docs/DATA_MODEL.md §6; the owner's answers Q16, Q17, Q19, Q20 of
// D-218): a customer's order with its items, discount, delivery and payments. Pending → Delivered (it
// counts as a sale on its delivery day, with the cost of what was sold frozen then) or Cancelled;
// "Undo delivery" reverses that sale and reopens it. Numbered #1001… when created (they may skip).
//
// Who sees what (Q10): `orders.documents.view` sees every order (it needs every sale seen, H1);
// without it a member who enters orders sees, changes and delivers only their own (entered by them and
// changed by nobody else since, D-214). What an order is paid and owes (`payment`) needs
// `payments.customers.view` with Payments on (null otherwise). The delivery cost is `cost` (the member
// who entered the order reads what they typed in `ownDeliveryCost`), and the order's profit is
// `profit_margin` and `cost` (with the costs switch; null otherwise).

const isoTimestamp = z.iso.datetime({ offset: true })

export const orderStatusDto = z.enum(ORDER_STATUSES)
export const paymentStateDto = z.enum(PAYMENT_STATES)

const uniqueIds = (items: readonly { id: string }[]) =>
  new Set(items.map((item) => item.id)).size === items.length

const orderFields = {
  /** The customer (a live one of the business); null: none named (a walk-in order). */
  customerId: zUuid.nullable().default(null),
  /** The customer's own reference: their LPO number. */
  customerRef: optionalLine(ORDER_CUSTOMER_REF_MAX_LENGTH),
  /** The day the order was taken (never after today: FUTURE_DATE). */
  businessDate: zBusinessDate,
  /** When it is due (on or after the order's day); null: not said. */
  dueDate: zBusinessDate.nullable().default(null),
  /** Where it is made or sold; null: the default location (another needs branches). */
  locationId: zUuid.nullable().default(null),
  /** How it came in (a live channel); null: the business's only active channel. */
  channelId: zUuid.nullable().default(null),
  /** A discount on the whole order: a % of its items, or an amount typed like their prices. */
  discount: discountInput.nullish().transform((value) => value ?? null),
  deliveryNeeded: z.boolean().default(false),
  deliveryArea: optionalLine(DELIVERY_AREA_MAX_LENGTH),
  /**
   * What the delivery actually cost the business (only with delivery), typed by the member who enters
   * the order. Left out, an update keeps it; changing another member's needs the costs switch.
   */
  deliveryCost: moneyInput.nullish(),
  notes: notesInput,
  /** Its items and the delivery charged, in order; a pending order may have none yet. */
  lines: z
    .array(saleLineInput)
    .max(SALE_LINES_MAX)
    .default([])
    .refine(uniqueIds, { message: 'duplicate line id' })
    .refine((lines) => lines.filter((l) => l.kind === 'delivery').length <= 1, {
      message: 'one delivery line at most',
    }),
}

interface OrderShape {
  businessDate: string
  dueDate: string | null
  deliveryNeeded: boolean
  deliveryArea: string | null
  deliveryCost?: string | null | undefined
  lines: readonly { kind: string }[]
}

const deliveryFits = (o: OrderShape) =>
  o.deliveryNeeded ||
  (o.deliveryArea === null &&
    (o.deliveryCost === undefined || o.deliveryCost === null) &&
    o.lines.every((line) => line.kind !== 'delivery'))
const deliveryMessage = { message: 'delivery area, cost and charge go with an order with delivery' }
const dueFits = (o: OrderShape) => o.dueDate === null || o.dueDate >= o.businessDate
const dueMessage = { message: 'due on or after the order’s day' }

/**
 * "Paid now / Deposit" with the order (Q17): one payment, its method required and never preselected
 * (D-159), dated the order's day, at most the order's total (EXCEEDS_OUTSTANDING). `id` is its client
 * UUIDv7.
 */
export const orderPaymentInput = z.object({
  id: zUuid,
  method: settlementMethodDto,
  amount: positiveMoneyInput,
  note: z
    .string()
    .trim()
    .max(PAYMENT_NOTE_MAX_LENGTH)
    .nullish()
    .transform((value) => (value ? value : null)),
})
export type OrderPaymentInput = z.input<typeof orderPaymentInput>

/**
 * `order.create` (orders.documents.manage): a pending order, idempotent on the client's `id` (a replay
 * is answered from the order before a number is taken). With `payment` (and payments.customers.record)
 * its deposit or payment is recorded in the same step.
 */
export const createOrderInput = z
  .object({ id: zUuid, ...orderFields, payment: orderPaymentInput.nullish() })
  .refine(deliveryFits, deliveryMessage)
  .refine(dueFits, dueMessage)
export type CreateOrderInput = z.input<typeof createOrderInput>

/**
 * `order.update` (a pending order only): the whole order, `version` as read. An order with payments
 * is changed only by a member who may see them, keeps its customer, and never comes to less than was
 * paid on it (BELOW_PAID).
 */
export const updateOrderInput = z
  .object({ id: zUuid, version: z.int().positive(), ...orderFields })
  .refine(deliveryFits, deliveryMessage)
  .refine(dueFits, dueMessage)
export type UpdateOrderInput = z.input<typeof updateOrderInput>

/** `order.get`, `order.undoDelivery`. */
export const orderIdInput = z.object({ id: zUuid })
export type OrderIdInput = z.input<typeof orderIdInput>

/** `order.cancel` (a pending order): nothing in the books changes. Idempotent. */
export const cancelOrderInput = z.object({
  id: zUuid,
  version: z.int().positive(),
  reason: optionalLine(ORDER_CANCEL_REASON_MAX_LENGTH),
})
export type CancelOrderInput = z.input<typeof cancelOrderInput>

/**
 * `order.deliver` (orders.documents.deliver): the order counts as a sale on `businessDate` (default
 * today; never after it, never on or before the books-closed date), with the cost of what was sold
 * frozen then. A repeated deliver returns the recorded result.
 */
export const deliverOrderInput = z.object({
  id: zUuid,
  version: z.int().positive(),
  businessDate: zBusinessDate.optional(),
})
export type DeliverOrderInput = z.input<typeof deliverOrderInput>

/**
 * `order.list`: pending orders first by when they are due (those without a due day last), then
 * delivered and cancelled ones, newest first. The search finds the order number, the customer's
 * reference (LPO) and the customer's name. Own orders only without orders.documents.view.
 */
export const orderListInput = z
  .object({
    status: z.enum(['all', ...ORDER_STATUSES]).default('all'),
    customerId: zUuid.optional(),
    search: z.string().trim().max(100).optional(),
    cursor: z.string().min(1).max(500).optional(),
    limit: z.int().min(1).max(ORDER_PAGE_SIZE_MAX).default(ORDER_PAGE_SIZE),
  })
  .prefault({})
export type OrderListInput = z.input<typeof orderListInput>

export const orderLineDto = z.object({
  id: zUuid,
  kind: z.enum(['item', 'delivery']),
  productId: zUuid.nullable(),
  /** The product's name when the line was saved (editable), or the delivery's text. */
  description: z.string().nullable(),
  qty: zDecimal,
  unit: standardUnitDto.nullable(),
  unitPrice: zDecimal,
  priceIncludesVat: z.boolean(),
  discount: discountDto.nullable(),
  vatCategory: z.enum(VAT_CATEGORIES).nullable(),
  vatRate: zDecimal.nullable(),
  subtotal: zDecimal,
  /** Its own discount as an amount. */
  lineDiscount: zDecimal,
  /** Before VAT, after every discount (its share of the order's discount too). */
  net: zDecimal,
  vat: zDecimal,
  total: zDecimal,
})
export type OrderLineDto = z.infer<typeof orderLineDto>

export const orderDto = z.object({
  id: zUuid,
  /** As printed ("#1001"). */
  number: z.string(),
  /** Its running number (1001). */
  seq: z.int().positive(),
  status: orderStatusDto,
  customerId: zUuid.nullable(),
  /** The customer's name as it is now, and their phone's last 4 digits. */
  customerName: z.string().nullable(),
  customerPhoneLast4: z.string().nullable(),
  customerRef: z.string().nullable(),
  businessDate: zBusinessDate,
  dueDate: zBusinessDate.nullable(),
  locationId: zUuid,
  locationName: z.string(),
  channelId: zUuid,
  channelName: z.string(),
  channelKind: salesChannelKindDto,
  /** The VAT registration it was last saved under (its sale freezes the one of its delivery day). */
  vatRegistered: z.boolean(),
  currency: z.string(),
  /** The discount on the whole order, as typed. */
  discount: discountDto.nullable(),
  subtotal: zDecimal,
  /** Its lines' discounts and the order's. */
  discountTotal: zDecimal,
  netTotal: zDecimal,
  vatTotal: zDecimal,
  total: zDecimal,
  deliveryNeeded: z.boolean(),
  deliveryArea: z.string().nullable(),
  /** What the delivery actually cost the business; null: not entered. */
  deliveryCost: sensitive(zDecimal.nullable(), 'cost'),
  /** The delivery cost of an order the caller entered themselves (D-181); null otherwise. */
  ownDeliveryCost: zDecimal.nullable(),
  notes: z.string().nullable(),
  lines: z.array(orderLineDto),
  /** Delivered: the day it counts as a sale on, and its sale. */
  deliveredOn: zBusinessDate.nullable(),
  saleId: zUuid.nullable(),
  deliveredAt: isoTimestamp.nullable(),
  cancelledAt: isoTimestamp.nullable(),
  cancelReason: z.string().nullable(),
  /** What it is paid and owes; null without payments.customers.view (or Payments off). */
  payment: documentPaymentStateDto.nullable(),
  /** The refunds of its sale, newest first (empty while pending). */
  refunds: z.array(refundSummaryDto),
  /**
   * Delivered: its real profit (its sale and refunds, D-223), for a member with the costs switch;
   * null otherwise or while pending.
   */
  profit: profitPartsDto.nullable(),
  /** Who entered it (their name in the business now); null without a team. */
  enteredByName: z.string().nullable(),
  /** The caller entered it. */
  mine: z.boolean(),
  createdAt: isoTimestamp,
  version: z.int().positive(),
})
export type OrderDto = z.infer<typeof orderDto>

/** One order as withMeta() (its delivery cost and profit may be removed). */
export const orderResultDto = withMeta(orderDto)
export type OrderResultDto = z.infer<typeof orderResultDto>

export const orderListItemDto = z.object({
  id: zUuid,
  number: z.string(),
  status: orderStatusDto,
  customerId: zUuid.nullable(),
  customerName: z.string().nullable(),
  customerRef: z.string().nullable(),
  businessDate: zBusinessDate,
  dueDate: zBusinessDate.nullable(),
  deliveredOn: zBusinessDate.nullable(),
  currency: z.string(),
  total: zDecimal,
  /** How many items, and the names of the first two. */
  lineCount: z.int().nonnegative(),
  itemNames: z.array(z.string()),
  /** Paid / Deposit paid / Not paid (and what is owed); null without payments.customers.view. */
  paymentState: paymentStateDto.nullable(),
  owed: zDecimal.nullable(),
  enteredByName: z.string().nullable(),
  mine: z.boolean(),
  version: z.int().positive(),
})
export type OrderListItemDto = z.infer<typeof orderListItemDto>

export const orderListDto = z.object({
  items: z.array(orderListItemDto),
  nextCursor: z.string().nullable(),
})
export type OrderListDto = z.infer<typeof orderListDto>
