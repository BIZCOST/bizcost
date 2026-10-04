import type {
  MineExpenseDto,
  mineExpenseGetInput,
  mineExpenseListInput,
  MineExpenseListDto,
  MineExpenseResultDto,
  MinePayableDto,
  minePayableListInput,
  MinePayableListDto,
  MinePaymentDto,
  PayableKindDto,
} from '@bizcost/contracts'
import type { Tx } from '@bizcost/db'
import {
  can,
  isOwedPaymentMethod,
  outstandingOf,
  type DocumentStatus,
  type ExpensePays,
  type ExpenseStatus,
  type PaymentMethod,
  type PurchaseDocumentType,
  type SettlementMethod,
} from '@bizcost/domain'
import { sql, type SQL } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { decodeCursor, encodeCursor } from './catalog'
import { paysDtoOf, readExpense } from './expenses'

// A member's own records (the owner's answers of 2026-09-29, A4; D-181): "My expenses" (expense.mine,
// expense.getMine: module expenses and expenses.documents.view, the router checks them) and "Owed to
// me" (payable.mine: Purchases or Expenses on, every member). A member sees the amounts of what they
// entered or paid from their own money even without supplier prices, since they typed or paid them.
//
// The one rule of this file: every statement is filtered in SQL on the caller (`app.current_user_id()`,
// set by withTenantTx for the verified caller) as the one who entered the row (`created_by`; for a
// copy made by a correction, every expense it was copied from too: a copy of someone else's expense is
// not one's own, D-184) or the member who paid it (`paid_by_member_id` names one of the caller's
// memberships in the business, the current one or an earlier one). Nothing else is ever read here, so
// no other member's amounts can reach these outputs, which are not tagged sensitive
// (contracts/dto/mine.ts). RLS keeps it inside the business as everywhere. What was paid on an expense
// and what is still owed on it is said only for what the caller paid themselves, or to a member who
// may see payments (expenses.payments.view with supplier prices), as expensePayment.list says it.

type MineListInput = z.output<typeof mineExpenseListInput>
type MineGetInput = z.output<typeof mineExpenseGetInput>
type MinePayablesInput = z.output<typeof minePayableListInput>

/** The caller's memberships in the business (any: a member who left and joined again paid too). */
const MY_MEMBERSHIPS = sql`(
  select m.id from app.business_members m
   where m.business_id = ${sql.raw('d.business_id')} and m.user_id = app.current_user_id())`

/** A document (alias `d`) the caller paid from their own money (false, never null, otherwise). */
const PAID_BY_ME = sql`coalesce(d.paid_by_member_id in ${MY_MEMBERSHIPS}, false)`

/**
 * An expense (alias `d`) the caller entered: they made it, and when it is a copy (expense.correct),
 * they made every expense it was copied from too. A correction copies the amounts of the expense it
 * corrects, so a copy of someone else's expense is not the caller's own (D-184).
 */
const ENTERED_BY_ME = sql`(d.created_by = app.current_user_id() and not exists (
  with recursive chain (id, created_by, copied_from_id) as (
    select s.id, s.created_by, s.copied_from_id from app.expenses s
     where s.business_id = d.business_id and s.id = d.copied_from_id
    union
    select s.id, s.created_by, s.copied_from_id from app.expenses s
      join chain c on s.id = c.copied_from_id
     where s.business_id = d.business_id)
  select 1 from chain where chain.created_by is distinct from app.current_user_id()))`

/** An expense (alias `d`) the caller entered or paid from their own money. */
const MY_EXPENSE = sql`(${ENTERED_BY_ME} or ${PAID_BY_ME})`

/** A business-day cursor: the key is a YYYY-MM-DD day (VALIDATION otherwise). */
function dayCursor(value: string | undefined) {
  if (!value) return null
  const cursor = decodeCursor(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cursor.key)) {
    throw new AppError('validation', { message: 'invalid cursor' })
  }
  return cursor
}

// ---------------------------------------------------------------------------------------------------
// My expenses
// ---------------------------------------------------------------------------------------------------

