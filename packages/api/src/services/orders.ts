import type {
  cancelOrderInput,
  createOrderInput,
  deliverOrderInput,
  OrderDto,
  orderIdInput,
  OrderLineDto,
  orderListInput,
  OrderListDto,
  OrderResultDto,
  updateOrderInput,
} from '@bizcost/contracts'
import { orderLines, orders, saleLines, sales, type NewSaleLine, type Tx } from '@bizcost/db'
import {
  can,
  compareDecimal,
  netPaid,
  newId,
  orderTransition,
  paymentState,
  phoneLast4,
  type OrderAction,
  type OrderStatus,
} from '@bizcost/domain'
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { assertModuleActive, assertPermission, assertQueryable } from '../trpc'
import { containsPattern, decodeCursor, encodeCursor, requestHashOf } from './catalog'
import { resolveCustomer } from './customers'
import { takeNumber } from './numbering'
import { lockReceivable, recordCustomerPaymentInTx } from './payments'
import { resolveLocation } from './purchases'
import { profitEnvOf, profitGroups } from './real-profit'
import { obligationsOf, paymentStateOf, readObligation, type ObligationRecord } from './receivables'
import { partsOf } from './reports'
import {
  amountsOf,
  assertDays,
  assertInScope,
  discountOf,
  freezeAndPost,
  lineValues,
  productsOf,
  resolveChannel,
  reverseInTx,
  saleContextOf,
  seesPayments,
  toLineDiscount,
  totalsOf,
  type PricedLine,
} from './sales'
import { assertPostable, isoOf, lockPostingBusiness, uuidArray } from './stock'

// Orders (ROADMAP.md M3 Step 5; DATA_MODEL.md §6; the owner's answers Q16, Q17, Q19, Q20 of D-218).
// Module `orders` (released with Release A, M3 Step 6).
// `orders.documents.view` sees every order (it needs every sale seen, H1); without it a member who
// enters orders (.manage) sees, changes, cancels and delivers only those they entered, while nobody
// else has changed them since (D-181, D-214); a member limited to some branches only those branches'
// (Q12). An order out of sight is NOT_FOUND, as if it did not exist. `.deliver` delivers, `.reverse`
// undoes a delivery (the router checks the keys).
//
// An order is numbered when it is created (document_counters `order`, #1001…; numbering.ts): a replay
// of a create is answered from the order before a number is taken, the counter row is the last lock
// taken, and a rollback gives the number back. A pending order may change (every save checks the
// whole order and stores computeSale's amounts, with its discount); delivering it posts its sale on
// the delivery day with the cost of what was sold frozen then (sales.ts freezeAndPost: lock 1 the
// order, lock 2 the business row, lock 3 the materials' cost rows); undoing a delivery reverses that
// sale (as if never finalized) and puts it back to pending; cancelling changes nothing in the books.
// A delivered order is never edited, and a cancelled one never changes again (database triggers).
//
// What an order is paid and owes (receivables.ts) shows only with payments.customers.view; the
// delivery cost is `cost` (the member who entered it reads what they typed, D-230); the order's
// profit (its sale and refunds, D-223) only with the costs switch.

type CreateInput = z.output<typeof createOrderInput>
type UpdateInput = z.output<typeof updateOrderInput>
type Fields = Omit<CreateInput, 'id' | 'payment'>
type IdInput = z.output<typeof orderIdInput>
type CancelInput = z.output<typeof cancelOrderInput>
type DeliverInput = z.output<typeof deliverOrderInput>
type ListInput = z.output<typeof orderListInput>
type InputLine = Fields['lines'][number]

const invalid = (message: string) => new AppError('validation', { message })

// ---------------------------------------------------------------------------------------------------
// Who sees what
// ---------------------------------------------------------------------------------------------------

/** The caller sees every order. */
function seesAllOrders(ctx: BusinessCtx): boolean {
  return can(ctx.access.effective, 'orders.documents.view')
}

/** The orders the caller may see (alias `o`): every order or their own, and only their branches. */
function visibleOrders(ctx: BusinessCtx): SQL[] {
  const parts: SQL[] = []
  if (!seesAllOrders(ctx)) parts.push(sql`o.created_by = app.current_user_id()`)
  const scope = ctx.access.locationScope
  if (!scope.all) parts.push(sql`o.location_id = any(${uuidArray([...scope.ids])})`)
  return parts
}

const where = (parts: readonly SQL[]) => sql.join([...parts], sql` and `)

/** Who entered an order: their name in the business now. */
const orderEnteredByName = sql`(
  select bm.display_name from app.business_members bm
   where bm.business_id = o.business_id and bm.user_id = o.created_by and bm.kind = 'account'
   order by (bm.status = 'active') desc, bm.created_at desc
   limit 1)`

/** The caller sees costs and profit: an order's profit (D-223) with the costs switch. */
function seesProfit(ctx: BusinessCtx): boolean {
  return (
    ctx.access.visibleCategories.has('cost') && ctx.access.visibleCategories.has('profit_margin')
  )
}

// ---------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------

