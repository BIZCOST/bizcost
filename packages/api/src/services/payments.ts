import {
  PAYABLE_INVOICES_MAX,
  type CustomerPaymentDto,
  type customerPaymentListInput,
  type CustomerPaymentListDto,
  type DocumentPaymentsDto,
  type ReceivableKindDto,
  type recordCustomerPaymentInput,
  type recordManyCustomerPaymentsInput,
  type RecordManyCustomerPaymentsDto,
  type reverseCustomerPaymentInput,
  type ExpensePaymentsDto,
  type expensePaymentsInput,
  type ExpenseStatusDto,
  type payableListInput,
  type PayableGroupDto,
  type PayableKindDto,
  type PayableListDto,
  type PurchasePayersDto,
  type PurchasePaymentDto,
  type purchasePaymentsInput,
  type PurchasePaymentsDto,
  type recordExpensePaymentInput,
  type recordPurchasePaymentInput,
  type reverseExpensePaymentInput,
  type reversePurchasePaymentInput,
} from '@bizcost/contracts'
import {
  createIdempotent,
  customerPayments,
  expensePayments,
  purchasePayments,
  type Tx,
} from '@bizcost/db'
import {
  compareDecimal,
  fitsCurrency,
  isCurrencyCode,
  isOwedPaymentMethod,
  netPaid,
  outstandingOf,
  overpaidOf,
  subtractDecimals,
  type PaymentKind,
  type DocumentStatus,
  type PaymentMethod,
  type SettlementMethod,
} from '@bizcost/domain'
import { sql, type SQL } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { assertQueryable } from '../trpc'
import { decodeCursor, encodeCursor, requestHashOf } from './catalog'
import { assertActivePayer } from './purchases'
import {
  owedDocumentOf,
  readObligation,
  readObligations,
  type ObligationRecord,
} from './receivables'
import { assertPostable, isoOf, lockPostingBusiness, reversalDateOf, uuidArray } from './stock'

// What the business still owes on its purchases and expenses, and paying it (the owner's requests of
// 2026-09-29, D-160; expenses from M2 Step 5, D-166). A final purchase or expense bought on credit
// (`supplier_credit`) is owed to its supplier; one a member paid from their own money
// (`paid_by_member`) is owed to that member. What is owed = its total, less its final returns and
// credit notes (purchases only; their totals), less the payments that stand (outstandingOf in
// @bizcost/domain; never below zero). One service for both kinds of document (DOCS below): the same
// rules, locks and answers; each kind has its own payments table (purchase_payments,
// expense_payments), its own module and keys (the routers check them). Every amount is
// `supplier_price`. Listing what is owed filters on amounts, and a payment is checked against what
// is owed, so both need supplier prices visible (FORBIDDEN otherwise, before anything is read).
//
// Locks: recording or reversing a payment locks its document FOR UPDATE first (then the business row
// FOR SHARE for the books-closed date), as a reversal of the document does; so a payment and the
// document's reversal, or two payments of one document, wait for each other, and a purchase's return
// or credit note (its purchase FOR SHARE) waits too. Payments are never edited or deleted (database
// triggers): one recorded by mistake is reversed and stops counting.

type ListInput = z.output<typeof payableListInput>
type PurchasePaymentsInput = z.output<typeof purchasePaymentsInput>
type RecordPurchaseInput = z.output<typeof recordPurchasePaymentInput>
type ReversePurchaseInput = z.output<typeof reversePurchasePaymentInput>
type ExpensePaymentsInput = z.output<typeof expensePaymentsInput>
type RecordExpenseInput = z.output<typeof recordExpensePaymentInput>
type ReverseExpenseInput = z.output<typeof reverseExpensePaymentInput>

const invalid = (message: string) => new AppError('validation', { message })

/** A kind of document that can be owed, and where its rows and payments live. */
interface PayableDoc {
  readonly kind: PayableKindDto
  /** The document table (aliased `d` in the statements below). */
  readonly table: SQL
  /** Its payments table and the column that names the document. */
  readonly payments: SQL
  readonly fk: SQL
  /** Σ totals of the document's final returns and credit notes (purchases only), for alias `d`. */
  readonly returned: SQL
  /** Its payments have a kind (purchases: payments and money back from the supplier, Q18). */
  readonly kinds: boolean
}

const DOCS: Readonly<Record<PayableKindDto, PayableDoc>> = {
  purchase: {
    kind: 'purchase',
    table: sql.raw('app.purchases'),
    payments: sql.raw('app.purchase_payments'),
    fk: sql.raw('purchase_id'),
    returned: sql`coalesce((
      select sum(r.total) from app.purchase_returns r
       where r.business_id = d.business_id and r.purchase_id = d.id
         and r.status = 'posted' and r.deleted_at is null), 0)`,
    kinds: true,
  },
  expense: {
    kind: 'expense',
    table: sql.raw('app.expenses'),
    payments: sql.raw('app.expense_payments'),
    fk: sql.raw('expense_id'),
    returned: sql`0::numeric`,
    kinds: false,
  },
}

/** Listing what is owed or paying it reads amounts the caller must be allowed to see. */
function assertSeesAmounts(ctx: BusinessCtx) {
  assertQueryable(ctx, [{ name: 'outstanding', category: 'supplier_price' }])
}

/** A member of the business by an auth user id (the newest membership), as `memberNameDto`. */
const memberByUser = (userColumn: SQL) => sql`
  (select m.id from app.business_members m
    where m.business_id = p.business_id and m.user_id = ${userColumn}
    order by (m.deleted_at is null) desc, m.created_at desc limit 1)`

// ---------------------------------------------------------------------------------------------------
// Who may have paid
// ---------------------------------------------------------------------------------------------------

/**
 * `purchase.payers`, `expense.payers`: the active members of the business, by name; the caller is
 * `isMe`.
 */
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
  all_money_back: string
  party_money_back: string
  party_owed_after: string
  has_more: boolean
  party_id: string | null
  party_name: string
  party_key: string
  party_active: boolean
  party_outstanding: string
  invoice_count: number
  kind: PayableKindDto
  /** Null for a member listed only for the money back they received. */
  document_id: string | null
  business_date: string
  reference: string | null
  document_type: PayableGroupDto['invoices'][number]['documentType']
  item_names: string[]
  category_name: string | null
  currency: string
  total: string
  returned: string
  paid: string
  outstanding: string
  entered_by_id: string | null
  entered_by_name: string | null
}

/**
 * The final documents of `kinds` bought with `method`, with what their returns and payments that
 * stand come to: one row per document (returns and payments summed once, in grouped joins). A
 * document is joined to its own kind's returns and payments only (a purchase and an expense may
 * share an id: ids are unique per table).
 */
