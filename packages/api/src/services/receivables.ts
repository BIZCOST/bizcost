import type {
  DocumentPaymentStateDto,
  OwedDocumentDto,
  receivableListInput,
  ReceivableGroupDto,
  ReceivableKindDto,
  ReceivableListDto,
} from '@bizcost/contracts'
import { RECEIVABLE_DOCUMENTS_MAX } from '@bizcost/contracts'
import type { Tx } from '@bizcost/db'
import { netPaid, paymentState, phoneLast4, type OrderStatus } from '@bizcost/domain'
import { sql, type SQL } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { decodeCursor, encodeCursor } from './catalog'
import { uuidArray } from './stock'

// What customers owe (ROADMAP.md M3 Step 5; the owner's answer Q17 = A of D-218; A2: one figure per
// obligation). An obligation is an order (pending or delivered: its total; cancelled: nothing, so a
// deposit paid on it is money back to the customer) or a finalized One sale "they'll pay later". The
// sale a delivered order posted owes nothing: its order does, with the order's payments. Each:
//
//   credited = Σ its refunds that stand (with VAT; an order's: those of its sale)
//   paid     = Σ its payments that stand;   refunded = Σ the money given back that stands
//   left     = total − credited − (paid − refunded)
//   owed     = left when more than zero;    overpaid = −left when more than zero
//
// (outstandingOf / overpaidOf of @bizcost/domain, worked out in SQL so a list can filter and add up;
// paymentState gives the badge.) Every figure here is a sales amount, not a redaction category: who
// sees them is the key payments.customers.view (the routers check it). No output field is named
// `balance`.

type ListInput = z.output<typeof receivableListInput>

/**
 * Every obligation of the business with its sums (alias-free subquery): kind, id, business_id,
 * location_id, number, order_status, customer_id, business_date, due_date, currency, created_at, total_n, credited_n,
 * paid_n, refunded_n, left_n.
 */
export function obligationsOf(businessId: string): SQL {
  return sql`(
    select x.*, x.total_n - x.credited_n - (x.paid_n - x.refunded_n) as left_n
      from (
        select 'order'::text as kind, o.id, o.business_id, o.location_id, o.number, o.status as order_status, o.customer_id,
               o.business_date, o.due_date, trim(o.currency) as currency, o.created_at,
               case when o.status = 'cancelled' then 0::numeric else o.total end as total_n,
               coalesce(rf.credited, 0) as credited_n,
               coalesce(cp.paid, 0) as paid_n, coalesce(cp.refunded, 0) as refunded_n
          from app.orders o
          left join (
            select r.order_id, sum(-r.total) as credited from app.sales r
             where r.business_id = ${businessId} and r.source = 'refund' and r.status = 'posted'
               and r.deleted_at is null and r.order_id is not null
             group by r.order_id
          ) rf on rf.order_id = o.id
          left join (
            select p.order_id,
                   coalesce(sum(p.amount) filter (where p.kind = 'payment'), 0) as paid,
                   coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0) as refunded
              from app.customer_payments p
             where p.business_id = ${businessId} and p.order_id is not null
               and p.reversed_at is null and p.deleted_at is null
             group by p.order_id
          ) cp on cp.order_id = o.id
         where o.business_id = ${businessId} and o.deleted_at is null
        union all
        select 'sale'::text, s.id, s.business_id, s.location_id, null::text, null::text, s.customer_id, s.business_date,
               null::date, trim(s.currency), s.created_at, s.total,
               coalesce(rf.credited, 0), coalesce(cp.paid, 0), coalesce(cp.refunded, 0)
          from app.sales s
          left join (
            select r.refund_of_id, sum(-r.total) as credited from app.sales r
             where r.business_id = ${businessId} and r.source = 'refund' and r.status = 'posted'
               and r.deleted_at is null
             group by r.refund_of_id
          ) rf on rf.refund_of_id = s.id
          left join (
            select p.sale_id,
                   coalesce(sum(p.amount) filter (where p.kind = 'payment'), 0) as paid,
                   coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0) as refunded
              from app.customer_payments p
             where p.business_id = ${businessId} and p.sale_id is not null
               and p.reversed_at is null and p.deleted_at is null
             group by p.sale_id
          ) cp on cp.sale_id = s.id
         where s.business_id = ${businessId} and s.deleted_at is null and s.source = 'single'
           and s.pay_later and s.status = 'posted'
      ) x
  )`
}

/** An obligation as read with its customer and first item names. */
export interface ObligationRecord extends Record<string, unknown> {
  kind: ReceivableKindDto
  id: string
  number: string | null
  order_status: OrderStatus | null
  customer_id: string | null
  customer_name: string | null
  customer_phone: string | null
  customer_active: boolean | null
  business_date: string
  due_date: string | null
  currency: string
  total: string
  credited: string
  paid: string
  refunded: string
  owed: string
  overpaid: string
  item_names: string[]
}