interface OrderRecord extends Record<string, unknown> {
  id: string
  number: string
  seq: number
  status: OrderStatus
  customer_id: string | null
  customer_name: string | null
  customer_phone: string | null
  customer_ref: string | null
  business_date: string
  due_date: string | null
  location_id: string
  location_name: string
  channel_id: string
  channel_name: string
  channel_kind: OrderDto['channelKind']
  vat_registered: boolean
  currency: string
  discount_percent: string | null
  discount_amount: string | null
  subtotal: string
  discount_total: string
  net_total: string
  vat_total: string
  total: string
  delivery_needed: boolean
  delivery_area: string | null
  delivery_cost: string | null
  notes: string | null
  delivered_on: string | null
  sale_id: string | null
  delivered_at: Date | string | null
  cancelled_at: Date | string | null
  cancel_reason: string | null
  entered_by_name: string | null
  mine: boolean
  created_at: Date | string
  version: number
}

interface OrderLineRecord extends Record<string, unknown> {
  id: string
  kind: 'item' | 'delivery'
  product_id: string | null
  description: string | null
  qty: string
  unit: OrderLineDto['unit']
  unit_price: string
  price_includes_vat: boolean
  discount_percent: string | null
  discount_amount: string | null
  vat_category: OrderLineDto['vatCategory']
  vat_rate: string | null
  subtotal: string
  discount: string
  net: string
  vat: string
  total: string
}

async function orderLinesOf(tx: Tx, businessId: string, orderId: string) {
  return (await tx.execute(sql`
    select l.id, l.kind, l.product_id, l.description, trim_scale(l.qty)::text as qty, l.unit,
           trim_scale(l.unit_price)::text as unit_price, l.price_includes_vat,
           trim_scale(l.discount_percent)::text as discount_percent,
           trim_scale(l.discount_amount)::text as discount_amount, l.vat_category,
           trim_scale(l.vat_rate)::text as vat_rate, trim_scale(l.subtotal)::text as subtotal,
           trim_scale(l.discount)::text as discount, trim_scale(l.net)::text as net,
           trim_scale(l.vat)::text as vat, trim_scale(l.total)::text as total
      from app.order_lines l
     where l.business_id = ${businessId} and l.order_id = ${orderId} and l.deleted_at is null
     order by l.position, l.id
  `)) as unknown as OrderLineRecord[]
}

/**
 * The order as the API returns it: NOT_FOUND unless a live order of this business the caller may see.
 * A delivered order's delivery cost is its sale's (filled once later when it was missing, D-230).
 */
export async function readOrder(tx: Tx, ctx: BusinessCtx, id: string): Promise<OrderDto> {
  const [head] = (await tx.execute(sql`
    select o.id, o.number, o.seq, o.status, o.customer_id, cu.name as customer_name,
           cu.phone as customer_phone, o.customer_ref, o.business_date::text as business_date,
           o.due_date::text as due_date, o.location_id, l.name as location_name, o.channel_id,
           c.name as channel_name, c.kind as channel_kind, o.vat_registered,
           trim(o.currency) as currency,
           trim_scale(o.discount_percent)::text as discount_percent,
           trim_scale(o.discount_amount)::text as discount_amount,
           trim_scale(o.subtotal)::text as subtotal,
           trim_scale(o.discount_total)::text as discount_total,
           trim_scale(o.net_total)::text as net_total, trim_scale(o.vat_total)::text as vat_total,
           trim_scale(o.total)::text as total, o.delivery_needed, o.delivery_area,
           trim_scale(case when o.status = 'delivered' then s.delivery_cost else o.delivery_cost end)::text
             as delivery_cost,
           o.notes, o.delivered_on::text as delivered_on, o.sale_id, o.delivered_at,
           o.cancelled_at, o.cancel_reason, ${orderEnteredByName} as entered_by_name,
           o.created_by = app.current_user_id() as mine, o.created_at, o.version
      from app.orders o
      join app.locations l on l.business_id = o.business_id and l.id = o.location_id
      join app.sales_channels c on c.business_id = o.business_id and c.id = o.channel_id
      left join app.customers cu on cu.business_id = o.business_id and cu.id = o.customer_id
      left join app.sales s on s.business_id = o.business_id and s.id = o.sale_id
     where ${where([
       sql`o.business_id = ${ctx.businessId}`,
       sql`o.id = ${id}`,
       sql`o.deleted_at is null`,
       ...visibleOrders(ctx),
     ])}
  `)) as unknown as OrderRecord[]
  if (!head) throw new AppError('not_found')
  const lines = await orderLinesOf(tx, ctx.businessId, id)
  const refunds = (await tx.execute(sql`
    select r.id, r.business_date::text as business_date, r.refund_by,
           trim_scale(-r.total)::text as total, r.status
      from app.sales r
     where r.business_id = ${ctx.businessId} and r.order_id = ${id} and r.source = 'refund'
       and r.deleted_at is null and r.status <> 'draft'
     order by r.business_date desc, r.created_at desc, r.id desc
  `)) as unknown as {
    id: string
    business_date: string
    refund_by: 'quantity' | 'amount'
    total: string
    status: 'posted' | 'reversed'
  }[]
  const obligation = seesPayments(ctx)
    ? await readObligation(tx, ctx.businessId, 'order', id)
    : null
  return {
    id: head.id,
    number: head.number,
    seq: head.seq,
    status: head.status,
    customerId: head.customer_id,
    customerName: head.customer_name,
    customerPhoneLast4: phoneLast4(head.customer_phone),
    customerRef: head.customer_ref,
    businessDate: head.business_date,
    dueDate: head.due_date,
    locationId: head.location_id,
    locationName: head.location_name,
    channelId: head.channel_id,
    channelName: head.channel_name,
    channelKind: head.channel_kind,
    vatRegistered: head.vat_registered,
    currency: head.currency,
    discount: discountOf(head.discount_percent, head.discount_amount),
    subtotal: head.subtotal,
    discountTotal: head.discount_total,
    netTotal: head.net_total,
    vatTotal: head.vat_total,
    total: head.total,
    deliveryNeeded: head.delivery_needed,
    deliveryArea: head.delivery_area,
    deliveryCost: head.delivery_cost,
    ownDeliveryCost: head.mine ? head.delivery_cost : null,
    notes: head.notes,
    lines: lines.map((l) => ({
      id: l.id,
      kind: l.kind,
      productId: l.product_id,
      description: l.description,
      qty: l.qty,
      unit: l.unit,
      unitPrice: l.unit_price,
      priceIncludesVat: l.price_includes_vat,
      discount: discountOf(l.discount_percent, l.discount_amount),
      vatCategory: l.vat_category,
      vatRate: l.vat_rate,
      subtotal: l.subtotal,
      lineDiscount: l.discount,
      net: l.net,
      vat: l.vat,
      total: l.total,
    })),
    deliveredOn: head.delivered_on,
    saleId: head.sale_id,
    deliveredAt: isoOf(head.delivered_at),
    cancelledAt: isoOf(head.cancelled_at),
    cancelReason: head.cancel_reason,
    payment: obligation ? paymentStateOf(obligation) : null,
    refunds: refunds.map((r) => ({
      id: r.id,
      businessDate: r.business_date,
      by: r.refund_by,
      total: r.total,
      status: r.status,
    })),
    profit: head.status === 'delivered' ? await orderProfit(tx, ctx, head) : null,
    enteredByName: ctx.access.capabilities.has_team ? head.entered_by_name : null,
    mine: head.mine,
    createdAt: isoOf(head.created_at),
    version: head.version,
  }
}

