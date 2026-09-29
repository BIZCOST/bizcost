import {
  PAYABLE_INVOICES_MAX,
  type payableListInput,
  type PayableGroupDto,
  type PayableListDto,
  type PurchasePayersDto,
  type PurchasePaymentDto,
  type purchasePaymentsInput,
  type PurchasePaymentsDto,
  type recordPurchasePaymentInput,
  type reversePurchasePaymentInput,
} from '@bizcost/contracts'
import { createIdempotent, purchasePayments, type Tx } from '@bizcost/db'
import {
  compareDecimal,
  fitsCurrency,
  isCurrencyCode,
  isOwedPaymentMethod,
  outstandingOf,
  overpaidOf,
  type PaymentMethod,
  type SettlementMethod,
} from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { assertQueryable } from '../trpc'
import { decodeCursor, encodeCursor, requestHashOf } from './catalog'
import { assertPostable, isoOf, lockPostingBusiness, reversalDateOf } from './stock'

// What the business still owes on its purchases, and paying it (the owner's requests of 2026-09-29).
// A final purchase bought on credit (`supplier_credit`) is owed to its supplier; one a member paid
// from their own money (`paid_by_member`) is owed to that member. What is owed = its total, less its
// final returns and credit notes (their totals), less the payments that stand (outstandingOf in
// @bizcost/domain; never below zero). Module `purchases`; purchases.payments.view to read,
// purchases.payments.record to record or reverse a payment (the router checks them); every amount is
// `supplier_price`. Listing what is owed filters on amounts, and a payment is checked against what is
// owed, so both need supplier prices visible (FORBIDDEN otherwise, before anything is read).
//
// Locks: recording or reversing a payment locks the purchase FOR UPDATE first (then the business row
// FOR SHARE for the books-closed date), as a reversal of the purchase does; so a payment and the
// purchase's reversal, or two payments of one purchase, wait for each other, and a return or credit
// note (its purchase FOR SHARE) waits too. Payments are never edited or deleted (a database trigger):
// one recorded by mistake is reversed and stops counting.

type ListInput = z.output<typeof payableListInput>
type PaymentsInput = z.output<typeof purchasePaymentsInput>
type RecordInput = z.output<typeof recordPurchasePaymentInput>
type ReverseInput = z.output<typeof reversePurchasePaymentInput>

const invalid = (message: string) => new AppError('validation', { message })

/** Listing what is owed or paying it reads amounts the caller must be allowed to see. */
function assertSeesAmounts(ctx: BusinessCtx) {
  assertQueryable(ctx, [{ name: 'outstanding', category: 'supplier_price' }])
}

/** A member of the business by an auth user id (the newest membership), as `memberNameDto`. */
const memberByUser = (userColumn: ReturnType<typeof sql.raw>) => sql`
  (select m.id from app.business_members m
    where m.business_id = p.business_id and m.user_id = ${userColumn}
    order by (m.deleted_at is null) desc, m.created_at desc limit 1)`

// ---------------------------------------------------------------------------------------------------
// Who may have paid
// ---------------------------------------------------------------------------------------------------

/** `purchase.payers`: the active members of the business, by name; the caller is `isMe`. */
export function listPayers(ctx: BusinessCtx): Promise<PurchasePayersDto> {
  return ctx.tx(async (tx) => {
    const rows = (await tx.execute(sql`
      select m.id, m.display_name
        from app.business_members m
       where m.business_id = ${ctx.businessId} and m.status = 'active' and m.deleted_at is null
       order by lower(m.display_name), m.id
    `)) as unknown as { id: string; display_name: string }[]
    return {
      items: rows.map((r) => ({
        memberId: r.id,
        name: r.display_name,
        isMe: r.id === ctx.access.memberId,
      })),
    }
  })
}

// ---------------------------------------------------------------------------------------------------
// What is owed
// ---------------------------------------------------------------------------------------------------

interface OwedRecord extends Record<string, unknown> {
  all_outstanding: string
  has_more: boolean
  party_id: string | null
  party_name: string
  party_key: string
  party_active: boolean
  party_outstanding: string
  invoice_count: number
  purchase_id: string
  business_date: string
  reference: string | null
  document_type: PayableGroupDto['invoices'][number]['documentType']
  item_names: string[]
  currency: string
  total: string
  returned: string
  paid: string
  outstanding: string
  entered_by_id: string | null
  entered_by_name: string | null
}