/** The columns read of an obligation `d` (obligationsOf) with its customer `cu`. */
export const OBLIGATION_COLUMNS = sql`d.kind, d.id, d.number, d.order_status, d.customer_id,
  cu.name as customer_name, cu.phone as customer_phone, (cu.archived_at is null) as customer_active,
  d.business_date::text as business_date, d.due_date::text as due_date, d.currency,
  trim_scale(d.total_n)::text as total, trim_scale(d.credited_n)::text as credited,
  trim_scale(d.paid_n)::text as paid, trim_scale(d.refunded_n)::text as refunded,
  trim_scale(greatest(d.left_n, 0))::text as owed,
  trim_scale(greatest(-d.left_n, 0))::text as overpaid,
  case d.kind
    when 'order' then array(
      select coalesce(l.description, '') from app.order_lines l
       where l.business_id = d.business_id and l.order_id = d.id and l.kind = 'item'
         and l.deleted_at is null
       order by l.position, l.id limit 2)
    else array(
      select coalesce(l.description, '') from app.sale_lines l
       where l.business_id = d.business_id and l.sale_id = d.id and l.kind = 'item'
         and l.deleted_at is null
       order by l.position, l.id limit 2)
  end as item_names`

/** The payment block of a document: its sums and its badge. */
export function paymentStateOf(row: ObligationRecord): DocumentPaymentStateDto {
  const net = netPaidOf(row)
  return {
    state: paymentState(row.total, row.credited, net),
    total: row.total,
    credited: row.credited,
    paid: row.paid,
    refunded: row.refunded,
    owed: row.owed,
    overpaid: row.overpaid,
  }
}

/** What was paid on a document, net of the money given back (exact). */
function netPaidOf(row: { paid: string; refunded: string }): string {
  return netPaid(row.paid, row.refunded)
}

/** The DTO of an obligation. */
export function owedDocumentOf(row: ObligationRecord): OwedDocumentDto {
  return {
    kind: row.kind,
    id: row.id,
    number: row.number,
    orderStatus: row.order_status,
    customerId: row.customer_id,
    customerName: row.customer_name,
    businessDate: row.business_date,
    dueDate: row.due_date,
    itemNames: row.item_names,
    currency: row.currency,
    total: row.total,
    credited: row.credited,
    paid: row.paid,
    refunded: row.refunded,
    owed: row.owed,
    overpaid: row.overpaid,
    state: paymentState(row.total, row.credited, netPaidOf(row)),
  }
}

/** The obligations named (orders and sales "they'll pay later"), in the order asked; missing: none. */
export async function readObligations(
  tx: Tx,
  businessId: string,
  refs: readonly { kind: ReceivableKindDto; id: string }[],
): Promise<Map<string, ObligationRecord>> {
  const result = new Map<string, ObligationRecord>()
  if (refs.length === 0) return result
  const rows = (await tx.execute(sql`
    select ${OBLIGATION_COLUMNS}
      from ${obligationsOf(businessId)} d
      left join app.customers cu on cu.business_id = ${businessId} and cu.id = d.customer_id
     where d.id = any(${uuidArray(refs.map((r) => r.id))})
  `)) as unknown as ObligationRecord[]
  for (const row of rows) {
    if (refs.some((r) => r.id === row.id && r.kind === row.kind)) result.set(row.id, row)
  }
  return result
}

/** One obligation (null: not an order, nor a finalized sale "they'll pay later"). */
export async function readObligation(
  tx: Tx,
  businessId: string,
  kind: ReceivableKindDto,
  id: string,
): Promise<ObligationRecord | null> {
  return (await readObligations(tx, businessId, [{ kind, id }])).get(id) ?? null
}

interface GroupRecord extends ObligationRecord {
  all_owed: string
  all_overpaid: string
  has_more: boolean
  group_key: string
  group_id: string
  group_name: string | null
  group_phone: string | null
  group_active: boolean
  group_owed: string
  group_overpaid: string
  document_count: number
}

/** The id of the group of orders that name no customer (it sorts last). */
const NO_CUSTOMER = '00000000-0000-0000-0000-000000000000'
const NO_CUSTOMER_KEY = '￿'

/**
 * `receivable.list` (payments.customers.view with Payments on; the router checks them): the
 * obligations still owed or paid beyond (cancelled orders' deposits too), by customer by name (keyset
 * on the lower-case name and id; orders without a customer last), `limit` customers a page, each with
 * its oldest RECEIVABLE_DOCUMENTS_MAX documents, how many there are and what they come to; `owed` and
 * `overpaid` are every customer's (all pages). One statement, so a page and its totals are read at one
 * moment.
 */