/**
 * A delivered order's real profit (D-223): its sale and the refunds of it, at the shares and fees of
 * their months, the delivery's cost and the owner's time; only with the costs switch (null
 * otherwise).
 */
async function orderProfit(tx: Tx, ctx: BusinessCtx, head: OrderRecord) {
  if (!seesProfit(ctx)) return null
  const env = await profitEnvOf(tx, ctx)
  const [group] = await profitGroups(tx, env, {
    from: head.business_date,
    to: env.today,
    grouping: 'all',
    scope: null,
    orderId: head.id,
  })
  return group ? partsOf(group.sum, true) : null
}

function result(data: OrderDto): OrderResultDto {
  return { data, meta: { redacted: [] } }
}

/** `order.get`. */
export function getOrder(ctx: BusinessCtx, input: IdInput): Promise<OrderResultDto> {
  return ctx.tx(async (tx) => result(await readOrder(tx, ctx, input.id)))
}

interface ListRecord extends ObligationRecord {
  sort_key: string
  status: OrderStatus
  customer_ref: string | null
  delivered_on: string | null
  order_total: string
  line_count: number
  entered_by_name: string | null
  mine: boolean
  version: number
}

/**
 * The order's place in the list (one text, ascending): pending first by due day (none last), then by
 * number; then delivered and cancelled, newest first (by delivery day, or the order's day).
 */
const SORT_KEY = sql`case when o.status = 'pending'
    then '0|' || coalesce(o.due_date, '9999-12-31'::date)::text || '|' || lpad(o.seq::text, 12, '0')
    else (case when o.status = 'delivered' then '1|' else '2|' end)
      || (99999999 - to_char(coalesce(o.delivered_on, o.business_date), 'YYYYMMDD')::int)::text
      || '|' || lpad((999999999999 - o.seq)::text, 12, '0')
  end`

/**
 * `order.list`: pending orders first by due day, then delivered and cancelled ones newest first; a
 * search in the number, the customer's reference (LPO) and the customer's name; own orders only
 * without orders.documents.view. What each is paid and owes only with payments.customers.view.
 */