/** Sums of a purchase's final returns and credit notes, and of its payments that stand. */
const returnedOf = sql`coalesce((
  select sum(r.total) from app.purchase_returns r
   where r.business_id = p.business_id and r.purchase_id = p.id
     and r.status = 'posted' and r.deleted_at is null), 0)`
const paidOf = sql`coalesce((
  select sum(pp.amount) from app.purchase_payments pp
   where pp.business_id = p.business_id and pp.purchase_id = p.id
     and pp.reversed_at is null and pp.deleted_at is null), 0)`

/**
 * `payable.list`: the final purchases still owed to suppliers (bought on credit) or to members (paid
 * from their own money), grouped by supplier or member, by name, `limit` of them per page
 * (keyset on the lower-case name and the id). Each group lists its oldest PAYABLE_INVOICES_MAX
 * purchases still owed, with how many there are and what they all come to; `total` is what is owed
 * to every supplier or member. One statement, so a page and its totals are read at one moment;
 * returns and payments are summed once (grouped joins, not a query per purchase), and only the
 * purchases returned read their item names and who entered them.
 */
export function listPayables(ctx: BusinessCtx, input: ListInput): Promise<PayableListDto> {
  assertSeesAmounts(ctx)
  const bySupplier = input.party === 'supplier'
  const party = bySupplier
    ? sql`s.id as party_id, s.name as party_name, (s.archived_at is null) as party_active`
    : sql`pm.id as party_id, pm.display_name as party_name,
          (pm.status = 'active' and pm.deleted_at is null) as party_active`
  const join = bySupplier
    ? sql`join app.suppliers s on s.business_id = p.business_id and s.id = p.supplier_id`
    : sql`join app.business_members pm on pm.business_id = p.business_id and pm.id = p.paid_by_member_id`
  const method: PaymentMethod = bySupplier ? 'supplier_credit' : 'paid_by_member'
  const after = input.cursor ? decodeCursor(input.cursor) : null
  const afterCursor = after
    ? sql`where (lower(pa.party_name), pa.party_id) > (${after.key}, ${after.id}::uuid)`
    : sql``
  return ctx.tx(async (tx) => {
    const [business] = (await tx.execute(sql`
      select trim(b.currency) as currency from app.businesses b where b.id = ${ctx.businessId}
    `)) as unknown as { currency: string }[]
    const rows = (await tx.execute(sql`
      with owed as (
        select p.id as purchase_id, ${party}, p.business_id, p.created_by, p.created_at,
               p.business_date, p.reference, p.document_type, trim(p.currency) as currency,
               p.total as total_n, coalesce(r.returned, 0) as returned_n,
               coalesce(pp.paid, 0) as paid_n
          from app.purchases p
          ${join}
          left join (
            select r.purchase_id, sum(r.total) as returned from app.purchase_returns r
             where r.business_id = ${ctx.businessId} and r.status = 'posted'
               and r.deleted_at is null
             group by r.purchase_id
          ) r on r.purchase_id = p.id
          left join (
            select pp.purchase_id, sum(pp.amount) as paid from app.purchase_payments pp
             where pp.business_id = ${ctx.businessId} and pp.reversed_at is null
               and pp.deleted_at is null
             group by pp.purchase_id
          ) pp on pp.purchase_id = p.id
         where p.business_id = ${ctx.businessId} and p.deleted_at is null
           and p.status = 'posted' and p.payment_method = ${method}
           and p.total - coalesce(r.returned, 0) - coalesce(pp.paid, 0) > 0
      ),
      parties as (
        select o.party_id, o.party_name, o.party_active,
               sum(o.total_n - o.returned_n - o.paid_n) as outstanding_n,
               count(*)::int as invoice_count
          from owed o
         group by o.party_id, o.party_name, o.party_active
      ),
      page as (
        select pa.*, row_number() over (order by lower(pa.party_name), pa.party_id) as pn
          from parties pa
          ${afterCursor}
         order by lower(pa.party_name), pa.party_id
         limit ${input.limit + 1}
      ),
      ranked as (
        select o.*, row_number() over (
                 partition by o.party_id order by o.business_date, o.created_at, o.purchase_id
               ) as n
          from owed o
         where o.party_id in (select pg.party_id from page pg where pg.pn <= ${input.limit})
      )
      select trim_scale(t.all_outstanding)::text as all_outstanding, t.has_more, x.*
        from (
          select coalesce((select sum(pa.outstanding_n) from parties pa), 0) as all_outstanding,
                 (select count(*) from page) > ${input.limit} as has_more
        ) t
        left join lateral (
          select pg.party_id, pg.party_name, lower(pg.party_name) as party_key, pg.party_active, pg.pn,
                 trim_scale(pg.outstanding_n)::text as party_outstanding, pg.invoice_count,
                 o.purchase_id, o.business_date::text as business_date, o.reference,
                 o.document_type, o.currency, o.n,
                 trim_scale(o.total_n - o.returned_n - o.paid_n)::text as outstanding,
                 trim_scale(o.total_n)::text as total, trim_scale(o.returned_n)::text as returned,
                 trim_scale(o.paid_n)::text as paid,
                 array(select coalesce(l.description, '') from app.purchase_lines l
                        where l.business_id = o.business_id and l.purchase_id = o.purchase_id
                          and l.kind = 'material' and l.deleted_at is null
                        order by l.position, l.id
                        limit 2) as item_names,
                 eb.id as entered_by_id, eb.display_name as entered_by_name
            from page pg
            join ranked o on o.party_id = pg.party_id and o.n <= ${PAYABLE_INVOICES_MAX}
            left join app.business_members eb on eb.business_id = o.business_id and eb.id = (
              select m.id from app.business_members m
               where m.business_id = o.business_id and m.user_id = o.created_by
               order by (m.deleted_at is null) desc, m.created_at desc limit 1)
           where pg.pn <= ${input.limit}
        ) x on true
       order by x.pn, x.n
    `)) as unknown as OwedRecord[]
    const groups: PayableGroupDto[] = []
    for (const row of rows) {
      if (row.party_id === null) continue
      let group = groups.at(-1)
      if (!group || group.partyId !== row.party_id) {
        group = {
          party: input.party,
          partyId: row.party_id,
          name: row.party_name,
          active: row.party_active,
          outstanding: row.party_outstanding,
          invoiceCount: row.invoice_count,
          invoices: [],
        }
        groups.push(group)
      }
      group.invoices.push({
        purchaseId: row.purchase_id,
        businessDate: row.business_date,
        reference: row.reference,
        documentType: row.document_type,
        itemNames: row.item_names,
        currency: row.currency,
        total: row.total,
        returned: row.returned,
        paid: row.paid,
        outstanding: row.outstanding,
        enteredBy: { memberId: row.entered_by_id, name: row.entered_by_name },
      })
    }
    const last = rows.at(-1)
    return {
      data: {
        party: input.party,
        currency: business?.currency ?? '',
        total: rows[0]?.all_outstanding ?? '0',
        groups,
        nextCursor:
          rows[0]?.has_more && last?.party_id
            ? encodeCursor({ key: last.party_key, id: last.party_id })
            : null,
      },
      meta: { redacted: [] },
    }
  })
}

