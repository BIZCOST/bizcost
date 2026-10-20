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
// deposit paid on it is money back to the customer), a finalized One sale "they'll pay later", or (M3
// Step 8) an issued invoice. The sale a delivered order posted owes nothing: its order does, with the
// order's payments. Once an order or a sale has an issued invoice, what is owed lives on its invoices
// (A2), and an order's on what they do not bill yet (D-313): the order's own obligation is then only
// that rest (its payable less what its issued invoices still bill: their payable less the credit
// notes that only billed less, D-305), until its last invoice bills it. What was paid on the order or
// sale (a sale paid when made: its total) counts toward its invoices, a deposit invoice first, then by
// number, each up to what it still needs, then the order's rest; the last taking all that is left
// (documents/invoice.ts allocatePayments). Each:
//
//   credited = Σ its refunds that stand (with VAT; an order's: those of its sale; an invoice's: its
//              issued credit notes)
//   paid     = Σ its payments that stand (an invoice's: with what its order or sale paid toward it);
//   refunded = Σ the money given back that stands
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
 * paid_n, refunded_n, invoiced (an order its issued invoices bill in part: this is what they do not
 * bill yet), source_kind and source_id (an invoice's order or sale, an order's rest: its order),
 * left_n.
 */
export function obligationsOf(businessId: string, asOf: string | null = null): SQL {
  // As it stood at `asOf` (an issued document's PDF, made again identically): the payments recorded by
  // then and not reversed by then, the invoices and credit notes issued by then.
  const standing = (alias: string) => {
    const a = sql.raw(alias)
    return asOf === null
      ? sql`${a}.reversed_at is null`
      : sql`${a}.created_at <= ${asOf}::timestamptz
          and (${a}.reversed_at is null or ${a}.reversed_at > ${asOf}::timestamptz)`
  }
  const issued = (alias: string) =>
    asOf === null ? sql`` : sql` and ${sql.raw(alias)}.issued_at <= ${asOf}::timestamptz`
  return sql`(
    with inv as (
      select i.id, i.business_id, i.location_id, i.number, i.customer_id, i.issue_date, i.due_date,
             trim(i.currency) as currency, i.created_at, i.order_id, i.sale_id, i.is_deposit, i.seq,
             i.payable as total_n, coalesce(cn.credited, 0) as credited_n,
             coalesce(cp.paid, 0) as own_paid, coalesce(cp.refunded, 0) as own_refunded
        from app.invoices i
        left join (
          select c.invoice_id, sum(c.total) as credited from app.credit_notes c
           where c.business_id = ${businessId} and c.status = 'issued' and c.deleted_at is null${issued('c')}
           group by c.invoice_id
        ) cn on cn.invoice_id = i.id
        left join (
          select p.invoice_id,
                 coalesce(sum(p.amount) filter (where p.kind = 'payment'), 0) as paid,
                 coalesce(sum(p.amount) filter (where p.kind = 'refund'), 0) as refunded
            from app.customer_payments p
           where p.business_id = ${businessId} and p.invoice_id is not null
             and ${standing('p')} and p.deleted_at is null
           group by p.invoice_id
        ) cp on cp.invoice_id = i.id
       where i.business_id = ${businessId} and i.status = 'issued' and i.deleted_at is null${issued('i')}
    ),
    -- What each invoiced order or sale paid: an order's payments (net of money given back), a sale
    -- "they'll pay later"'s likewise, a sale paid when made its total less its refunds.
    src as (
      select o.id as source_id,
             coalesce(sum(case p.kind when 'refund' then -p.amount else p.amount end), 0) as avail
        from app.orders o
        left join app.customer_payments p
          on p.business_id = o.business_id and p.order_id = o.id
         and ${standing('p')} and p.deleted_at is null
       where o.business_id = ${businessId} and o.id in (select v.order_id from inv v)
       group by o.id
      union all
      select s.id,
             case when s.pay_later then coalesce((
               select sum(case p.kind when 'refund' then -p.amount else p.amount end)
                 from app.customer_payments p
                where p.business_id = s.business_id and p.sale_id = s.id
                  and ${standing('p')} and p.deleted_at is null), 0)
             else s.total - coalesce((
               select sum(-r.total) from app.sales r
                where r.business_id = s.business_id and r.refund_of_id = s.id
                  and r.status = 'posted' and r.deleted_at is null), 0) end
        from app.sales s
       where s.business_id = ${businessId} and s.id in (select v.sale_id from inv v)
    ),
    -- An invoiced order's rest (D-313): its payable less what its issued invoices still bill (each one's
    -- payable less its credit notes that only billed less, D-305); a cancelled order has none.
    rem as (
      select o.id, o.business_id, o.location_id, o.number, o.status, o.customer_id, o.business_date,
             o.due_date, trim(o.currency) as currency, o.created_at,
             o.total + o.rounding_difference - coalesce((
               select sum(v.total_n - coalesce((
                        select sum(c.total) from app.credit_notes c
                         where c.business_id = v.business_id and c.invoice_id = v.id
                           and c.status = 'issued' and c.deleted_at is null and c.counted_on is null
                           and c.counted_elsewhere is null${issued('c')}), 0))
                 from inv v where v.order_id = o.id), 0) as rest_n
        from app.orders o
       where o.business_id = ${businessId} and o.deleted_at is null and o.status <> 'cancelled'
         and o.id in (select v.order_id from inv v)
    ),
    need as (
      select v.id, v.business_id, v.location_id, v.number, null::text as order_status, v.customer_id,
             v.issue_date as business_date, v.due_date, v.currency, v.created_at, v.order_id,
             v.sale_id, v.is_deposit, v.seq, v.total_n, v.credited_n, v.own_paid, v.own_refunded,
             false as rest, coalesce(sp.avail, 0) as avail,
             greatest(v.total_n - v.credited_n - (v.own_paid - v.own_refunded), 0) as need_n
        from inv v
        left join src sp on sp.source_id = coalesce(v.order_id, v.sale_id)
      union all
      select r.id, r.business_id, r.location_id, r.number, r.status, r.customer_id, r.business_date,
             r.due_date, r.currency, r.created_at, r.id, null::uuid, false, null::int, r.rest_n, 0, 0,
             0, true, coalesce(sp.avail, 0), r.rest_n
        from rem r
        left join src sp on sp.source_id = r.id
       where r.rest_n > 0
    ),
    alloc as (
      select n.*,
             coalesce(sum(n.need_n) over (
               partition by coalesce(n.order_id, n.sale_id, n.id)
               order by n.is_deposit desc, n.seq nulls last
               rows between unbounded preceding and 1 preceding), 0) as need_before,
             row_number() over (
               partition by coalesce(n.order_id, n.sale_id, n.id)
               order by n.is_deposit asc, n.seq desc nulls first) = 1 as last_one
        from need n
    )
    select x.*, x.total_n - x.credited_n - (x.paid_n - x.refunded_n) as left_n
      from (
        select 'order'::text as kind, o.id, o.business_id, o.location_id, o.number, o.status as order_status, o.customer_id,
               o.business_date, o.due_date, trim(o.currency) as currency, o.created_at,
               -- What the customer owes for an order: its total and its rounding difference (M3 Step 7).
               case when o.status = 'cancelled' then 0::numeric
                    else o.total + o.rounding_difference end as total_n,
               coalesce(rf.credited, 0) as credited_n,
               coalesce(cp.paid, 0) as paid_n, coalesce(cp.refunded, 0) as refunded_n,
               false as invoiced, null::text as source_kind, null::uuid as source_id
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
               and ${standing('p')} and p.deleted_at is null
             group by p.order_id
          ) cp on cp.order_id = o.id
         where o.business_id = ${businessId} and o.deleted_at is null
           and not exists (select 1 from inv v where v.order_id = o.id)
        union all
        select 'sale'::text, s.id, s.business_id, s.location_id, null::text, null::text, s.customer_id, s.business_date,
               null::date, trim(s.currency), s.created_at, s.total,
               coalesce(rf.credited, 0), coalesce(cp.paid, 0), coalesce(cp.refunded, 0), false,
               null::text, null::uuid
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
               and ${standing('p')} and p.deleted_at is null
             group by p.sale_id
          ) cp on cp.sale_id = s.id
         where s.business_id = ${businessId} and s.deleted_at is null and s.source = 'single'
           and s.pay_later and s.status = 'posted'
           and not exists (select 1 from inv v where v.sale_id = s.id)
        union all
        -- Issued invoices, and an invoiced order's rest (kind order, invoiced).
        select case when a.rest then 'order' else 'invoice' end::text, a.id, a.business_id,
               a.location_id, a.number, a.order_status, a.customer_id, a.business_date, a.due_date,
               a.currency, a.created_at, a.total_n, a.credited_n,
               a.own_paid + case when a.last_one then greatest(a.avail - a.need_before, 0)
                                 else least(a.need_n, greatest(a.avail - a.need_before, 0)) end,
               a.own_refunded, a.rest,
               case when a.order_id is not null then 'order'
                    when a.sale_id is not null then 'sale' end::text,
               coalesce(a.order_id, a.sale_id)
          from alloc a
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
  /** An order its issued invoices bill in part: this is what they do not bill yet (D-313). */
  invoiced: boolean
  item_names: string[]
}

/** The columns read of an obligation `d` (obligationsOf) with its customer `cu`. */
export const OBLIGATION_COLUMNS = sql`d.kind, d.id, d.number, d.order_status, d.customer_id, d.invoiced,
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
    when 'invoice' then array(
      select l.description from app.invoice_lines l
       where l.business_id = d.business_id and l.invoice_id = d.id and l.kind = 'item'
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
    invoicedInPart: row.invoiced === true,
  }
}