export function listOrders(ctx: BusinessCtx, input: ListInput): Promise<OrderListDto> {
  const filters: SQL[] = [
    sql`o.business_id = ${ctx.businessId}`,
    sql`o.deleted_at is null`,
    ...visibleOrders(ctx),
  ]
  if (input.status !== 'all') filters.push(sql`o.status = ${input.status}`)
  if (input.customerId) filters.push(sql`o.customer_id = ${input.customerId}`)
  if (input.search) {
    const pattern = containsPattern(input.search)
    filters.push(sql`(o.number ilike ${pattern} or o.customer_ref ilike ${pattern}
      or cu.name ilike ${pattern})`)
  }
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor)
    filters.push(sql`(${SORT_KEY}, o.id) > (${cursor.key}, ${cursor.id}::uuid)`)
  }
  const payments = seesPayments(ctx)
  return ctx.tx(async (tx) => {
    if (input.customerId) {
      const [customer] = (await tx.execute(sql`
        select c.id from app.customers c
         where c.business_id = ${ctx.businessId} and c.id = ${input.customerId}
           and c.deleted_at is null
      `)) as unknown as { id: string }[]
      if (!customer) throw new AppError('not_found')
    }
    const rows = (await tx.execute(sql`
      select ${SORT_KEY} as sort_key, o.id, o.number, o.status, o.customer_id,
             cu.name as customer_name, o.customer_ref, o.business_date::text as business_date,
             o.due_date::text as due_date, o.delivered_on::text as delivered_on,
             trim(o.currency) as currency, trim_scale(o.total)::text as order_total,
             (select count(*)::int from app.order_lines l
               where l.business_id = o.business_id and l.order_id = o.id and l.kind = 'item'
                 and l.deleted_at is null) as line_count,
             array(select coalesce(l.description, '') from app.order_lines l
                    where l.business_id = o.business_id and l.order_id = o.id
                      and l.kind = 'item' and l.deleted_at is null
                    order by l.position, l.id limit 2) as item_names,
             ${orderEnteredByName} as entered_by_name,
             o.created_by = app.current_user_id() as mine, o.version,
             trim_scale(d.total_n)::text as total, trim_scale(d.credited_n)::text as credited,
             trim_scale(d.paid_n)::text as paid, trim_scale(d.refunded_n)::text as refunded,
             trim_scale(greatest(d.left_n, 0))::text as owed,
             trim_scale(greatest(-d.left_n, 0))::text as overpaid
        from app.orders o
        left join app.customers cu on cu.business_id = o.business_id and cu.id = o.customer_id
        left join ${obligationsOf(ctx.businessId)} d on d.kind = 'order' and d.id = o.id
       where ${where(filters)}
       order by ${SORT_KEY}, o.id
       limit ${input.limit + 1}
    `)) as unknown as ListRecord[]
    const page = rows.slice(0, input.limit)
    const last = page.at(-1)
    const team = ctx.access.capabilities.has_team
    return {
      items: page.map((r) => ({
        id: r.id,
        number: r.number ?? '',
        status: r.status,
        customerId: r.customer_id,
        customerName: r.customer_name,
        customerRef: r.customer_ref,
        businessDate: r.business_date,
        dueDate: r.due_date,
        deliveredOn: r.delivered_on,
        currency: r.currency,
        total: r.order_total,
        lineCount: r.line_count,
        itemNames: r.item_names,
        paymentState: payments
          ? paymentState(r.total, r.credited, netPaid(r.paid, r.refunded))
          : null,
        owed: payments ? r.owed : null,
        enteredByName: team ? r.entered_by_name : null,
        mine: r.mine,
        version: r.version,
      })),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ key: last.sort_key, id: last.id })
          : null,
    }
  })
}

// ---------------------------------------------------------------------------------------------------
// Pending orders
// ---------------------------------------------------------------------------------------------------

/** What a save keeps of the order it changes. */
interface StoredOrder {
  readonly channelId: string
  readonly customerId: string | null
  readonly productIds: ReadonlySet<string>
  readonly deliveryCost: string | null
}

/**
 * Checks an order's day, customer, location, channel and products, and computes its amounts with its
 * discount (computeSale). Returns the columns of the order and of each line. The order's day is never
 * after today (FUTURE_DATE); a customer needs Customers on; "price includes VAT" on a delivery needs
 * VAT registration (CAPABILITY_DISABLED); an item names a product of the business (NOT_FOUND; an
 * archived one only when the order already has it, VALIDATION).
 */
async function prepareOrder(tx: Tx, ctx: BusinessCtx, input: Fields, stored: StoredOrder | null) {
  const biz = await saleContextOf(tx, ctx.businessId)
  assertDays(input.businessDate, null, biz.today)
  if (!biz.vatRegistered && input.lines.some((l) => l.kind === 'delivery' && l.amountIncludesVat)) {
    throw new AppError('capability_disabled', { message: 'VAT needs a VAT-registered business' })
  }
  if (input.customerId !== null) assertModuleActive(ctx, 'customers')
  const customerId = await resolveCustomer(
    tx,
    ctx.businessId,
    input.customerId,
    stored?.customerId ?? null,
  )
  const locationId = await resolveLocation(tx, ctx, input.locationId, biz.defaultLocationId)
  assertInScope(ctx, locationId)
  const channel = await resolveChannel(
    tx,
    ctx.businessId,
    input.channelId,
    stored?.channelId ?? null,
  )
  const items = input.lines.flatMap((l) => (l.kind === 'item' ? [l] : []))
  if (items.length > 0) assertModuleActive(ctx, 'products')
  const products = await productsOf(
    tx,
    ctx.businessId,
    items.map((l) => l.productId),
  )
  for (const line of items) {
    const product = products.get(line.productId)
    if (!product) throw new AppError('not_found')
    if (product.archived && !stored?.productIds.has(product.id)) {
      throw invalid('lines: a product was archived')
    }
  }
  const priced: PricedLine[] = input.lines.map((line) => ({
    line,
    product: line.kind === 'item' ? (products.get(line.productId) ?? null) : null,
  }))
  const discount = toLineDiscount(input.discount)
  const amounts = amountsOf(priced, biz.vatRegistered, biz.currency, discount)
  const deliveryCost = !input.deliveryNeeded
    ? null
    : input.deliveryCost === undefined
      ? (stored?.deliveryCost ?? null)
      : input.deliveryCost
  const header = {
    customerId,
    customerRef: input.customerRef,
    businessDate: input.businessDate,
    dueDate: input.dueDate,
    locationId,
    channelId: channel.id,
    vatRegistered: biz.vatRegistered,
    currency: biz.currency,
    discountPercent: input.discount && 'percent' in input.discount ? input.discount.percent : null,
    discountAmount: input.discount && 'amount' in input.discount ? input.discount.amount : null,
    ...totalsOf(amounts),
    deliveryNeeded: input.deliveryNeeded,
    deliveryArea: input.deliveryNeeded ? input.deliveryArea : null,
    deliveryCost,
    notes: input.notes,
  }
  return { header, lines: orderLineValues(ctx.businessId, priced, amounts, biz.vatRegistered) }
}