interface MineExpenseRecord extends Record<string, unknown> {
  id: string
  status: ExpenseStatus
  business_date: string
  period_month: string
  category_name: string
  description: string | null
  reference: string | null
  document_type: PurchaseDocumentType
  payment_method: PaymentMethod
  entered_by_me: boolean
  paid_by_me: boolean
  currency: string
  total: string
  paid: string
  pays: ExpensePays | null
  running_cost_id: string | null
  running_cost_name: string | null
}

/**
 * `expense.mine`: the expenses the caller entered or paid from their own money, newest business day
 * first (a cursor as expense.list's). A final expense the caller paid from their own money says what
 * was paid back and what is still owed to them; one bought on credit (or paid by another member) says
 * what was paid on it only to a member who may see payments (expenses.payments.view and supplier
 * prices), as expensePayment.list would.
 */
export function listMineExpenses(
  ctx: BusinessCtx,
  input: MineListInput,
): Promise<MineExpenseListDto> {
  const cursor = dayCursor(input.cursor)
  const after = cursor
    ? sql`and (d.business_date, d.id) < (${cursor.key}::date, ${cursor.id}::uuid)`
    : sql``
  const seesPayments =
    can(ctx.access.effective, 'expenses.payments.view') &&
    ctx.access.visibleCategories.has('supplier_price')
  return ctx.tx(async (tx) => {
    const rows = (await tx.execute(sql`
      select d.id, d.status, d.business_date::text as business_date,
             to_char(d.period_month, 'YYYY-MM') as period_month, c.name as category_name,
             d.description, d.reference, d.document_type, d.payment_method,
             ${ENTERED_BY_ME} as entered_by_me, ${PAID_BY_ME} as paid_by_me,
             trim(d.currency) as currency, trim_scale(d.total)::text as total,
             trim_scale(coalesce((
               select sum(p.amount) from app.expense_payments p
                where p.business_id = d.business_id and p.expense_id = d.id
                  and p.reversed_at is null and p.deleted_at is null), 0))::text as paid,
             d.pays, d.running_cost_id, rc.name as running_cost_name
        from app.expenses d
        join app.cost_categories c on c.business_id = d.business_id and c.id = d.category_id
        left join app.running_costs rc
          on rc.business_id = d.business_id and rc.id = d.running_cost_id
       where d.business_id = ${ctx.businessId} and d.deleted_at is null and ${MY_EXPENSE}
             ${after}
       order by d.business_date desc, d.id desc
       limit ${input.limit + 1}
    `)) as unknown as MineExpenseRecord[]
    const page = rows.slice(0, input.limit)
    const last = page.at(-1)
    return {
      items: page.map((r): MineExpenseDto => {
        // Paid back to the caller: theirs to know. Paid to a supplier or another member: payments.
        const reimbursed = r.payment_method === 'paid_by_member' && r.paid_by_me
        const owed =
          r.status === 'posted' &&
          isOwedPaymentMethod(r.payment_method) &&
          (reimbursed || seesPayments)
        return {
          id: r.id,
          status: r.status,
          businessDate: r.business_date,
          periodMonth: r.period_month,
          categoryName: r.category_name,
          description: r.description,
          reference: r.reference,
          documentType: r.document_type,
          paymentMethod: r.payment_method,
          enteredByMe: r.entered_by_me,
          paidByMe: r.paid_by_me,
          pays: paysDtoOf(ctx, r),
          currency: r.currency,
          total: r.total,
          paid: owed ? r.paid : null,
          outstanding: owed ? outstandingOf(r.total, '0', r.paid) : null,
        }
      }),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ key: last.business_date, id: last.id })
          : null,
    }
  })
}

/**
 * `expense.getMine`: one expense the caller entered or paid from their own money, as expense.get
 * returns it but with its amounts. NOT_FOUND for any other expense (as for one of another business),
 * so it tells nothing about expenses that are not the caller's.
 */