function owedDocuments(
  businessId: string,
  kinds: readonly PayableKindDto[],
  method: PaymentMethod,
) {
  const parts: SQL[] = []
  if (kinds.includes('purchase')) {
    parts.push(sql`
      select 'purchase'::text as kind, p.id as document_id, p.business_id, p.supplier_id,
             p.paid_by_member_id, p.created_by, p.created_at, p.business_date, p.reference,
             p.document_type, trim(p.currency) as currency, null::text as category_name,
             null::text as description,
             p.total as total_n, coalesce(r.returned, 0) as returned_n,
             coalesce(pp.paid, 0) as paid_n
        from app.purchases p
        left join (
          select r.purchase_id, sum(r.total) as returned from app.purchase_returns r
           where r.business_id = ${businessId} and r.status = 'posted' and r.deleted_at is null
           group by r.purchase_id
        ) r on r.purchase_id = p.id
        left join (
          -- Net of the money back from the supplier (Q18).
          select pp.purchase_id,
                 sum(case pp.kind when 'refund' then -pp.amount else pp.amount end) as paid
            from app.purchase_payments pp
           where pp.business_id = ${businessId} and pp.reversed_at is null
             and pp.deleted_at is null
           group by pp.purchase_id
        ) pp on pp.purchase_id = p.id
       where p.business_id = ${businessId} and p.deleted_at is null
         and p.status = 'posted' and p.payment_method = ${method}`)
  }
  if (kinds.includes('expense')) {
    parts.push(sql`
      select 'expense'::text as kind, e.id as document_id, e.business_id, e.supplier_id,
             e.paid_by_member_id, e.created_by, e.created_at, e.business_date, e.reference,
             e.document_type, trim(e.currency) as currency, c.name as category_name,
             e.description,
             e.total as total_n, 0::numeric as returned_n, coalesce(ep.paid, 0) as paid_n
        from app.expenses e
        join app.cost_categories c on c.business_id = e.business_id and c.id = e.category_id
        left join (
          select ep.expense_id, sum(ep.amount) as paid from app.expense_payments ep
           where ep.business_id = ${businessId} and ep.reversed_at is null
             and ep.deleted_at is null
           group by ep.expense_id
        ) ep on ep.expense_id = e.id
       where e.business_id = ${businessId} and e.deleted_at is null
         and e.status = 'posted' and e.payment_method = ${method}`)
  }
  return sql.join(parts, sql` union all `)
}

/**
 * `payable.list`: the final purchases and expenses still owed to suppliers (bought on credit) or to
 * members (paid from their own money), grouped by supplier or member, by name, `limit` of them per
 * page (keyset on the lower-case name and the id). `kinds` are the documents the caller may see the
 * payments of (the router works them out: purchases with purchases.payments.view and Purchases on,
 * expenses with expenses.payments.view and Expenses on). Each group lists its oldest
 * PAYABLE_INVOICES_MAX documents still owed, with how many there are and what they all come to;
 * `total` is what is owed to every supplier or member. One statement, so a page and its totals are
 * read at one moment; only the documents returned read their item names and who entered them.
 */