/** The order_lines columns of each line (a sale line's, without its cost). */
function orderLineValues(
  businessId: string,
  priced: readonly PricedLine[],
  amounts: ReturnType<typeof amountsOf>,
  vatRegistered: boolean,
) {
  return lineValues(businessId, priced, amounts, vatRegistered).map((line) => ({
    id: line.id!,
    businessId,
    position: line.position,
    kind: line.kind as 'item' | 'delivery',
    productId: line.productId ?? null,
    description: line.description ?? null,
    qty: line.qty,
    unit: line.unit ?? null,
    unitPrice: line.unitPrice,
    priceIncludesVat: line.priceIncludesVat ?? false,
    discountPercent: line.discountPercent ?? null,
    discountAmount: line.discountAmount ?? null,
    vatCategory: line.vatCategory ?? null,
    vatRate: line.vatRate ?? null,
    subtotal: line.subtotal ?? '0',
    discount: line.discount ?? '0',
    net: line.net ?? '0',
    vat: line.vat ?? '0',
    total: line.total ?? '0',
  }))
}

/** The create's fingerprint: every field as sent (its payment too). */
function createHashOf(input: CreateInput): string {
  const rest: Partial<CreateInput> = { ...input }
  delete rest.id
  return requestHashOf(rest)
}

/**
 * `order.create` (orders.documents.manage): a pending order numbered #1001…, idempotent on the
 * client's id: a replay (the same payload by the same member) is answered from the order before a
 * number is taken; an id used otherwise is CONFLICT. With `payment` ("Paid now / Deposit", Q17;
 * payments.customers.record and Payments on, FORBIDDEN / MODULE_DISABLED otherwise) its payment is
 * recorded in the same step, dated the order's day, at most its total (EXCEEDS_OUTSTANDING). The
 * counter row is the last lock taken (numbering.ts).
 */
export function createOrder(ctx: BusinessCtx, input: CreateInput): Promise<OrderResultDto> {
  const { id, payment, ...fields } = input
  const requestHash = createHashOf(input)
  if (payment) {
    assertModuleActive(ctx, 'payments')
    assertPermission(ctx, 'payments.customers.record')
  }
  return ctx.tx(async (tx) => {
    // Two creates of one id (a retry sent twice at once) wait for each other here, so the second is
    // answered from the order the first made, before a number is taken (never a skipped number for
    // a replay). Nothing else takes this lock.
    await tx.execute(sql`
      select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`order:${id}`}, 0))
    `)
    // A replay: answered from the order it made, before anything else (no number is taken).
    const [existing] = (await tx.execute(sql`
      select o.request_hash, o.created_by = app.current_user_id() as mine
        from app.orders o where o.business_id = ${ctx.businessId} and o.id = ${id}
    `)) as unknown as { request_hash: string | null; mine: boolean }[]
    if (existing) {
      if (existing.request_hash !== requestHash || !existing.mine) throw new AppError('conflict')
      return result(await readOrder(tx, ctx, id))
    }
    const { header, lines } = await prepareOrder(tx, ctx, fields, null)
    if (payment) {
      // Lock 2 before the number (the counter stays the last lock): the books-closed date.
      const business = await lockPostingBusiness(tx, ctx.businessId)
      assertPostable(business, fields.businessDate)
    }
    const { seq, number } = await takeNumber(tx, ctx.businessId, 'order')
    await tx.insert(orders).values({
      id,
      businessId: ctx.businessId,
      seq,
      number,
      status: 'pending',
      ...header,
      requestHash,
    })
    if (lines.length > 0) {
      await tx.insert(orderLines).values(lines.map((line) => ({ ...line, orderId: id })))
    }
    if (payment) {
      const head = await lockReceivable(tx, ctx, 'order', id)
      await recordCustomerPaymentInTx(tx, ctx, { kind: 'order', id }, head, {
        id: payment.id,
        kind: 'payment',
        businessDate: fields.businessDate,
        method: payment.method,
        amount: payment.amount,
        note: payment.note,
        requestHash: requestHashOf({ order: id, payment }),
      })
    }
    return result(await readOrder(tx, ctx, id))
  })
}