export function getMineExpense(
  ctx: BusinessCtx,
  input: MineGetInput,
): Promise<MineExpenseResultDto> {
  return ctx.tx(async (tx) => {
    const [own] = (await tx.execute(sql`
      select d.id from app.expenses d
       where d.business_id = ${ctx.businessId} and d.id = ${input.id} and d.deleted_at is null
         and ${MY_EXPENSE}
    `)) as unknown as { id: string }[]
    if (!own) throw new AppError('not_found')
    const expense = await readExpense(tx, ctx, own.id)
    return {
      data: {
        ...expense,
        amount: required(expense.amount),
        netTotal: required(expense.netTotal),
        vatTotal: required(expense.vatTotal),
        total: required(expense.total),
        costTotal: expense.costTotal ?? null,
      },
      meta: { redacted: [] },
    }
  })
}

/** An amount readExpense always fills (optional in the type only because it is redactable). */
function required(value: string | undefined): string {
  if (value === undefined) throw new AppError('internal', { message: 'expense amount missing' })
  return value
}

// ---------------------------------------------------------------------------------------------------
// Owed to me
// ---------------------------------------------------------------------------------------------------

interface MinePayableRecord extends Record<string, unknown> {
  kind: PayableKindDto
  document_id: string
  status: DocumentStatus | ExpenseStatus
  business_date: string
  /** When it was entered, in UTC to the microsecond (the cursor's tie-break). */
  created_key: string
  reference: string | null
  document_type: PurchaseDocumentType
  item_names: string[]
  category_name: string | null
  supplier_name: string | null
  currency: string
  total: string
  returned: string
  paid: string
  outstanding: string
}

interface MineTotalsRecord extends Record<string, unknown> {
  outstanding: string
  owed_count: number
  paid_back: string
}

interface MinePaymentRecord extends Record<string, unknown> {
  kind: PayableKindDto
  document_id: string
  id: string
  business_date: string
  method: SettlementMethod
  amount: string
}

/**
 * The final purchases (with Purchases on) and expenses (with Expenses on) the caller paid from their
 * own money, with what their returns and the payments that stand come to: one row per document.
 */
function paidByMe(businessId: string, kinds: readonly PayableKindDto[]): SQL {
  const parts: SQL[] = []
  if (kinds.includes('purchase')) {
    parts.push(sql`
      select 'purchase'::text as kind, d.id as document_id, d.status, d.business_date,
             d.created_at, d.reference, d.document_type, trim(d.currency) as currency,
             array(
               select coalesce(l.description, '') from app.purchase_lines l
                where l.business_id = d.business_id and l.purchase_id = d.id
                  and l.kind = 'material' and l.deleted_at is null
                order by l.position, l.id
                limit 2) as item_names,
             null::text as category_name, s.name as supplier_name,
             d.total as total_n,
             coalesce((
               select sum(r.total) from app.purchase_returns r
                where r.business_id = d.business_id and r.purchase_id = d.id
                  and r.status = 'posted' and r.deleted_at is null), 0) as returned_n,
             coalesce((
               select sum(p.amount) from app.purchase_payments p
                where p.business_id = d.business_id and p.purchase_id = d.id
                  and p.reversed_at is null and p.deleted_at is null), 0) as paid_n
        from app.purchases d
        left join app.suppliers s on s.business_id = d.business_id and s.id = d.supplier_id
       where d.business_id = ${businessId} and d.deleted_at is null and d.status = 'posted'
         and d.payment_method = 'paid_by_member' and ${PAID_BY_ME}`)
  }
  if (kinds.includes('expense')) {
    parts.push(sql`
      select 'expense'::text as kind, d.id as document_id, d.status, d.business_date,
             d.created_at, d.reference, d.document_type, trim(d.currency) as currency,
             array_remove(array[d.description], null) as item_names,
             c.name as category_name, s.name as supplier_name,
             d.total as total_n, 0::numeric as returned_n,
             coalesce((
               select sum(p.amount) from app.expense_payments p
                where p.business_id = d.business_id and p.expense_id = d.id
                  and p.reversed_at is null and p.deleted_at is null), 0) as paid_n
        from app.expenses d
        join app.cost_categories c on c.business_id = d.business_id and c.id = d.category_id
        left join app.suppliers s on s.business_id = d.business_id and s.id = d.supplier_id
       where d.business_id = ${businessId} and d.deleted_at is null and d.status = 'posted'
         and d.payment_method = 'paid_by_member' and ${PAID_BY_ME}`)
  }
  return sql.join(parts, sql` union all `)
}