// ---------------------------------------------------------------------------------------------------
// A purchase's payments
// ---------------------------------------------------------------------------------------------------

interface HeadRecord extends Record<string, unknown> {
  id: string
  status: PurchasePaymentsDto['data']['status']
  business_date: string
  payment_method: PaymentMethod | null
  currency: string
  supplier_id: string | null
  supplier_name: string | null
  paid_by_member_id: string | null
  paid_by_member_name: string | null
  total: string
  returned: string
  paid: string
}

/**
 * Locks the purchase FOR UPDATE (NOT_FOUND when not live). A statement of its own: what is owed is
 * read after it, so it counts the payments, returns and credit notes committed while it waited.
 */
async function lockPurchase(tx: Tx, businessId: string, purchaseId: string) {
  const [row] = (await tx.execute(sql`
    select p.id from app.purchases p
     where p.business_id = ${businessId} and p.id = ${purchaseId} and p.deleted_at is null
       for update
  `)) as unknown as { id: string }[]
  if (!row) throw new AppError('not_found')
}

/** The purchase and what is owed on it (NOT_FOUND when not live). */
async function readHead(tx: Tx, businessId: string, purchaseId: string) {
  const [row] = (await tx.execute(sql`
    select p.id, p.status, p.business_date::text as business_date, p.payment_method,
           trim(p.currency) as currency, p.supplier_id, s.name as supplier_name,
           p.paid_by_member_id, pm.display_name as paid_by_member_name,
           trim_scale(p.total)::text as total, trim_scale(${returnedOf})::text as returned,
           trim_scale(${paidOf})::text as paid
      from app.purchases p
      left join app.suppliers s on s.business_id = p.business_id and s.id = p.supplier_id
      left join app.business_members pm
        on pm.business_id = p.business_id and pm.id = p.paid_by_member_id
     where p.business_id = ${businessId} and p.id = ${purchaseId} and p.deleted_at is null
  `)) as unknown as HeadRecord[]
  if (!row) throw new AppError('not_found')
  return row
}