interface LockedOrder extends Record<string, unknown> {
  id: string
  status: OrderStatus
  version: number
  business_date: string
  location_id: string
  channel_id: string
  customer_id: string | null
  delivery_needed: boolean
  delivery_area: string | null
  delivery_cost: string | null
  discount_percent: string | null
  discount_amount: string | null
  notes: string | null
  sale_id: string | null
  delivered_on: string | null
  /** Who entered it: its sale, once delivered, is theirs too, whoever delivers it. */
  created_by: string
  /** The VAT registration its amounts were saved under. */
  vat_registered: boolean
  /** The caller entered it and wrote it last: nobody else changed it since (D-214). */
  mine: boolean
}

/** The order, locked FOR UPDATE (lock 1); NOT_FOUND when not live or not the caller's to see. */
async function lockOrder(tx: Tx, ctx: BusinessCtx, id: string): Promise<LockedOrder> {
  const [row] = (await tx.execute(sql`
    select o.id, o.status, o.version, o.business_date::text as business_date, o.location_id,
           o.channel_id, o.customer_id, o.delivery_needed, o.delivery_area,
           trim_scale(o.delivery_cost)::text as delivery_cost,
           trim_scale(o.discount_percent)::text as discount_percent,
           trim_scale(o.discount_amount)::text as discount_amount, o.notes, o.sale_id,
           o.delivered_on::text as delivered_on, o.created_by, o.vat_registered,
           coalesce(o.created_by = app.current_user_id()
             and coalesce(o.updated_by, o.created_by) = app.current_user_id(), false) as mine
      from app.orders o
     where ${where([
       sql`o.business_id = ${ctx.businessId}`,
       sql`o.id = ${id}`,
       sql`o.deleted_at is null`,
       ...visibleOrders(ctx),
     ])}
       for update
  `)) as unknown as LockedOrder[]
  if (!row) throw new AppError('not_found')
  return row
}

/**
 * A member who does not see every order changes, cancels and delivers only their own: those they
 * entered, while nobody else has saved them since (D-181, D-214). FORBIDDEN otherwise.
 */
function assertMayChange(ctx: BusinessCtx, head: LockedOrder): void {
  if (!seesAllOrders(ctx) && !head.mine) throw new AppError('forbidden')
}

/** Where `action` takes the order, or its refusal as the API error of the same name. */
function transition(action: OrderAction, head: LockedOrder) {
  const result = orderTransition(action, { status: head.status })
  if (!result.ok) throw new AppError(result.refusal)
  return result
}

/** The payments that stand on an order: what was paid (net), and whether any stands. */
async function paidOn(tx: Tx, businessId: string, orderId: string) {
  const [row] = (await tx.execute(sql`
    select count(*)::int as standing,
           trim_scale(coalesce(sum(case p.kind when 'refund' then -p.amount else p.amount end), 0))::text
             as paid
      from app.customer_payments p
     where p.business_id = ${businessId} and p.order_id = ${orderId}
       and p.reversed_at is null and p.deleted_at is null
  `)) as unknown as { standing: number; paid: string }[]
  return { standing: row?.standing ?? 0, paid: row?.paid ?? '0' }
}

/**
 * `order.update` (a pending order): the whole order, `version` as read. An order with payments that
 * stand is changed only by a member who may see them (FORBIDDEN), keeps its customer (VALIDATION) and
 * never comes to less than was paid on it (BELOW_PAID). Lines are matched by id: new ids added,
 * changed ones updated, missing ones taken out (soft-deleted).
 */
export function updateOrder(ctx: BusinessCtx, input: UpdateInput): Promise<OrderResultDto> {
  const { id, version, ...fields } = input
  return ctx.tx(async (tx) => {
    const head = await lockOrder(tx, ctx, id)
    assertMayChange(ctx, head)
    transition('update', head)
    if (head.version !== version) throw new AppError('conflict')
    if (fields.deliveryCost !== undefined && !head.mine) {
      assertQueryable(ctx, [{ name: 'deliveryCost', category: 'cost' }])
    }
    const live = (await tx.execute(sql`
      select l.id, l.product_id from app.order_lines l
       where l.business_id = ${ctx.businessId} and l.order_id = ${id} and l.deleted_at is null
    `)) as unknown as { id: string; product_id: string | null }[]
    const { header, lines } = await prepareOrder(tx, ctx, fields, {
      channelId: head.channel_id,
      customerId: head.customer_id,
      productIds: new Set(live.flatMap((l) => (l.product_id ? [l.product_id] : []))),
      deliveryCost: head.delivery_cost,
    })
    const paid = await paidOn(tx, ctx.businessId, id)
    if (paid.standing > 0) {
      if (!seesPayments(ctx)) throw new AppError('forbidden', { message: 'the order has payments' })
      if (header.customerId !== head.customer_id) {
        throw invalid('customerId: an order with payments keeps its customer')
      }
      if (compareDecimal(header.total, paid.paid) < 0) throw new AppError('below_paid')
    }
    await tx
      .update(orders)
      .set(header)
      .where(and(eq(orders.businessId, ctx.businessId), eq(orders.id, id)))
    const liveIds = new Set(live.map((l) => l.id))
    const kept = new Set(lines.map((line) => line.id))
    const removed = [...liveIds].filter((lineId) => !kept.has(lineId))
    if (removed.length > 0) {
      await tx
        .update(orderLines)
        .set({ deletedAt: sql`now()` })
        .where(
          and(
            eq(orderLines.businessId, ctx.businessId),
            eq(orderLines.orderId, id),
            inArray(orderLines.id, removed),
          ),
        )
    }
    const added = lines.filter((line) => !liveIds.has(line.id))
    if (added.length > 0) {
      await tx.insert(orderLines).values(added.map((line) => ({ ...line, orderId: id })))
    }
    for (const line of lines.filter((l) => liveIds.has(l.id))) {
      const values: Partial<typeof line> = { ...line }
      const lineId = line.id
      delete values.id
      delete values.businessId
      await tx
        .update(orderLines)
        .set(values)
        .where(
          and(
            eq(orderLines.businessId, ctx.businessId),
            eq(orderLines.orderId, id),
            eq(orderLines.id, lineId),
          ),
        )
    }
    return result(await readOrder(tx, ctx, id))
  })
}