/**
 * The obligations named (orders, sales "they'll pay later" and issued invoices), in the order asked;
 * missing: none (an invoiced sale, or an order its invoices bill in full, is no obligation: its
 * invoices are; an order they bill in part is its rest, D-313).
 */
export async function readObligations(
  tx: Tx,
  businessId: string,
  refs: readonly { kind: ReceivableKindDto; id: string }[],
  asOf: string | null = null,
): Promise<Map<string, ObligationRecord>> {
  const result = new Map<string, ObligationRecord>()
  if (refs.length === 0) return result
  const rows = (await tx.execute(sql`
    select ${OBLIGATION_COLUMNS}
      from ${obligationsOf(businessId, asOf)} d
      left join app.customers cu on cu.business_id = ${businessId} and cu.id = d.customer_id
     where d.id = any(${uuidArray(refs.map((r) => r.id))})
  `)) as unknown as ObligationRecord[]
  for (const row of rows) {
    if (refs.some((r) => r.id === row.id && r.kind === row.kind)) result.set(row.id, row)
  }
  return result
}

/**
 * What the issued invoices of each order or sale (`column`: `order_id` or `sale_id`) are paid and owe
 * together, with an order's rest not invoiced yet (D-313), as a subquery (columns source_id, total_n,
 * credited_n, paid_n, refunded_n, owed_n, overpaid_n): once an order or a sale has an issued invoice,
 * its page and list show this state (A2, M3 Step 8).
 */