/** What can still be paid on it: 0 unless it is final and owed. */
function outstandingOfHead(head: HeadRecord): string {
  if (head.status !== 'posted' || !isOwedPaymentMethod(head.payment_method)) return '0'
  return outstandingOf(head.total, head.returned, head.paid)
}

/** What was paid on it beyond what it came to after its returns (D-162): 0 unless owed. */
function overpaidOfHead(head: HeadRecord): string {
  if (!isOwedPaymentMethod(head.payment_method)) return '0'
  return overpaidOf(head.total, head.returned, head.paid)
}

interface PaymentRecord extends Record<string, unknown> {
  id: string
  business_date: string
  method: SettlementMethod
  amount: string
  currency: string
  note: string | null
  created_at: Date | string
  reversed_at: Date | string | null
  reversal_date: string | null
  recorded_by_id: string | null
  recorded_by_name: string | null
  reversed_by_id: string | null
  reversed_by_name: string | null
}

/** The purchase's payments and what is owed on it, as `purchasePayment.list` returns them. */
async function paymentsView(
  tx: Tx,
  businessId: string,
  purchaseId: string,
): Promise<PurchasePaymentsDto> {
  const head = await readHead(tx, businessId, purchaseId)
  const rows = (await tx.execute(sql`
    select p.id, p.business_date::text as business_date, p.method,
           trim_scale(p.amount)::text as amount, trim(p.currency) as currency, p.note, p.created_at,
           p.reversed_at, p.reversal_date::text as reversal_date,
           rb.id as recorded_by_id, rb.display_name as recorded_by_name,
           vb.id as reversed_by_id, vb.display_name as reversed_by_name
      from app.purchase_payments p
      left join app.business_members rb
        on rb.business_id = p.business_id and rb.id = ${memberByUser(sql.raw('p.created_by'))}
      left join app.business_members vb
        on vb.business_id = p.business_id and vb.id = ${memberByUser(sql.raw('p.reversed_by'))}
     where p.business_id = ${businessId} and p.purchase_id = ${purchaseId}
       and p.deleted_at is null
     order by p.business_date desc, p.created_at desc, p.id desc
  `)) as unknown as PaymentRecord[]
  const owedTo =
    head.payment_method === 'supplier_credit' && head.supplier_id !== null
      ? { party: 'supplier' as const, partyId: head.supplier_id, name: head.supplier_name ?? '' }
      : head.payment_method === 'paid_by_member' && head.paid_by_member_id !== null
        ? {
            party: 'member' as const,
            partyId: head.paid_by_member_id,
            name: head.paid_by_member_name ?? '',
          }
        : null
  return {
    data: {
      purchaseId: head.id,
      owedTo,
      status: head.status,
      currency: head.currency,
      total: head.total,
      returned: head.returned,
      paid: head.paid,
      outstanding: outstandingOfHead(head),
      overpaid: overpaidOfHead(head),
      payments: rows.map((r): PurchasePaymentDto => ({
        id: r.id,
        businessDate: r.business_date,
        method: r.method,
        amount: r.amount,
        currency: r.currency,
        note: r.note,
        status: r.reversed_at === null ? 'recorded' : 'reversed',
        recordedBy: { memberId: r.recorded_by_id, name: r.recorded_by_name },
        createdAt: isoOf(r.created_at),
        reversedAt: isoOf(r.reversed_at),
        reversedBy:
          r.reversed_at === null ? null : { memberId: r.reversed_by_id, name: r.reversed_by_name },
        reversalDate: r.reversal_date,
      })),
    },
    meta: { redacted: [] },
  }
}

/** `purchasePayment.list`: the payments of one purchase (reversed ones too) and what is owed on it. */
export function listPurchasePayments(
  ctx: BusinessCtx,
  input: PaymentsInput,
): Promise<PurchasePaymentsDto> {
  return ctx.tx((tx) => paymentsView(tx, ctx.businessId, input.purchaseId))
}