export function listReceivables(ctx: BusinessCtx, input: ListInput): Promise<ReceivableListDto> {
  const after = input.cursor ? decodeCursor(input.cursor) : null
  const filters: SQL[] = [sql`(d.left_n <> 0)`]
  // A member limited to some branches (Q12): their branches' orders and sales only.
  const scope = ctx.access.locationScope
  if (!scope.all) filters.push(sql`d.location_id = any(${uuidArray([...scope.ids])})`)
  if (input.customerId) filters.push(sql`d.customer_id = ${input.customerId}`)
  return ctx.tx(async (tx) => {
    if (input.customerId) {
      const [customer] = (await tx.execute(sql`
        select c.id from app.customers c
         where c.business_id = ${ctx.businessId} and c.id = ${input.customerId}
           and c.deleted_at is null
      `)) as unknown as { id: string }[]
      if (!customer) throw new AppError('not_found')
    }
    const [business] = (await tx.execute(sql`
      select trim(b.currency) as currency from app.businesses b where b.id = ${ctx.businessId}
    `)) as unknown as { currency: string }[]
    const rows = (await tx.execute(sql`
      with owed as (
        select d.*, cu.name as customer_name_, cu.phone as customer_phone_,
               (cu.archived_at is null) as customer_active_,
               coalesce(lower(cu.name), ${NO_CUSTOMER_KEY}) as group_key,
               coalesce(d.customer_id, ${NO_CUSTOMER}::uuid) as group_id
          from ${obligationsOf(ctx.businessId)} d
          left join app.customers cu on cu.business_id = ${ctx.businessId} and cu.id = d.customer_id
         where ${sql.join(filters, sql` and `)}
      ),
      groups as (
        select o.group_key, o.group_id, min(o.customer_name_) as group_name,
               min(o.customer_phone_) as group_phone, bool_or(coalesce(o.customer_active_, true))
                 as group_active,
               sum(greatest(o.left_n, 0)) as owed_n, sum(greatest(-o.left_n, 0)) as overpaid_n,
               count(*)::int as document_count
          from owed o
         group by o.group_key, o.group_id
      ),
      page as (
        select g.*, row_number() over (order by g.group_key, g.group_id) as pn
          from groups g
         ${after ? sql`where (g.group_key, g.group_id) > (${after.key}, ${after.id}::uuid)` : sql``}
         order by g.group_key, g.group_id
         limit ${input.limit + 1}
      ),
      ranked as (
        select o.*, row_number() over (
                 partition by o.group_id order by o.business_date, o.created_at, o.kind, o.id
               ) as n
          from owed o
         where o.group_id in (select p.group_id from page p where p.pn <= ${input.limit})
      )
      select trim_scale(t.all_owed)::text as all_owed, trim_scale(t.all_overpaid)::text as all_overpaid,
             t.has_more, x.*
        from (
          select coalesce((select sum(g.owed_n) from groups g), 0) as all_owed,
                 coalesce((select sum(g.overpaid_n) from groups g), 0) as all_overpaid,
                 (select count(*) from page) > ${input.limit} as has_more
        ) t
        left join lateral (
          select p.group_key, p.group_id::text as group_id, p.group_name, p.group_phone,
                 p.group_active, trim_scale(p.owed_n)::text as group_owed,
                 trim_scale(p.overpaid_n)::text as group_overpaid, p.document_count, p.pn, d.n,
                 ${OBLIGATION_COLUMNS}
            from page p
            join ranked d on d.group_id = p.group_id and d.n <= ${RECEIVABLE_DOCUMENTS_MAX}
            left join app.customers cu on cu.business_id = ${ctx.businessId} and cu.id = d.customer_id
           where p.pn <= ${input.limit}
        ) x on true
       order by x.pn, x.n
    `)) as unknown as (GroupRecord & { pn: number; n: number })[]
    const groups: ReceivableGroupDto[] = []
    for (const row of rows) {
      if (row.group_id === null || row.group_id === undefined) continue
      let group = groups.at(-1)
      const customerId = row.group_id === NO_CUSTOMER ? null : row.group_id
      if (!group || (group.customerId ?? NO_CUSTOMER) !== row.group_id) {
        group = {
          customerId,
          name: row.group_name,
          phoneLast4: phoneLast4(row.group_phone),
          active: row.group_active,
          owed: row.group_owed,
          overpaid: row.group_overpaid,
          documentCount: row.document_count,
          documents: [],
        }
        groups.push(group)
      }
      group.documents.push(owedDocumentOf(row))
    }
    const first = rows[0]
    const last = rows.at(-1)
    return {
      currency: business?.currency ?? '',
      owed: first?.all_owed ?? '0',
      overpaid: first?.all_overpaid ?? '0',
      groups,
      nextCursor:
        first?.has_more && last?.group_id
          ? encodeCursor({ key: last.group_key, id: last.group_id })
          : null,
    }
  })
}