export function invoicedObligationsOf(
  businessId: string,
  column: 'order_id' | 'sale_id',
  obligations: SQL = obligationsOf(businessId),
): SQL {
  return sql`(
    select e.source_id, sum(e.total_n) as total_n,
           sum(e.credited_n) as credited_n, sum(e.paid_n) as paid_n,
           sum(e.refunded_n) as refunded_n, sum(greatest(e.left_n, 0)) as owed_n,
           sum(greatest(-e.left_n, 0)) as overpaid_n
      from ${obligations} e
     where e.source_kind = ${column === 'order_id' ? 'order' : 'sale'} and e.source_id is not null
     group by e.source_id
  )`
}

/**
 * What an order's or a sale's issued invoices are paid and owe together (null when it has none): its
 * payment state once invoiced (A2).
 */
export async function invoicedPaymentState(
  tx: Tx,
  businessId: string,
  kind: 'order' | 'sale',
  id: string,
): Promise<DocumentPaymentStateDto | null> {
  const [row] = (await tx.execute(sql`
    select trim_scale(d.total_n)::text as total, trim_scale(d.credited_n)::text as credited,
           trim_scale(d.paid_n)::text as paid, trim_scale(d.refunded_n)::text as refunded,
           trim_scale(d.owed_n)::text as owed, trim_scale(d.overpaid_n)::text as overpaid
      from ${invoicedObligationsOf(businessId, kind === 'order' ? 'order_id' : 'sale_id')} d
     where d.source_id = ${id}
  `)) as unknown as {
    total: string
    credited: string
    paid: string
    refunded: string
    owed: string
    overpaid: string
  }[]
  if (!row) return null
  return {
    state: paymentState(row.total, row.credited, netPaid(row.paid, row.refunded)),
    total: row.total,
    credited: row.credited,
    paid: row.paid,
    refunded: row.refunded,
    owed: row.owed,
    overpaid: row.overpaid,
  }
}