/**
 * `purchasePayment.record`: a payment of what is owed on a final purchase bought on credit or paid by
 * a member, idempotent on the client's id (the same payload again returns the purchase's payments; an
 * id used otherwise is CONFLICT). Refused: supplier prices hidden (FORBIDDEN), a draft or reversed
 * purchase (DOCUMENT_NOT_POSTED), one paid when bought (VALIDATION), a day after today (FUTURE_DATE),
 * on or before the books-closed date (BOOKS_CLOSED) or before the purchase (VALIDATION), more decimals
 * than the currency has (VALIDATION), more than is still owed (EXCEEDS_OUTSTANDING).
 */
export function recordPurchasePayment(
  ctx: BusinessCtx,
  input: RecordInput,
): Promise<PurchasePaymentsDto> {
  assertSeesAmounts(ctx)
  const { id, ...fields } = input
  const requestHash = requestHashOf(fields)
  return ctx.tx(async (tx) => {
    await lockPurchase(tx, ctx.businessId, input.purchaseId)
    const head = await readHead(tx, ctx.businessId, input.purchaseId)
    // The same payment again (a retry): answered before it is counted against itself.
    const [existing] = (await tx.execute(sql`
      select pp.purchase_id, pp.request_hash, pp.created_by = app.current_user_id() as mine
        from app.purchase_payments pp
       where pp.business_id = ${ctx.businessId} and pp.id = ${id}
    `)) as unknown as { purchase_id: string; request_hash: string | null; mine: boolean }[]
    if (existing) {
      if (existing.request_hash !== requestHash || !existing.mine) throw new AppError('conflict')
      return paymentsView(tx, ctx.businessId, input.purchaseId)
    }
    if (head.status !== 'posted') throw new AppError('document_not_posted')
    if (!isOwedPaymentMethod(head.payment_method)) {
      throw invalid('purchase: paid when bought, nothing is owed on it')
    }
    const business = await lockPostingBusiness(tx, ctx.businessId)
    assertPostable(business, input.businessDate)
    if (input.businessDate < head.business_date) {
      throw invalid('businessDate: before the purchase')
    }
    if (!isCurrencyCode(head.currency)) throw invalid(`currency: ${head.currency} is not supported`)
    if (!fitsCurrency(input.amount, head.currency)) {
      throw invalid('amount: more decimals than the currency has')
    }
    if (compareDecimal(input.amount, outstandingOfHead(head)) > 0) {
      throw new AppError('exceeds_outstanding')
    }
    await createIdempotent(tx, purchasePayments, {
      id,
      businessId: ctx.businessId,
      purchaseId: input.purchaseId,
      businessDate: input.businessDate,
      method: input.method,
      amount: input.amount,
      currency: head.currency,
      note: input.note,
      requestHash,
    })
    return paymentsView(tx, ctx.businessId, input.purchaseId)
  })
}

/**
 * `purchasePayment.reverse`: a payment recorded by mistake stops counting, dated its own day or the
 * first open day when the books are closed on it (BOOKS_CLOSED when that day is after today).
 * Idempotent: a reversed payment is returned as it is.
 */
export function reversePurchasePayment(
  ctx: BusinessCtx,
  input: ReverseInput,
): Promise<PurchasePaymentsDto> {
  return ctx.tx(async (tx) => {
    const [found] = (await tx.execute(sql`
      select pp.purchase_id from app.purchase_payments pp
       where pp.business_id = ${ctx.businessId} and pp.id = ${input.id} and pp.deleted_at is null
    `)) as unknown as { purchase_id: string }[]
    if (!found) throw new AppError('not_found')
    // The purchase first, as recording a payment and reversing the purchase lock it.
    await lockPurchase(tx, ctx.businessId, found.purchase_id)
    const [payment] = (await tx.execute(sql`
      select pp.business_date::text as business_date, pp.reversed_at
        from app.purchase_payments pp
       where pp.business_id = ${ctx.businessId} and pp.id = ${input.id}
         for update
    `)) as unknown as { business_date: string; reversed_at: Date | string | null }[]
    if (!payment) throw new AppError('not_found')
    if (payment.reversed_at === null) {
      const business = await lockPostingBusiness(tx, ctx.businessId)
      const reversalDate = reversalDateOf(business, payment.business_date)
      await tx.execute(sql`
        update app.purchase_payments
           set reversed_at = now(), reversed_by = app.current_user_id(),
               reversal_date = ${reversalDate}::date
         where business_id = ${ctx.businessId} and id = ${input.id}
      `)
    }
    return paymentsView(tx, ctx.businessId, found.purchase_id)
  })
}