export function listPayables(
  ctx: BusinessCtx,
  input: ListInput,
  kinds: readonly PayableKindDto[],
): Promise<PayableListDto> {
  assertSeesAmounts(ctx)
  const bySupplier = input.party === 'supplier'
  const party = bySupplier
    ? sql`s.id as party_id, s.name as party_name, (s.archived_at is null) as party_active`
    : sql`pm.id as party_id, pm.display_name as party_name,
          (pm.status = 'active' and pm.deleted_at is null) as party_active`
  const join = bySupplier
    ? sql`join app.suppliers s on s.business_id = d.business_id and s.id = d.supplier_id`
    : sql`join app.business_members pm on pm.business_id = d.business_id and pm.id = d.paid_by_member_id`
  const method: PaymentMethod = bySupplier ? 'supplier_credit' : 'paid_by_member'
  const after = input.cursor ? decodeCursor(input.cursor) : null
  const afterCursor = after
    ? sql`where (lower(pa.party_name), pa.party_id) > (${after.key}, ${after.id}::uuid)`
    : sql``
  return ctx.tx(async (tx) => {
    const [business] = (await tx.execute(sql`
      select trim(b.currency) as currency from app.businesses b where b.id = ${ctx.businessId}
    `)) as unknown as { currency: string }[]
    const empty = (): PayableListDto => ({
      data: {
        party: input.party,
        currency: business?.currency ?? '',
        total: '0',
        moneyBackTotal: '0',
        groups: [],
        nextCursor: null,
      },
      meta: { redacted: [] },
    })
    if (kinds.length === 0) return empty()
    // Members: the money back from suppliers they received for the business (Q18), which counts
    // against what it owes them (D-181); listed even when nothing else is owed to them.
    const back =
      !bySupplier && kinds.includes('purchase')
        ? sql`select pm.id as party_id, pm.display_name as party_name,
                  (pm.status = 'active' and pm.deleted_at is null) as party_active,
                  sum(pp.amount) as money_back_n
             from app.purchase_payments pp
             join app.business_members pm
               on pm.business_id = pp.business_id and pm.id = pp.received_by_member_id
            where pp.business_id = ${ctx.businessId} and pp.kind = 'refund'
              and pp.reversed_at is null and pp.deleted_at is null
            group by pm.id, pm.display_name, pm.status, pm.deleted_at`
        : sql`select null::uuid as party_id, null::text as party_name, null::boolean as party_active,
                  0::numeric as money_back_n
            where false`
    const rows = (await tx.execute(sql`
      with owed as (
        select d.*, ${party}
          from (${owedDocuments(ctx.businessId, kinds, method)}) d
          ${join}
         where d.total_n - d.returned_n - d.paid_n > 0
      ),
      owed_parties as (
        select o.party_id, o.party_name, o.party_active,
               sum(o.total_n - o.returned_n - o.paid_n) as outstanding_n,
               count(*)::int as invoice_count
          from owed o
         group by o.party_id, o.party_name, o.party_active
      ),
      back as (${back}),
      parties as (
        select coalesce(o.party_id, b.party_id) as party_id,
               coalesce(o.party_name, b.party_name) as party_name,
               coalesce(o.party_active, b.party_active) as party_active,
               coalesce(o.outstanding_n, 0) as outstanding_n,
               coalesce(o.invoice_count, 0) as invoice_count,
               coalesce(b.money_back_n, 0) as money_back_n
          from owed_parties o
          full join back b on b.party_id = o.party_id
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
                 partition by o.party_id
                 order by o.business_date, o.created_at, o.kind, o.document_id
               ) as n
          from owed o
         where o.party_id in (select pg.party_id from page pg where pg.pn <= ${input.limit})
      )
      select trim_scale(t.all_outstanding)::text as all_outstanding,
             trim_scale(t.all_money_back)::text as all_money_back, t.has_more, x.*
        from (
          select coalesce((select sum(pa.outstanding_n) from parties pa), 0) as all_outstanding,
                 coalesce((select sum(pa.money_back_n) from parties pa), 0) as all_money_back,
                 (select count(*) from page) > ${input.limit} as has_more
        ) t
        left join lateral (
          select pg.party_id, pg.party_name, lower(pg.party_name) as party_key, pg.party_active, pg.pn,
                 trim_scale(pg.outstanding_n)::text as party_outstanding, pg.invoice_count,
                 trim_scale(pg.money_back_n)::text as party_money_back,
                 trim_scale(pg.outstanding_n - pg.money_back_n)::text as party_owed_after,
                 o.kind, o.document_id, o.business_date::text as business_date, o.reference,
                 o.document_type, o.currency, o.category_name, o.n,
                 trim_scale(o.total_n - o.returned_n - o.paid_n)::text as outstanding,
                 trim_scale(o.total_n)::text as total, trim_scale(o.returned_n)::text as returned,
                 trim_scale(o.paid_n)::text as paid,
                 case o.kind
                   when 'purchase' then array(
                     select coalesce(l.description, '') from app.purchase_lines l
                      where l.business_id = o.business_id and l.purchase_id = o.document_id
                        and l.kind = 'material' and l.deleted_at is null
                      order by l.position, l.id
                      limit 2)
                   else array_remove(array[o.description], null)
                 end as item_names,
                 eb.id as entered_by_id, eb.display_name as entered_by_name
            from page pg
            left join ranked o on o.party_id = pg.party_id and o.n <= ${PAYABLE_INVOICES_MAX}
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
          moneyBack: row.party_money_back,
          owedAfterMoneyBack: row.party_owed_after,
          invoices: [],
        }
        groups.push(group)
      }
      // A member with only money back to show has no document.
      if (row.document_id === null) continue
      group.invoices.push({
        kind: row.kind,
        documentId: row.document_id,
        businessDate: row.business_date,
        reference: row.reference,
        documentType: row.document_type,
        itemNames: row.item_names,
        categoryName: row.category_name,
        currency: row.currency,
        total: row.total,
        returned: row.returned,
        paid: row.paid,
        outstanding: row.outstanding,
        enteredBy: { memberId: row.entered_by_id, name: row.entered_by_name },
      })
    }
    const last = rows.at(-1)
    if (rows.length === 0) return empty()
    return {
      data: {
        party: input.party,
        currency: business?.currency ?? '',
        total: rows[0]?.all_outstanding ?? '0',
        moneyBackTotal: rows[0]?.all_money_back ?? '0',
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
// A document's payments
// ---------------------------------------------------------------------------------------------------

interface HeadRecord extends Record<string, unknown> {
  id: string
  status: string
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
  money_back: string
}

/**
 * Locks the document FOR UPDATE (NOT_FOUND when not live). A statement of its own: what is owed is
 * read after it, so it counts the payments, returns and credit notes committed while it waited.
 */
async function lockDocument(tx: Tx, doc: PayableDoc, businessId: string, id: string) {
  const [row] = (await tx.execute(sql`
    select d.id from ${doc.table} d
     where d.business_id = ${businessId} and d.id = ${id} and d.deleted_at is null
       for update
  `)) as unknown as { id: string }[]
  if (!row) throw new AppError('not_found')
}

/** The document and what is owed on it (NOT_FOUND when not live). */
async function readHead(tx: Tx, doc: PayableDoc, businessId: string, id: string) {
  const [row] = (await tx.execute(sql`
    select d.id, d.status, d.business_date::text as business_date, d.payment_method,
           trim(d.currency) as currency, d.supplier_id, s.name as supplier_name,
           d.paid_by_member_id, pm.display_name as paid_by_member_name,
           trim_scale(d.total)::text as total, trim_scale(${doc.returned})::text as returned,
           trim_scale(coalesce((
             select sum(pp.amount) from ${doc.payments} pp
              where pp.business_id = d.business_id and pp.${doc.fk} = d.id
                and pp.reversed_at is null and pp.deleted_at is null
                ${doc.kinds ? sql`and pp.kind = 'payment'` : sql``}), 0))::text as paid,
           ${
             doc.kinds
               ? sql`trim_scale(coalesce((
                   select sum(pp.amount) from ${doc.payments} pp
                    where pp.business_id = d.business_id and pp.${doc.fk} = d.id
                      and pp.kind = 'refund' and pp.reversed_at is null and pp.deleted_at is null),
                   0))::text`
               : sql`'0'`
           } as money_back
      from ${doc.table} d
      left join app.suppliers s on s.business_id = d.business_id and s.id = d.supplier_id
      left join app.business_members pm
        on pm.business_id = d.business_id and pm.id = d.paid_by_member_id
     where d.business_id = ${businessId} and d.id = ${id} and d.deleted_at is null
  `)) as unknown as HeadRecord[]
  if (!row) throw new AppError('not_found')
  return row
}

/** What can still be paid on it: 0 unless it is final and owed (net of money back, Q18). */
function outstandingOfHead(head: HeadRecord): string {
  if (head.status !== 'posted' || !isOwedPaymentMethod(head.payment_method)) return '0'
  return outstandingOf(head.total, head.returned, netPaid(head.paid, head.money_back))
}

/**
 * What was paid on it beyond what it came to after its returns (D-162), less the money back from the
 * supplier recorded on it (Q18): 0 unless owed.
 */
function overpaidOfHead(head: HeadRecord): string {
  if (!isOwedPaymentMethod(head.payment_method)) return '0'
  return overpaidOf(head.total, head.returned, netPaid(head.paid, head.money_back))
}

interface PaymentRecord extends Record<string, unknown> {
  id: string
  kind: PaymentKind
  received_by_id: string | null
  received_by_name: string | null
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

/** A document's payments and what is owed on it, before each kind names its document. */
interface PaymentsView {
  readonly documentId: string
  readonly status: string
  readonly data: Omit<PurchasePaymentsDto['data'], 'purchaseId' | 'status'>
}

async function paymentsView(
  tx: Tx,
  doc: PayableDoc,
  businessId: string,
  id: string,
): Promise<PaymentsView> {
  const head = await readHead(tx, doc, businessId, id)
  const rows = (await tx.execute(sql`
    select p.id, ${doc.kinds ? sql`p.kind` : sql`'payment'::text as kind`},
           ${doc.kinds ? sql`p.received_by_member_id` : sql`null::uuid`} as received_by_id,
           (select m.display_name from app.business_members m
             where m.business_id = p.business_id
               and m.id = ${doc.kinds ? sql`p.received_by_member_id` : sql`null::uuid`})
             as received_by_name,
           p.business_date::text as business_date, p.method,
           trim_scale(p.amount)::text as amount, trim(p.currency) as currency, p.note, p.created_at,
           p.reversed_at, p.reversal_date::text as reversal_date,
           rb.id as recorded_by_id, rb.display_name as recorded_by_name,
           vb.id as reversed_by_id, vb.display_name as reversed_by_name
      from ${doc.payments} p
      left join app.business_members rb
        on rb.business_id = p.business_id and rb.id = ${memberByUser(sql.raw('p.created_by'))}
      left join app.business_members vb
        on vb.business_id = p.business_id and vb.id = ${memberByUser(sql.raw('p.reversed_by'))}
     where p.business_id = ${businessId} and p.${doc.fk} = ${id}
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
    documentId: head.id,
    status: head.status,
    data: {
      owedTo,
      currency: head.currency,
      total: head.total,
      returned: head.returned,
      paid: head.paid,
      moneyBack: head.money_back,
      outstanding: outstandingOfHead(head),
      overpaid: overpaidOfHead(head),
      payments: rows.map((r): PurchasePaymentDto => ({
        id: r.id,
        kind: r.kind,
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
        receivedBy:
          r.kind === 'refund' && r.received_by_id !== null
            ? { memberId: r.received_by_id, name: r.received_by_name }
            : null,
      })),
    },
  }
}

interface PaymentFields {
  readonly id: string
  readonly businessDate: string
  readonly method: SettlementMethod
  readonly amount: string
  readonly note: string | null
  /** Purchases: money back from the supplier (Q18), and who received it (null: the business). */
  readonly kind?: PaymentKind
  readonly receivedByMemberId?: string | null
}

/**
 * Records a payment of what is owed on a final document bought on credit or paid by a member,
 * idempotent on the client's id (the same payload again returns the document's payments; an id used
 * otherwise is CONFLICT). Refused: supplier prices hidden (FORBIDDEN), a document not posted
 * (DOCUMENT_NOT_POSTED), one paid when bought (VALIDATION), a day after today (FUTURE_DATE), on or
 * before the books-closed date (BOOKS_CLOSED) or before the document (VALIDATION), more decimals than
 * the currency has (VALIDATION), more than is still owed (EXCEEDS_OUTSTANDING).
 */
function recordPayment(
  ctx: BusinessCtx,
  doc: PayableDoc,
  documentId: string,
  input: PaymentFields,
): Promise<PaymentsView> {
  assertSeesAmounts(ctx)
  const { id, kind = 'payment', receivedByMemberId = null, ...rest } = input
  if (kind === 'refund' && !doc.kinds) throw invalid(`kind: no money back on an ${doc.kind}`)
  // The fingerprint of purchase payments is as it was (their document named purchaseId); money back
  // also says its kind and who received it.
  const requestHash = requestHashOf(
    doc.kind === 'purchase'
      ? kind === 'refund'
        ? { purchaseId: documentId, ...rest, kind, receivedByMemberId }
        : { purchaseId: documentId, ...rest }
      : { expenseId: documentId, ...rest },
  )
  return ctx.tx(async (tx) => {
    await lockDocument(tx, doc, ctx.businessId, documentId)
    const head = await readHead(tx, doc, ctx.businessId, documentId)
    // The same payment again (a retry): answered before it is counted against itself.
    const [existing] = (await tx.execute(sql`
      select pp.request_hash, pp.created_by = app.current_user_id() as mine
        from ${doc.payments} pp
       where pp.business_id = ${ctx.businessId} and pp.id = ${id}
    `)) as unknown as { request_hash: string | null; mine: boolean }[]
    if (existing) {
      if (existing.request_hash !== requestHash || !existing.mine) throw new AppError('conflict')
      return paymentsView(tx, doc, ctx.businessId, documentId)
    }
    if (head.status !== 'posted') throw new AppError('document_not_posted')
    if (!isOwedPaymentMethod(head.payment_method)) {
      throw invalid(`${doc.kind}: paid when bought, nothing is owed on it`)
    }
    const business = await lockPostingBusiness(tx, ctx.businessId)
    assertPostable(business, input.businessDate)
    if (input.businessDate < head.business_date) {
      throw invalid(`businessDate: before the ${doc.kind}`)
    }
    if (!isCurrencyCode(head.currency)) throw invalid(`currency: ${head.currency} is not supported`)
    if (!fitsCurrency(input.amount, head.currency)) {
      throw invalid('amount: more decimals than the currency has')
    }
    if (kind === 'refund') {
      // Money back from the supplier settles what was paid beyond (D-162), never more (Q18); a member
      // who received it is an active member (it lowers what the business owes them, D-181).
      if (compareDecimal(input.amount, overpaidOfHead(head)) > 0) {
        throw new AppError('exceeds_outstanding')
      }
      if (receivedByMemberId !== null) {
        await assertActivePayer(tx, ctx.businessId, receivedByMemberId)
      }
    } else if (compareDecimal(input.amount, outstandingOfHead(head)) > 0) {
      throw new AppError('exceeds_outstanding')
    }
    const common = {
      id,
      businessId: ctx.businessId,
      businessDate: input.businessDate,
      method: input.method,
      amount: input.amount,
      currency: head.currency,
      note: input.note,
      requestHash,
    }
    if (doc.kind === 'purchase') {
      await createIdempotent(tx, purchasePayments, {
        ...common,
        purchaseId: documentId,
        kind,
        receivedByMemberId,
      })
    } else {
      await createIdempotent(tx, expensePayments, { ...common, expenseId: documentId })
    }
    return paymentsView(tx, doc, ctx.businessId, documentId)
  })
}

/**
 * A payment recorded by mistake stops counting, dated its own day or the first open day when the
 * books are closed on it (BOOKS_CLOSED when that day is after today). Idempotent: a reversed payment
 * is returned as it is.
 */
function reversePayment(ctx: BusinessCtx, doc: PayableDoc, id: string): Promise<PaymentsView> {
  return ctx.tx(async (tx) => {
    const [found] = (await tx.execute(sql`
      select pp.${doc.fk} as document_id from ${doc.payments} pp
       where pp.business_id = ${ctx.businessId} and pp.id = ${id} and pp.deleted_at is null
    `)) as unknown as { document_id: string }[]
    if (!found) throw new AppError('not_found')
    // The document first, as recording a payment and reversing the document lock it.
    await lockDocument(tx, doc, ctx.businessId, found.document_id)
    const [payment] = (await tx.execute(sql`
      select pp.business_date::text as business_date, pp.reversed_at
        from ${doc.payments} pp
       where pp.business_id = ${ctx.businessId} and pp.id = ${id}
         for update
    `)) as unknown as { business_date: string; reversed_at: Date | string | null }[]
    if (!payment) throw new AppError('not_found')
    if (payment.reversed_at === null) {
      const business = await lockPostingBusiness(tx, ctx.businessId)
      const reversalDate = reversalDateOf(business, payment.business_date)
      await tx.execute(sql`
        update ${doc.payments}
           set reversed_at = now(), reversed_by = app.current_user_id(),
               reversal_date = ${reversalDate}::date
         where business_id = ${ctx.businessId} and id = ${id}
      `)
    }
    return paymentsView(tx, doc, ctx.businessId, found.document_id)
  })
}

// ---------------------------------------------------------------------------------------------------
// Purchases (purchasePayment.*) and expenses (expensePayment.*)
// ---------------------------------------------------------------------------------------------------

function purchaseResult(view: PaymentsView): PurchasePaymentsDto {
  return {
    data: { purchaseId: view.documentId, status: view.status as DocumentStatus, ...view.data },
    meta: { redacted: [] },
  }
}

function expenseResult(view: PaymentsView): ExpensePaymentsDto {
  return {
    data: { expenseId: view.documentId, status: view.status as ExpenseStatusDto, ...view.data },
    meta: { redacted: [] },
  }
}

/** `purchasePayment.list`: the payments of one purchase (reversed ones too) and what is owed on it. */
export async function listPurchasePayments(
  ctx: BusinessCtx,
  input: PurchasePaymentsInput,
): Promise<PurchasePaymentsDto> {
  return purchaseResult(
    await ctx.tx((tx) => paymentsView(tx, DOCS.purchase, ctx.businessId, input.purchaseId)),
  )
}

/** `purchasePayment.record`: see recordPayment. */
export async function recordPurchasePayment(
  ctx: BusinessCtx,
  input: RecordPurchaseInput,
): Promise<PurchasePaymentsDto> {
  const { purchaseId, ...fields } = input
  return purchaseResult(await recordPayment(ctx, DOCS.purchase, purchaseId, fields))
}

/** `purchasePayment.reverse`: see reversePayment. */
export async function reversePurchasePayment(
  ctx: BusinessCtx,
  input: ReversePurchaseInput,
): Promise<PurchasePaymentsDto> {
  return purchaseResult(await reversePayment(ctx, DOCS.purchase, input.id))
}

/** `expensePayment.list`: the payments of one expense (reversed ones too) and what is owed on it. */
export async function listExpensePayments(
  ctx: BusinessCtx,
  input: ExpensePaymentsInput,
): Promise<ExpensePaymentsDto> {
  return expenseResult(
    await ctx.tx((tx) => paymentsView(tx, DOCS.expense, ctx.businessId, input.expenseId)),
  )
}

/** `expensePayment.record`: see recordPayment. */
export async function recordExpensePayment(
  ctx: BusinessCtx,
  input: RecordExpenseInput,
): Promise<ExpensePaymentsDto> {
  const { expenseId, ...fields } = input
  return expenseResult(await recordPayment(ctx, DOCS.expense, expenseId, fields))
}

/** `expensePayment.reverse`: see reversePayment. */
export async function reverseExpensePayment(
  ctx: BusinessCtx,
  input: ReverseExpenseInput,
): Promise<ExpensePaymentsDto> {
  return expenseResult(await reversePayment(ctx, DOCS.expense, input.id))
}

// ---------------------------------------------------------------------------------------------------
// Customer payments (M3 Step 5; the owner's answer Q17 = A of D-218): on an order or a sale "they'll
// pay later", as above (D-159, D-160): the method required, never edited (a mistake is reversed),
// idempotent on the client's id, never more than is owed (EXCEEDS_OUTSTANDING), money given back never
// more than was paid beyond. What is owed comes from receivables.ts (one figure per obligation, A2).
//
// Locks: recording or reversing a customer payment locks its order or sale FOR UPDATE first (lock 1),
// then the business row FOR SHARE: the same order as an order's delivery, undo and refunds (the order,
// then its sale) and a sale's refunds and reversal (the sale), so a payment, a delivery, a refund and a
// cancel of one order wait for each other and each reads what the one before committed. "Pay several
// at once" locks its documents in one order (orders by id, then sales by id) before the business row.
// Customer payments are sales amounts, not a redaction category: who sees them is the key
// payments.customers.view, and who records them payments.customers.record (the routers check them).
// ---------------------------------------------------------------------------------------------------

type CustomerListInput = z.output<typeof customerPaymentListInput>
type RecordCustomerInput = z.output<typeof recordCustomerPaymentInput>
type ReverseCustomerInput = z.output<typeof reverseCustomerPaymentInput>
type RecordManyInput = z.output<typeof recordManyCustomerPaymentsInput>

/** What a customer payment names, and where its rows live. */
const RECEIVABLE_TABLES: Readonly<Record<ReceivableKindDto, SQL>> = {
  order: sql.raw('app.orders'),
  sale: sql.raw('app.sales'),
}

/** The branches the caller may see (Q12): a document of another branch is NOT_FOUND. */
function inScope(ctx: BusinessCtx, alias: string): SQL {
  const scope = ctx.access.locationScope
  return scope.all
    ? sql`true`
    : sql`${sql.raw(alias)}.location_id = any(${uuidArray([...scope.ids])})`
}

export interface ReceivableHead extends Record<string, unknown> {
  id: string
  status: string
  source: string | null
  pay_later: boolean | null
  business_date: string
  customer_id: string | null
  currency: string
}

/**
 * Locks an order or a sale FOR UPDATE (lock 1) and reads it: NOT_FOUND unless a live one of the
 * business in the caller's branches. A new statement after it reads what was committed meanwhile.
 */
export async function lockReceivable(
  tx: Tx,
  ctx: BusinessCtx,
  kind: ReceivableKindDto,
  id: string,
): Promise<ReceivableHead> {
  const [row] = (await tx.execute(sql`
    select d.id from ${RECEIVABLE_TABLES[kind]} d
     where d.business_id = ${ctx.businessId} and d.id = ${id} and d.deleted_at is null
       and ${inScope(ctx, 'd')}
       for update
  `)) as unknown as { id: string }[]
  if (!row) throw new AppError('not_found')
  const [head] = (await tx.execute(
    kind === 'order'
      ? sql`select o.id, o.status, null::text as source, null::boolean as pay_later,
                   o.business_date::text as business_date, o.customer_id, trim(o.currency) as currency
              from app.orders o where o.business_id = ${ctx.businessId} and o.id = ${id}`
      : sql`select s.id, s.status, s.source, s.pay_later, s.business_date::text as business_date,
                   s.customer_id, trim(s.currency) as currency
              from app.sales s where s.business_id = ${ctx.businessId} and s.id = ${id}`,
  )) as unknown as ReceivableHead[]
  if (!head) throw new AppError('not_found')
  return head
}

/**
 * What a payment may be recorded on: a pending or delivered order (money given back on a cancelled
 * one too: its deposit), or a finalized One sale "they'll pay later". DOCUMENT_NOT_POSTED for a draft,
 * ORDER_CANCELLED for a payment on a cancelled order, VALIDATION for a sale paid when made (or an
 * order's sale or a refund: their order or sale is paid).
 */
function assertPayable(kind: ReceivableKindDto, head: ReceivableHead, payment: PaymentKind): void {
  if (kind === 'order') {
    if (head.status === 'cancelled' && payment === 'payment') throw new AppError('order_cancelled')
    return
  }
  if (head.status === 'draft') throw new AppError('document_not_posted')
  if (head.source !== 'single' || head.pay_later !== true) {
    throw invalid('saleId: paid when made, or paid through its order')
  }
  if (head.status !== 'posted') throw new AppError('document_not_posted')
}

interface CustomerPaymentRecord extends Record<string, unknown> {
  id: string
  kind: PaymentKind
  customer_id: string | null
  customer_name: string | null
  order_id: string | null
  sale_id: string | null
  order_number: string | null
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

const CUSTOMER_PAYMENT_COLUMNS = sql`p.id, p.kind, p.customer_id, cu.name as customer_name,
  p.order_id, p.sale_id, o.number as order_number, p.business_date::text as business_date, p.method,
  trim_scale(p.amount)::text as amount, trim(p.currency) as currency, p.note, p.created_at,
  p.reversed_at, p.reversal_date::text as reversal_date,
  rb.id as recorded_by_id, rb.display_name as recorded_by_name,
  vb.id as reversed_by_id, vb.display_name as reversed_by_name`

const CUSTOMER_PAYMENT_JOINS = sql`
  left join app.customers cu on cu.business_id = p.business_id and cu.id = p.customer_id
  left join app.orders o on o.business_id = p.business_id and o.id = p.order_id
  left join app.business_members rb on rb.business_id = p.business_id and rb.id = (
    select m.id from app.business_members m
     where m.business_id = p.business_id and m.user_id = p.created_by
     order by (m.deleted_at is null) desc, m.created_at desc limit 1)
  left join app.business_members vb on vb.business_id = p.business_id and vb.id = (
    select m.id from app.business_members m
     where m.business_id = p.business_id and m.user_id = p.reversed_by
     order by (m.deleted_at is null) desc, m.created_at desc limit 1)`

function customerPaymentOf(r: CustomerPaymentRecord): CustomerPaymentDto {
  return {
    id: r.id,
    kind: r.kind,
    customerId: r.customer_id,
    customerName: r.customer_name,
    documentKind: r.order_id !== null ? 'order' : 'sale',
    documentId: r.order_id ?? r.sale_id ?? '',
    documentNumber: r.order_number,
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
  }
}

/** The payments of one order or sale (reversed ones too), newest first. */
export async function paymentsOfDocument(
  tx: Tx,
  businessId: string,
  kind: ReceivableKindDto,
  id: string,
): Promise<CustomerPaymentDto[]> {
  const rows = (await tx.execute(sql`
    select ${CUSTOMER_PAYMENT_COLUMNS}
      from app.customer_payments p
      ${CUSTOMER_PAYMENT_JOINS}
     where p.business_id = ${businessId} and p.deleted_at is null
       and ${kind === 'order' ? sql`p.order_id = ${id}` : sql`p.sale_id = ${id}`}
     order by p.business_date desc, p.created_at desc, p.id desc
  `)) as unknown as CustomerPaymentRecord[]
  return rows.map(customerPaymentOf)
}

/** The document, what it is owed, and its payments (NOT_FOUND: not an obligation). */
async function documentPayments(
  tx: Tx,
  businessId: string,
  kind: ReceivableKindDto,
  id: string,
): Promise<DocumentPaymentsDto> {
  const obligation = await readObligation(tx, businessId, kind, id)
  if (!obligation) throw new AppError('not_found')
  return {
    document: owedDocumentOf(obligation),
    items: await paymentsOfDocument(tx, businessId, kind, id),
  }
}

/** Which document an input names. */
function documentOf(input: { orderId?: string | undefined; saleId?: string | undefined }) {
  return input.orderId !== undefined
    ? { kind: 'order' as const, id: input.orderId }
    : { kind: 'sale' as const, id: input.saleId ?? '' }
}

/**
 * `customerPayment.list` (payments.customers.view): the payments of an order or a sale "they'll pay
 * later" with what it is owed, or a customer's payments a page at a time (newest first).
 */
export function listCustomerPayments(
  ctx: BusinessCtx,
  input: CustomerListInput,
): Promise<CustomerPaymentListDto> {
  return ctx.tx(async (tx) => {
    if (input.customerId === undefined) {
      const { kind, id } = documentOf(input)
      const [visible] = (await tx.execute(sql`
        select d.id from ${RECEIVABLE_TABLES[kind]} d
         where d.business_id = ${ctx.businessId} and d.id = ${id} and d.deleted_at is null
           and ${inScope(ctx, 'd')}
      `)) as unknown as { id: string }[]
      if (!visible) throw new AppError('not_found')
      const view = await documentPayments(tx, ctx.businessId, kind, id)
      return { document: view.document, items: view.items, nextCursor: null }
    }
    const [customer] = (await tx.execute(sql`
      select c.id from app.customers c
       where c.business_id = ${ctx.businessId} and c.id = ${input.customerId}
         and c.deleted_at is null
    `)) as unknown as { id: string }[]
    if (!customer) throw new AppError('not_found')
    const cursor = input.cursor ? decodeCursor(input.cursor) : null
    const [day, at] = cursor ? cursor.key.split('|') : [undefined, undefined]
    if (cursor && (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') || !at || Number.isNaN(Date.parse(at)))) {
      throw invalid('invalid cursor')
    }
    const scope = ctx.access.locationScope
    const rows = (await tx.execute(sql`
      select ${CUSTOMER_PAYMENT_COLUMNS},
             to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_key
        from app.customer_payments p
        ${CUSTOMER_PAYMENT_JOINS}
        left join app.sales s on s.business_id = p.business_id and s.id = p.sale_id
       where p.business_id = ${ctx.businessId} and p.deleted_at is null
         and p.customer_id = ${input.customerId}
         ${
           scope.all
             ? sql``
             : sql`and coalesce(o.location_id, s.location_id) = any(${uuidArray([...scope.ids])})`
         }
         ${
           cursor
             ? sql`and (p.business_date, p.created_at, p.id)
                     < (${day}::date, ${at}::timestamptz, ${cursor.id}::uuid)`
             : sql``
         }
       order by p.business_date desc, p.created_at desc, p.id desc
       limit ${input.limit + 1}
    `)) as unknown as (CustomerPaymentRecord & { created_key: string })[]
    const page = rows.slice(0, input.limit)
    const last = page.at(-1)
    return {
      document: null,
      items: page.map(customerPaymentOf),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ key: `${last.business_date}|${last.created_key}`, id: last.id })
          : null,
    }
  })
}

/** What one payment of `kind` of `amount` may be on a document now (EXCEEDS_OUTSTANDING otherwise). */
function assertWithin(obligation: ObligationRecord, kind: PaymentKind, amount: string): void {
  const room = kind === 'payment' ? obligation.owed : obligation.overpaid
  if (compareDecimal(amount, room) > 0) throw new AppError('exceeds_outstanding')
}

/** A customer payment as recordCustomerPaymentInTx writes it. */
export interface NewCustomerPaymentFields {
  readonly id: string
  readonly kind: PaymentKind
  readonly businessDate: string
  readonly method: SettlementMethod
  readonly amount: string
  readonly note: string | null
  readonly requestHash: string
}

/**
 * Records a customer payment (or money given back) in `tx`, the document locked by the caller (lock
 * 1): the business row FOR SHARE (lock 2: the books-closed date), its day (not after today, not on or
 * before the books-closed date, not before the document), the currency's decimals and what is owed.
 * Used by customerPayment.record and .recordMany, an order's "Paid now / Deposit" and a refund's money
 * given back.
 */
export async function recordCustomerPaymentInTx(
  tx: Tx,
  ctx: BusinessCtx,
  document: { kind: ReceivableKindDto; id: string },
  head: ReceivableHead,
  payment: NewCustomerPaymentFields,
): Promise<void> {
  assertPayable(document.kind, head, payment.kind)
  const business = await lockPostingBusiness(tx, ctx.businessId)
  assertPostable(business, payment.businessDate)
  if (payment.businessDate < head.business_date) {
    throw invalid(`businessDate: before the ${document.kind}`)
  }
  if (!isCurrencyCode(head.currency)) throw invalid(`currency: ${head.currency} is not supported`)
  if (!fitsCurrency(payment.amount, head.currency)) {
    throw invalid('amount: more decimals than the currency has')
  }
  const obligation = await readObligation(tx, ctx.businessId, document.kind, document.id)
  if (!obligation) throw invalid(`${document.kind}: nothing is owed on it`)
  assertWithin(obligation, payment.kind, payment.amount)
  await createIdempotent(tx, customerPayments, {
    id: payment.id,
    businessId: ctx.businessId,
    customerId: head.customer_id,
    orderId: document.kind === 'order' ? document.id : null,
    saleId: document.kind === 'sale' ? document.id : null,
    kind: payment.kind,
    businessDate: payment.businessDate,
    method: payment.method,
    amount: payment.amount,
    currency: head.currency,
    note: payment.note,
    requestHash: payment.requestHash,
  })
}

/** The payment with this id, when it was recorded already (a retry, or an id used elsewhere). */
export async function existingCustomerPayment(tx: Tx, businessId: string, id: string) {
  const [row] = (await tx.execute(sql`
    select p.request_hash, p.created_by = app.current_user_id() as mine
      from app.customer_payments p
     where p.business_id = ${businessId} and p.id = ${id}
  `)) as unknown as { request_hash: string | null; mine: boolean }[]
  return row
}

/**
 * `customerPayment.record` (payments.customers.record): see recordCustomerPaymentInTx. Idempotent:
 * the same payment again returns the document's payments; an id used otherwise is CONFLICT.
 */
export function recordCustomerPayment(
  ctx: BusinessCtx,
  input: RecordCustomerInput,
): Promise<DocumentPaymentsDto> {
  const document = documentOf(input)
  const requestHash = requestHashOf({
    [`${document.kind}Id`]: document.id,
    kind: input.kind,
    businessDate: input.businessDate,
    method: input.method,
    amount: input.amount,
    note: input.note,
  })
  return ctx.tx(async (tx) => {
    const head = await lockReceivable(tx, ctx, document.kind, document.id)
    const existing = await existingCustomerPayment(tx, ctx.businessId, input.id)
    if (existing) {
      if (existing.request_hash !== requestHash || !existing.mine) throw new AppError('conflict')
      return documentPayments(tx, ctx.businessId, document.kind, document.id)
    }
    await recordCustomerPaymentInTx(tx, ctx, document, head, {
      id: input.id,
      kind: input.kind,
      businessDate: input.businessDate,
      method: input.method,
      amount: input.amount,
      note: input.note,
      requestHash,
    })
    return documentPayments(tx, ctx.businessId, document.kind, document.id)
  })
}

/**
 * `customerPayment.reverse` (payments.customers.record): a payment (or money given back) recorded by
 * mistake stops counting, dated its own day or the first open day when the books are closed on it
 * (BOOKS_CLOSED when that is after today). A payment that money given back still stands on is
 * reversed after that money (PAYMENT_HAS_MONEY_BACK). Idempotent: a reversed payment is returned as
 * it is.
 */
export function reverseCustomerPayment(
  ctx: BusinessCtx,
  input: ReverseCustomerInput,
): Promise<DocumentPaymentsDto> {
  return ctx.tx(async (tx) => {
    const [found] = (await tx.execute(sql`
      select p.order_id, p.sale_id from app.customer_payments p
       where p.business_id = ${ctx.businessId} and p.id = ${input.id} and p.deleted_at is null
    `)) as unknown as { order_id: string | null; sale_id: string | null }[]
    if (!found) throw new AppError('not_found')
    const document =
      found.order_id !== null
        ? { kind: 'order' as const, id: found.order_id }
        : { kind: 'sale' as const, id: found.sale_id ?? '' }
    // The document first, as recording a payment, a delivery and a refund lock it.
    await lockReceivable(tx, ctx, document.kind, document.id)
    const [payment] = (await tx.execute(sql`
      select p.business_date::text as business_date, p.reversed_at, p.kind,
             trim_scale(p.amount)::text as amount
        from app.customer_payments p
       where p.business_id = ${ctx.businessId} and p.id = ${input.id}
         for update
    `)) as unknown as {
      business_date: string
      reversed_at: Date | string | null
      kind: PaymentKind
      amount: string
    }[]
    if (!payment) throw new AppError('not_found')
    if (payment.reversed_at === null && payment.kind === 'payment') {
      // Money given back is never more than was paid beyond what it comes to (D-267), also after a
      // payment under it is reversed: while money given back stands, a payment is reversed only when
      // the document would still owe nothing; else the money given back is reversed first
      // (PAYMENT_HAS_MONEY_BACK). A cancelled order (0) would otherwise owe its deposit again, which no
      // payment can settle (D-273).
      const obligation = await readObligation(tx, ctx.businessId, document.kind, document.id)
      if (obligation && compareDecimal(obligation.refunded, '0') > 0) {
        const leftAfter = subtractDecimals(
          obligation.total,
          obligation.credited,
          subtractDecimals(obligation.paid, payment.amount, obligation.refunded),
        )
        if (compareDecimal(leftAfter, '0') > 0) throw new AppError('payment_has_money_back')
      }
    }
    if (payment.reversed_at === null) {
      const business = await lockPostingBusiness(tx, ctx.businessId)
      const reversalDate = reversalDateOf(business, payment.business_date)
      await tx.execute(sql`
        update app.customer_payments
           set reversed_at = now(), reversed_by = app.current_user_id(),
               reversal_date = ${reversalDate}::date
         where business_id = ${ctx.businessId} and id = ${input.id}
      `)
    }
    return documentPayments(tx, ctx.businessId, document.kind, document.id)
  })
}

/**
 * `customerPayment.recordMany` ("Pay several at once", M14): one amount of one customer applied to the
 * documents listed, in their order, each up to what it still owes; one payment each with its own
 * client id. A document it does not reach gets no payment. Every document must be the customer's
 * (VALIDATION) and owe something (VALIDATION when nothing is owed on one); more than they owe in all is
 * EXCEEDS_OUTSTANDING. Idempotent: when any of its payment ids was recorded already, the same call is
 * answered from what it recorded (CONFLICT when it differs).
 */
export function recordManyCustomerPayments(
  ctx: BusinessCtx,
  input: RecordManyInput,
): Promise<RecordManyCustomerPaymentsDto> {
  const documents = input.documents.map((d) => ({ paymentId: d.id, ...documentOf(d) }))
  const batch = {
    customerId: input.customerId,
    businessDate: input.businessDate,
    method: input.method,
    amount: input.amount,
    note: input.note,
    documents: documents.map((d) => [d.kind, d.id]),
  }
  const hashOf = (index: number) => requestHashOf({ many: batch, index })
  return ctx.tx(async (tx) => {
    const [customer] = (await tx.execute(sql`
      select c.id from app.customers c
       where c.business_id = ${ctx.businessId} and c.id = ${input.customerId}
         and c.deleted_at is null
    `)) as unknown as { id: string }[]
    if (!customer) throw new AppError('not_found')
    // Lock 1, in one order for every caller: orders by id, then sales by id.
    const order = [...documents].sort((a, b) =>
      a.kind === b.kind ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.kind === 'order' ? -1 : 1,
    )
    const heads = new Map<string, ReceivableHead>()
    for (const d of order) heads.set(d.id, await lockReceivable(tx, ctx, d.kind, d.id))
    const answer = async (): Promise<RecordManyCustomerPaymentsDto> => {
      const ids = documents.map((d) => d.paymentId)
      const recorded = (await tx.execute(sql`
        select ${CUSTOMER_PAYMENT_COLUMNS}
          from app.customer_payments p
          ${CUSTOMER_PAYMENT_JOINS}
         where p.business_id = ${ctx.businessId} and p.id = any(${uuidArray(ids)})
      `)) as unknown as CustomerPaymentRecord[]
      const byId = new Map(recorded.map((r) => [r.id, r] as const))
      const obligations = await readObligations(tx, ctx.businessId, documents)
      return {
        customerId: input.customerId,
        payments: ids.flatMap((id) => {
          const row = byId.get(id)
          return row ? [customerPaymentOf(row)] : []
        }),
        documents: documents.flatMap((d) => {
          const row = obligations.get(d.id)
          return row ? [owedDocumentOf(row)] : []
        }),
      }
    }
    // A retry: every id it recorded must be this call's own.
    let replay = false
    for (const [index, d] of documents.entries()) {
      const existing = await existingCustomerPayment(tx, ctx.businessId, d.paymentId)
      if (!existing) continue
      if (existing.request_hash !== hashOf(index) || !existing.mine) {
        throw new AppError('conflict')
      }
      replay = true
    }
    if (replay) return answer()

    for (const d of documents) {
      const head = heads.get(d.id)
      if (!head || head.customer_id !== input.customerId) {
        throw invalid(`documents: ${d.kind} ${d.id} is not this customer's`)
      }
      assertPayable(d.kind, head, 'payment')
    }
    const obligations = await readObligations(tx, ctx.businessId, documents)
    let left = input.amount
    const plan: { index: number; amount: string }[] = []
    for (const [index, d] of documents.entries()) {
      const owed = obligations.get(d.id)?.owed ?? '0'
      if (compareDecimal(owed, '0') === 0) {
        throw invalid(`documents: nothing is owed on ${d.kind} ${d.id}`)
      }
      if (compareDecimal(left, '0') === 0) continue
      const amount = compareDecimal(left, owed) > 0 ? owed : left
      plan.push({ index, amount })
      left = subtractDecimals(left, amount)
    }
    if (compareDecimal(left, '0') > 0) throw new AppError('exceeds_outstanding')
    for (const { index, amount } of plan) {
      const d = documents[index]
      const head = d ? heads.get(d.id) : undefined
      if (!d || !head) continue
      await recordCustomerPaymentInTx(tx, ctx, d, head, {
        id: d.paymentId,
        kind: 'payment',
        businessDate: input.businessDate,
        method: input.method,
        amount,
        note: input.note,
        requestHash: hashOf(index),
      })
    }
    return answer()
  })
}