/**
 * An invoiced order or sale "they'll pay later" as an obligation's record: its own head, with what its
 * issued invoices are paid and owe together (A2). Null when it is neither, or has no issued invoice.
 * For its page and its payments (its deposit stays listed on it), never for the lists of what is owed.
 */
export async function readInvoicedDocument(
  tx: Tx,
  businessId: string,
  kind: 'order' | 'sale',
  id: string,
): Promise<ObligationRecord | null> {
  const invoiced = invoicedObligationsOf(businessId, kind === 'order' ? 'order_id' : 'sale_id')
  const head =
    kind === 'order'
      ? sql`select 'order'::text as kind, o.id, o.business_id, o.number, o.status as order_status,
                   o.customer_id, o.business_date, o.due_date, trim(o.currency) as currency
              from app.orders o
             where o.business_id = ${businessId} and o.id = ${id} and o.deleted_at is null`
      : sql`select 'sale'::text as kind, s.id, s.business_id, null::text as number,
                   null::text as order_status, s.customer_id, s.business_date, null::date as due_date,
                   trim(s.currency) as currency
              from app.sales s
             where s.business_id = ${businessId} and s.id = ${id} and s.deleted_at is null
               and s.source = 'single' and s.pay_later and s.status = 'posted'`
  const [row] = (await tx.execute(sql`
    select h.kind, h.id, h.number, h.order_status, h.customer_id, false as invoiced,
           cu.name as customer_name,
           cu.phone as customer_phone, (cu.archived_at is null) as customer_active,
           h.business_date::text as business_date, h.due_date::text as due_date, h.currency,
           trim_scale(di.total_n)::text as total, trim_scale(di.credited_n)::text as credited,
           trim_scale(di.paid_n)::text as paid, trim_scale(di.refunded_n)::text as refunded,
           trim_scale(di.owed_n)::text as owed, trim_scale(di.overpaid_n)::text as overpaid,
           case h.kind
             when 'order' then array(
               select coalesce(l.description, '') from app.order_lines l
                where l.business_id = h.business_id and l.order_id = h.id and l.kind = 'item'
                  and l.deleted_at is null
                order by l.position, l.id limit 2)
             else array(
               select coalesce(l.description, '') from app.sale_lines l
                where l.business_id = h.business_id and l.sale_id = h.id and l.kind = 'item'
                  and l.deleted_at is null
                order by l.position, l.id limit 2)
           end as item_names
      from (${head}) h
      join ${invoiced} di on di.source_id = h.id
      left join app.customers cu on cu.business_id = h.business_id and cu.id = h.customer_id
  `)) as unknown as ObligationRecord[]
  return row ?? null
}

/**
 * What a document owes as a whole (its page, its payments): an invoiced order or sale, what its issued
 * invoices and an order's rest are paid and owe together (A2, D-313); otherwise the obligation itself
 * (null: none).
 */
export async function readDocumentObligation(
  tx: Tx,
  businessId: string,
  kind: ReceivableKindDto,
  id: string,
): Promise<ObligationRecord | null> {
  if (kind !== 'invoice') {
    const invoiced = await readInvoicedDocument(tx, businessId, kind, id)
    if (invoiced) return invoiced
  }
  return readObligation(tx, businessId, kind, id)
}

/** One obligation (null: not an order, a finalized sale "they'll pay later" nor an issued invoice). */
export async function readObligation(
  tx: Tx,
  businessId: string,
  kind: ReceivableKindDto,
  id: string,
  asOf: string | null = null,
): Promise<ObligationRecord | null> {
  return (await readObligations(tx, businessId, [{ kind, id }], asOf)).get(id) ?? null
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
