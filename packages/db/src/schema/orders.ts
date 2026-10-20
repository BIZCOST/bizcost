import {
  ORDER_STATUSES,
  PAYMENT_KINDS,
  SETTLEMENT_METHODS,
  STANDARD_UNITS,
  VAT_CATEGORIES,
  type OrderStatus,
  type PaymentKind,
  type SettlementMethod,
  type StandardUnit,
  type VatCategory,
} from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import {
  boolean,
  char,
  check,
  date,
  index,
  integer,
  numeric,
  text,
  unique,
  uuid,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core'
import { timestamptz } from './_app'
import { tenantRef, tenantTable } from './_helpers'
import { productsServices } from './catalog'
import { customers } from './customers'
import { locations } from './locations'
import { invoices } from './invoices'
import { sales, salesChannels } from './sales'

const quoted = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))
const STANDARD_UNIT_LIST = quoted(Object.keys(STANDARD_UNITS))

const money = (name: string) => numeric(name, { precision: 20, scale: 4 })
const percent = (name: string) => numeric(name, { precision: 9, scale: 6 })
const quantity = (name: string) => numeric(name, { precision: 24, scale: 6 })

// Orders (M3 Step 5; docs/DATA_MODEL.md §6; the owner's answers Q16, Q17, Q19, Q20 of D-218). An order
// goes pending → delivered (it posts its sale on the delivery day: `sale_id`, `delivered_on`) or
// cancelled; undoing a delivery reverses that sale and puts it back to pending (a new delivery posts a
// new sale: sales.order_id is unique among live sales). Its amounts are computeSale's, kept on every
// save; the sale its delivery posts keeps them (each line's stored VAT basis), worked out again only
// when the VAT registration changed since (D-273). A
// delivered order is never edited and a cancelled one never changes again (database triggers). Order
// numbers: document_counters (`order`), its integer unique per business (`orders_seq_key`; the table
// is the series), may skip.
export const orders = tenantTable(
  'orders',
  {
    seq: integer('seq').notNull(),
    // As printed when it was created ("#1001").
    number: text('number').notNull(),
    customerId: uuid('customer_id'),
    // The customer's own reference: their LPO number.
    customerRef: text('customer_ref'),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    dueDate: date('due_date', { mode: 'string' }),
    locationId: uuid('location_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    status: text('status').$type<OrderStatus>().notNull().default('pending'),
    // businesses.vat_registered when it was last saved.
    vatRegistered: boolean('vat_registered').notNull().default(false),
    currency: char('currency', { length: 3 }).notNull(),
    // The discount on the whole order, as typed (a % or an amount; computeSale splits it).
    discountPercent: percent('discount_percent'),
    discountAmount: money('discount_amount'),
    // "Round the total" (D-221; M3 Step 7, carried from the quotation it was made from): the total with
    // VAT wanted, the adjustment before VAT it came to and the fils no VAT rate could reach. What the
    // customer owes is total + rounding difference.
    roundTo: money('round_to'),
    adjustment: money('adjustment').notNull().default('0'),
    roundingDifference: money('rounding_difference').notNull().default('0'),
    subtotal: money('subtotal').notNull().default('0'),
    discountTotal: money('discount_total').notNull().default('0'),
    netTotal: money('net_total').notNull().default('0'),
    vatTotal: money('vat_total').notNull().default('0'),
    total: money('total').notNull().default('0'),
    deliveryNeeded: boolean('delivery_needed').notNull().default(false),
    deliveryArea: text('delivery_area'),
    // What the delivery actually cost the business (`cost`), copied to its sale when delivered; one
    // filled on the sale since comes back with an undone delivery (D-273).
    deliveryCost: money('delivery_cost'),
    notes: text('notes'),
    // Delivered: the day its sale counts on, and the sale.
    deliveredOn: date('delivered_on', { mode: 'string' }),
    saleId: uuid('sale_id'),
    deliveredAt: timestamptz('delivered_at'),
    deliveredBy: uuid('delivered_by'),
    cancelledAt: timestamptz('cancelled_at'),
    cancelledBy: uuid('cancelled_by'),
    cancelReason: text('cancel_reason'),
  },
  (t): PgTableExtraConfigValue[] => [
    tenantRef('orders_customer_fk', [t.businessId, t.customerId], customers),
    tenantRef('orders_location_fk', [t.businessId, t.locationId], locations),
    tenantRef('orders_channel_fk', [t.businessId, t.channelId], salesChannels),
    tenantRef('orders_sale_fk', [t.businessId, t.saleId], sales),
    // UNIQUE (business, series, seq): the table is the series `order`.
    unique('orders_seq_key').on(t.businessId, t.seq),
    // Lists: pending first by due day, then the rest; a customer's; a member's own.
    index('orders_status_idx').on(t.businessId, t.status, t.dueDate),
    index('orders_customer_idx').on(t.businessId, t.customerId),
    index('orders_created_by_idx').on(t.businessId, t.createdBy),
    index('orders_location_idx').on(t.businessId, t.locationId),
    index('orders_channel_idx').on(t.businessId, t.channelId),
    index('orders_sale_idx').on(t.businessId, t.saleId),
    check('orders_status_check', sql`status in (${quoted(ORDER_STATUSES)})`),
    check('orders_seq_check', sql`seq >= 1`),
    check('orders_number_check', sql`btrim(number) <> '' and char_length(number) <= 40`),
    check(
      'orders_customer_ref_check',
      sql`btrim(customer_ref) <> '' and char_length(customer_ref) <= 100`,
    ),
    check('orders_currency_check', sql`currency ~ '^[A-Z]{3}$'`),
    check('orders_due_date_check', sql`due_date >= business_date`),
    check(
      'orders_discount_check',
      sql`num_nonnulls(discount_percent, discount_amount) <= 1
        and discount_percent between 0 and 100 and discount_amount >= 0`,
    ),
    check(
      'orders_round_check',
      sql`round_to >= 0 and (round_to is not null or (adjustment = 0 and rounding_difference = 0))`,
    ),
    check(
      'orders_delivery_check',
      sql`delivery_needed or (delivery_area is null and delivery_cost is null)`,
    ),
    check('orders_delivery_cost_check', sql`delivery_cost >= 0`),
    check(
      'orders_delivery_area_check',
      sql`btrim(delivery_area) <> '' and char_length(delivery_area) <= 200`,
    ),
    check('orders_notes_check', sql`char_length(notes) <= 1000`),
    check(
      'orders_delivered_check',
      sql`(status = 'delivered') = (delivered_on is not null)
        and (status = 'delivered') = (sale_id is not null)
        and (status = 'delivered') = (delivered_at is not null)
        and (status = 'delivered') = (delivered_by is not null)`,
    ),
    check('orders_delivered_on_check', sql`delivered_on >= business_date`),
    check(
      'orders_cancelled_check',
      sql`(status = 'cancelled') = (cancelled_at is not null)
        and (status = 'cancelled') = (cancelled_by is not null)
        and (cancel_reason is null or status = 'cancelled')`,
    ),
    check(
      'orders_cancel_reason_check',
      sql`btrim(cancel_reason) <> '' and char_length(cancel_reason) <= 500`,
    ),
  ],
)

/**
 * A line of an order, shaped as a sale line without its cost (the cost of what was sold is frozen on
 * the sale its delivery posts): an `item` (a product or service, its name copied and editable, D-002)
 * or the `delivery` charged to the customer. The amounts are computeSale's, with the order's discount.
 */
export const orderLines = tenantTable(
  'order_lines',
  {
    orderId: uuid('order_id').notNull(),
    position: integer('position').notNull(),
    kind: text('kind').$type<'item' | 'delivery'>().notNull(),
    productId: uuid('product_id'),
    description: text('description'),
    qty: quantity('qty').notNull(),
    unit: text('unit').$type<StandardUnit>(),
    unitPrice: money('unit_price').notNull(),
    priceIncludesVat: boolean('price_includes_vat').notNull().default(false),
    discountPercent: percent('discount_percent'),
    discountAmount: money('discount_amount'),
    vatCategory: text('vat_category').$type<VatCategory>(),
    vatRate: percent('vat_rate'),
    subtotal: money('subtotal').notNull().default('0'),
    discount: money('discount').notNull().default('0'),
    net: money('net').notNull().default('0'),
    vat: money('vat').notNull().default('0'),
    total: money('total').notNull().default('0'),
  },
  (t) => [
    tenantRef('order_lines_order_fk', [t.businessId, t.orderId], orders),
    tenantRef('order_lines_product_fk', [t.businessId, t.productId], productsServices),
    index('order_lines_order_idx').on(t.businessId, t.orderId),
    index('order_lines_product_idx').on(t.businessId, t.productId),
    check('order_lines_kind_check', sql`kind in ('item', 'delivery')`),
    // An item is a product or service, or typed (M3 Step 7, Q21: from a quotation; it names itself).
    check(
      'order_lines_product_check',
      sql`(kind = 'item' or product_id is null)
        and (product_id is not null or kind <> 'item' or description is not null)`,
    ),
    check(
      'order_lines_delivery_check',
      sql`kind <> 'delivery' or (qty = 1 and unit is null
        and discount_percent is null and discount_amount is null)`,
    ),
    check('order_lines_unit_check', sql`unit in (${STANDARD_UNIT_LIST})`),
    check('order_lines_position_check', sql`position >= 0`),
    check('order_lines_qty_check', sql`qty > 0`),
    check('order_lines_unit_price_check', sql`unit_price >= 0`),
    check(
      'order_lines_discount_check',
      sql`num_nonnulls(discount_percent, discount_amount) <= 1
        and discount_percent between 0 and 100 and discount_amount >= 0`,
    ),
    check('order_lines_vat_category_check', sql`vat_category in (${quoted(VAT_CATEGORIES)})`),
    check('order_lines_vat_rate_check', sql`vat_rate between 0 and 100`),
    check('order_lines_vat_check', sql`(vat_category is null) = (vat_rate is null)`),
    check(
      'order_lines_description_check',
      sql`btrim(description) <> '' and char_length(description) <= 200`,
    ),
  ],
)

/**
 * A customer's payment (M3 Step 5; the owner's answer Q17 = A, as supplier payments: D-159, D-160):
 * on exactly one order, one sale "they'll pay later" or one issued invoice (M3 Step 8), a payment towards what
 * it owes (`payment`: deposits and part payments too) or money given back (`refund`). The method is
 * required; never more than is owed (or, given back, than was paid beyond it). Append-only: a payment
 * recorded by mistake is reversed (its reversal columns), dated its own day or the first open day,
 * never edited or deleted; the books-closed date holds (D-205). `customer_id`: the document's customer
 * when it was recorded (an order with payments keeps its customer).
 */
export const customerPayments = tenantTable(
  'customer_payments',
  {
    customerId: uuid('customer_id'),
    orderId: uuid('order_id'),
    saleId: uuid('sale_id'),
    // M3 Step 8: a payment on an issued invoice.
    invoiceId: uuid('invoice_id'),
    kind: text('kind').$type<PaymentKind>().notNull().default('payment'),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    method: text('method').$type<SettlementMethod>().notNull(),
    amount: money('amount').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    note: text('note'),
    reversedAt: timestamptz('reversed_at'),
    reversedBy: uuid('reversed_by'),
    reversalDate: date('reversal_date', { mode: 'string' }),
  },
  (t) => [
    tenantRef('customer_payments_customer_fk', [t.businessId, t.customerId], customers),
    tenantRef('customer_payments_order_fk', [t.businessId, t.orderId], orders),
    tenantRef('customer_payments_sale_fk', [t.businessId, t.saleId], sales),
    tenantRef('customer_payments_invoice_fk', [t.businessId, t.invoiceId], invoices),
    index('customer_payments_order_idx').on(t.businessId, t.orderId),
    index('customer_payments_sale_idx').on(t.businessId, t.saleId),
    index('customer_payments_invoice_idx').on(t.businessId, t.invoiceId),
    index('customer_payments_customer_idx').on(t.businessId, t.customerId, t.businessDate),
    check('customer_payments_document_check', sql`num_nonnulls(order_id, sale_id, invoice_id) = 1`),
    check('customer_payments_kind_check', sql`kind in (${quoted(PAYMENT_KINDS)})`),
    check('customer_payments_method_check', sql`method in (${quoted(SETTLEMENT_METHODS)})`),
    check('customer_payments_amount_check', sql`amount > 0`),
    check('customer_payments_currency_check', sql`currency ~ '^[A-Z]{3}$'`),
    check('customer_payments_note_check', sql`btrim(note) <> '' and char_length(note) <= 500`),
    check(
      'customer_payments_reversed_check',
      sql`(reversed_at is null) = (reversed_by is null)
        and (reversed_at is null) = (reversal_date is null)`,
    ),
  ],
)

export type Order = typeof orders.$inferSelect
export type NewOrder = typeof orders.$inferInsert
export type OrderLine = typeof orderLines.$inferSelect
export type NewOrderLine = typeof orderLines.$inferInsert
export type CustomerPayment = typeof customerPayments.$inferSelect
export type NewCustomerPayment = typeof customerPayments.$inferInsert