/**
 * `order.cancel` (a pending order, `version` as read): nothing in the books changes; a deposit paid
 * on it shows as money back to the customer until it is given back (a refund payment). Idempotent: a
 * cancelled order is returned as it is. A delivered order's delivery is undone first
 * (DOCUMENT_POSTED).
 */
export function cancelOrder(ctx: BusinessCtx, input: CancelInput): Promise<OrderResultDto> {
  return ctx.tx(async (tx) => {
    const head = await lockOrder(tx, ctx, input.id)
    assertMayChange(ctx, head)
    const next = transition('cancel', head)
    if (!next.changes) return result(await readOrder(tx, ctx, input.id))
    if (head.version !== input.version) throw new AppError('conflict')
    await tx
      .update(orders)
      .set({
        status: 'cancelled',
        cancelledAt: sql`now()`,
        cancelledBy: sql`app.current_user_id()`,
        cancelReason: input.reason,
      })
      .where(and(eq(orders.businessId, ctx.businessId), eq(orders.id, input.id)))
    return result(await readOrder(tx, ctx, input.id))
  })
}

/**
 * `order.deliver` (orders.documents.deliver, `version` as read): the order counts as a sale on its
 * delivery day (default today; on or after the order's day, never after today, never on or before
 * the books-closed date): its sale (source `order`) is posted with its lines and the amounts the order
 * was saved with (worked out again only when the VAT registration changed since; the order then keeps
 * the new amounts, D-273) and the cost of what was sold frozen then (D-222), in the lock order: the
 * order (lock 1), the business row (lock 2), the materials' cost rows (lock 3). The sale is the order
 * entrant's own, whoever delivers it (D-273). Idempotent: a delivered order is returned as recorded.
 * Refused: a cancelled order (ORDER_CANCELLED), one with nothing sold (VALIDATION).
 */