/**
 * `payable.mine` ("Owed to me"): what the business owes the caller for what they paid from their own
 * money, and what it paid them back. `kinds` are the documents whose module is on (the router works
 * them out: purchases with Purchases on, expenses with Expenses on); no permission key is needed, since
 * every row is the caller's own. Newest business day first (a cursor on the day, the moment it was
 * entered, its kind and id), each with its payments that stand; the totals cover every page.
 */
export function listMinePayables(
  ctx: BusinessCtx,
  input: MinePayablesInput,
  kinds: readonly PayableKindDto[],
): Promise<MinePayableListDto> {
  const cursor = input.cursor ? decodeCursor(input.cursor) : null
  const key = cursor ? parsePayableKey(cursor.key) : null
  return ctx.tx(async (tx) => {
    const [business] = (await tx.execute(sql`
      select trim(b.currency) as currency from app.businesses b where b.id = ${ctx.businessId}
    `)) as unknown as { currency: string }[]
    const currency = business?.currency ?? ''
    if (kinds.length === 0) {
      return {
        currency,
        outstanding: '0',
        owedCount: 0,
        paidBack: '0',
        items: [],
        nextCursor: null,
      }
    }
    const documents = paidByMe(ctx.businessId, kinds)
    const [totals] = (await tx.execute(sql`
      select trim_scale(coalesce(sum(greatest(o.total_n - o.returned_n - o.paid_n, 0)), 0))::text
               as outstanding,
             (count(*) filter (where o.total_n - o.returned_n - o.paid_n > 0))::int as owed_count,
             trim_scale(coalesce(sum(o.paid_n), 0))::text as paid_back
        from (${documents}) o
    `)) as unknown as MineTotalsRecord[]
    const after = key
      ? sql`where (o.business_date, o.created_at, o.kind, o.document_id)
                < (${key.day}::date, ${key.at}::timestamptz, ${key.kind}, ${cursor?.id}::uuid)`
      : sql``
    const rows = (await tx.execute(sql`
      select o.kind, o.document_id, o.status, o.business_date::text as business_date,
             to_char(o.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
               as created_key,
             o.reference, o.document_type, o.item_names, o.category_name, o.supplier_name,
             o.currency, trim_scale(o.total_n)::text as total,
             trim_scale(o.returned_n)::text as returned, trim_scale(o.paid_n)::text as paid,
             trim_scale(greatest(o.total_n - o.returned_n - o.paid_n, 0))::text as outstanding
        from (${documents}) o
        ${after}
       order by o.business_date desc, o.created_at desc, o.kind desc, o.document_id desc
       limit ${input.limit + 1}
    `)) as unknown as MinePayableRecord[]
    const page = rows.slice(0, input.limit)
    const payments = await paymentsOf(tx, ctx.businessId, page)
    const last = page.at(-1)
    return {
      currency,
      outstanding: totals?.outstanding ?? '0',
      owedCount: totals?.owed_count ?? 0,
      paidBack: totals?.paid_back ?? '0',
      items: page.map((r): MinePayableDto => ({
        kind: r.kind,
        documentId: r.document_id,
        status: r.status,
        businessDate: r.business_date,
        reference: r.reference,
        documentType: r.document_type,
        itemNames: r.item_names,
        categoryName: r.category_name,
        supplierName: r.supplier_name,
        currency: r.currency,
        total: r.total,
        returned: r.returned,
        paid: r.paid,
        outstanding: r.outstanding,
        payments: payments.get(`${r.kind}:${r.document_id}`) ?? [],
      })),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({
              key: `${last.business_date}|${last.created_key}|${last.kind}`,
              id: last.document_id,
            })
          : null,
    }
  })
}