export function deliverOrder(ctx: BusinessCtx, input: DeliverInput): Promise<OrderResultDto> {
  return ctx.tx(async (tx) => {
    const head = await lockOrder(tx, ctx, input.id)
    assertMayChange(ctx, head)
    const next = transition('deliver', head)
    if (!next.changes) return result(await readOrder(tx, ctx, input.id))
    if (head.version !== input.version) throw new AppError('conflict')
    const business = await lockPostingBusiness(tx, ctx.businessId)
    const day = input.businessDate ?? business.today
    if (day < head.business_date) throw invalid('businessDate: before the order’s day')
    assertPostable(business, day)
    const [location] = (await tx.execute(sql`
      select l.id from app.locations l
       where l.business_id = ${ctx.businessId} and l.id = ${head.location_id}
         and l.deleted_at is null
    `)) as unknown as { id: string }[]
    if (!location) throw invalid('location: removed since the order was saved')
    const stored = await orderLinesOf(tx, ctx.businessId, input.id)
    const items = stored.filter((l) => l.kind === 'item')
    if (items.length === 0) throw invalid('lines: an order needs something sold to deliver')
    assertModuleActive(ctx, 'products')
    const products = await productsOf(
      tx,
      ctx.businessId,
      items.map((l) => l.product_id ?? ''),
    )
    if (items.some((l) => !products.has(l.product_id ?? ''))) {
      throw invalid('lines: a product was removed')
    }
    // The sale's lines: the order's, with new ids (a delivery undone and done again posts a new
    // sale). Under the VAT registration the order was saved under, each item keeps the VAT basis
    // the order stored (its price with or without VAT, its category), so the sale comes to exactly
    // what the order was paid on: a product changed since changes no amount. Only when the
    // registration changed since are they worked out again, from the products as they are now.
    const sameRegistration = head.vat_registered === business.vatRegistered
    const saleId = newId()
    const asLines: InputLine[] = stored.map((l) =>
      l.kind === 'item'
        ? {
            kind: 'item',
            id: newId(),
            productId: l.product_id ?? '',
            description: l.description,
            qty: l.qty,
            unitPrice: l.unit_price,
            discount: discountOf(l.discount_percent, l.discount_amount),
          }
        : {
            kind: 'delivery',
            id: newId(),
            description: l.description,
            amount: l.unit_price,
            amountIncludesVat: l.price_includes_vat,
          },
    )
    const priced: PricedLine[] = asLines.map((line, i) => {
      const kept = stored[i]!
      return {
        line,
        product: line.kind === 'item' ? (products.get(line.productId) ?? null) : null,
        vat:
          line.kind === 'item' && sameRegistration
            ? {
                priceIncludesVat: kept.price_includes_vat,
                vatCategory: kept.vat_category ?? 'standard',
              }
            : undefined,
      }
    })
    const amounts = amountsOf(
      priced,
      business.vatRegistered,
      business.currency,
      toLineDiscount(discountOf(head.discount_percent, head.discount_amount)),
    )
    const totals = totalsOf(amounts)
    // The order keeps the amounts its sale counts (they change only when VAT registration did; then
    // what was paid beyond the new total shows as money back to the customer, D-273).
    const orderValues = orderLineValues(ctx.businessId, priced, amounts, business.vatRegistered)
    await tx
      .update(orders)
      .set({ vatRegistered: business.vatRegistered, currency: business.currency, ...totals })
      .where(and(eq(orders.businessId, ctx.businessId), eq(orders.id, input.id)))
    for (const [i, line] of stored.entries()) {
      const values = orderValues[i]!
      await tx
        .update(orderLines)
        .set({
          priceIncludesVat: values.priceIncludesVat,
          vatCategory: values.vatCategory,
          vatRate: values.vatRate,
          subtotal: values.subtotal,
          discount: values.discount,
          net: values.net,
          vat: values.vat,
          total: values.total,
        })
        .where(
          and(
            eq(orderLines.businessId, ctx.businessId),
            eq(orderLines.orderId, input.id),
            eq(orderLines.id, line.id),
          ),
        )
    }
    await tx.insert(sales).values({
      id: saleId,
      businessId: ctx.businessId,
      source: 'order',
      businessDate: day,
      locationId: head.location_id,
      channelId: head.channel_id,
      vatRegistered: business.vatRegistered,
      currency: business.currency,
      ...totals,
      deliveryNeeded: head.delivery_needed,
      deliveryArea: head.delivery_needed ? head.delivery_area : null,
      deliveryCost: head.delivery_needed ? head.delivery_cost : null,
      notes: head.notes,
      customerId: head.customer_id,
      orderId: input.id,
      // The order's sale is the sale of whoever entered the order (D-231's own records, and
      // D-230's delivery cost read back as one's own): never the deliverer's, who may not see costs.
      // Who delivered it is `posted_by` and the order's `delivered_by`.
      createdBy: head.created_by,
    })
    const saleLineRows: NewSaleLine[] = lineValues(
      ctx.businessId,
      priced,
      amounts,
      business.vatRegistered,
    ).map((line) => ({ ...line, saleId }))
    await tx.insert(saleLines).values(saleLineRows)
    await freezeAndPost(tx, ctx, {
      saleId,
      day,
      stored: asLines,
      priced,
      products,
      amounts,
      business,
    })
    await tx
      .update(orders)
      .set({
        status: 'delivered',
        deliveredOn: day,
        saleId,
        deliveredAt: sql`now()`,
        deliveredBy: sql`app.current_user_id()`,
      })
      .where(and(eq(orders.businessId, ctx.businessId), eq(orders.id, input.id)))
    return result(await readOrder(tx, ctx, input.id))
  })
}

/**
 * `order.undoDelivery` (orders.documents.reverse): the order's sale is reversed as if it was never
 * finalized and the order is pending again (it may be delivered again). Refused while refunds of its
 * sale stand (SALE_HAS_REFUNDS) or when its delivery day is closed (BOOKS_CLOSED); an issued invoice
 * will refuse it too (Step 8). Its payments stay on the order, and a delivery cost filled on its sale
 * since comes back to it. Idempotent: a pending order is returned as it is.
 */
export function undoDelivery(ctx: BusinessCtx, input: IdInput): Promise<OrderResultDto> {
  return ctx.tx(async (tx) => {
    const head = await lockOrder(tx, ctx, input.id)
    const next = transition('undo_delivery', head)
    if (!next.changes) return result(await readOrder(tx, ctx, input.id))
    const business = await lockPostingBusiness(tx, ctx.businessId)
    if (
      head.delivered_on !== null &&
      business.closedThrough !== null &&
      head.delivered_on <= business.closedThrough
    ) {
      throw new AppError('books_closed')
    }
    if (head.sale_id === null)
      throw new AppError('internal', { message: 'a delivery without sale' })
    await reverseInTx(tx, ctx, head.sale_id, { orderDelivery: true })
    // What the delivery cost, filled on the sale after it was delivered (D-230), comes back to the
    // order with it when the order had none: delivered again, its new sale keeps it (D-273). The sale
    // is locked and reversed above, so a fill either committed before (read here) or is refused
    // after (sale.fillDeliveryCost: a reversed order's sale takes none; the database holds it too).
    const [sold] = (await tx.execute(sql`
      select trim_scale(s.delivery_cost)::text as delivery_cost from app.sales s
       where s.business_id = ${ctx.businessId} and s.id = ${head.sale_id}
    `)) as unknown as { delivery_cost: string | null }[]
    const filled = head.delivery_cost === null ? (sold?.delivery_cost ?? null) : null
    await tx
      .update(orders)
      .set({
        status: 'pending',
        deliveredOn: null,
        saleId: null,
        deliveredAt: null,
        deliveredBy: null,
        ...(filled === null ? {} : { deliveryCost: filled }),
      })
      .where(and(eq(orders.businessId, ctx.businessId), eq(orders.id, input.id)))
    return result(await readOrder(tx, ctx, input.id))
  })
}