/** The payments that stand of these documents (the caller's own, listed above), newest first. */
async function paymentsOf(
  tx: Tx,
  businessId: string,
  documents: readonly MinePayableRecord[],
): Promise<Map<string, MinePaymentDto[]>> {
  const byKind = (kind: PayableKindDto) =>
    documents.filter((d) => d.kind === kind).map((d) => d.document_id)
  const purchases = byKind('purchase')
  const expenses = byKind('expense')
  const parts: SQL[] = []
  if (purchases.length > 0) {
    parts.push(sql`
      select 'purchase'::text as kind, p.purchase_id as document_id, p.id, p.business_date,
             p.method, p.amount, p.created_at
        from app.purchase_payments p
       where p.business_id = ${businessId} and p.reversed_at is null and p.deleted_at is null
         and p.purchase_id in (${sql.join(
           purchases.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})`)
  }
  if (expenses.length > 0) {
    parts.push(sql`
      select 'expense'::text as kind, p.expense_id as document_id, p.id, p.business_date,
             p.method, p.amount, p.created_at
        from app.expense_payments p
       where p.business_id = ${businessId} and p.reversed_at is null and p.deleted_at is null
         and p.expense_id in (${sql.join(
           expenses.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})`)
  }
  const found = new Map<string, MinePaymentDto[]>()
  if (parts.length === 0) return found
  const rows = (await tx.execute(sql`
    select x.kind, x.document_id, x.id, x.business_date::text as business_date, x.method,
           trim_scale(x.amount)::text as amount
      from (${sql.join(parts, sql` union all `)}) x
     order by x.business_date desc, x.created_at desc, x.id desc
  `)) as unknown as MinePaymentRecord[]
  for (const row of rows) {
    const key = `${row.kind}:${row.document_id}`
    const list = found.get(key) ?? []
    list.push({
      id: row.id,
      businessDate: row.business_date,
      method: row.method,
      amount: row.amount,
    })
    found.set(key, list)
  }
  return found
}

/**
 * The cursor key of "Owed to me" ("day|moment|kind": the business day, the moment it was entered in
 * UTC to the microsecond, and its kind), as this server made it; VALIDATION otherwise.
 */
function parsePayableKey(key: string): { day: string; at: string; kind: PayableKindDto } {
  const [day, at, kind, ...rest] = key.split('|')
  if (
    rest.length > 0 ||
    !day ||
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !at ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(at) ||
    (kind !== 'purchase' && kind !== 'expense')
  ) {
    throw new AppError('validation', { message: 'invalid cursor' })
  }
  return { day, at, kind }
}

// ---------------------------------------------------------------------------------------------------
// Where "Owed to me" shows
// ---------------------------------------------------------------------------------------------------

/**
 * The modules (of `candidates`: Purchases, Expenses) in which the caller paid a final purchase or
 * expense from their own money: business.context shows them "Amounts owed" for their own records
 * even without its keys (D-181). One statement; nothing is read when there are no candidates.
 */
export async function payeeModules(
  ctx: BusinessCtx,
  candidates: ReadonlySet<'purchases' | 'expenses'>,
): Promise<Set<string>> {
  if (candidates.size === 0) return new Set()
  const checks: SQL[] = []
  if (candidates.has('purchases')) {
    checks.push(sql`select 'purchases'::text as module where exists (
      select 1 from app.purchases d
       where d.business_id = ${ctx.businessId} and d.deleted_at is null and d.status = 'posted'
         and d.payment_method = 'paid_by_member' and ${PAID_BY_ME})`)
  }
  if (candidates.has('expenses')) {
    checks.push(sql`select 'expenses'::text as module where exists (
      select 1 from app.expenses d
       where d.business_id = ${ctx.businessId} and d.deleted_at is null and d.status = 'posted'
         and d.payment_method = 'paid_by_member' and ${PAID_BY_ME})`)
  }
  const rows = (await ctx.tx((tx) =>
    tx.execute(sql.join(checks, sql` union all `)),
  )) as unknown as { module: string }[]
  return new Set(rows.map((row) => row.module))
}
