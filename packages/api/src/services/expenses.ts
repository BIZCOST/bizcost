import type {
  correctExpenseInput,
  createExpenseInput,
  ExpenseDto,
  expenseIdInput,
  expenseListInput,
  ExpenseListDto,
  ExpensePaysDto,
  ExpensePaysInput,
  ExpenseResultDto,
  expenseReviewInput,
  ExpenseSettingsDto,
  expenseVersionInput,
  OkDto,
  PayableRunningCostDto,
  payableRunningCostsInput,
  PayableRunningCostsDto,
  rejectExpenseInput,
  updateExpenseInput,
  updateExpenseSettingsInput,
} from '@bizcost/contracts'
import { businesses, createIdempotent, expenses, type NewExpense, type Tx } from '@bizcost/db'
import {
  billPeriodOf,
  can,
  checkDecimal,
  computeExpense,
  defaultPeriodMonth,
  expenseError,
  expenseTransition,
  firstDayOf,
  firstOpenMonth,
  isCurrencyCode,
  monthOf,
  periodMonthAllowed,
  periodMonthClosed,
  vatInCost,
  type BusinessMonth,
  type CurrencyCode,
  type ExpenseAction,
  type ExpensePays,
  type ExpenseStatus,
  type Money,
  type Percent,
  type PurchaseDocumentType,
  type RunningCostFrequency,
} from '@bizcost/domain'
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { assertQueryable, passes } from '../trpc'
import { detachAll, removeStoredFiles } from './attachments'
import { containsPattern, decodeCursor, encodeCursor, requestHashOf } from './catalog'
import { assertCategory, assertCategoryExists } from './cost-categories'
import {
  assertActivePayer,
  assertPaidBy,
  assertPaidByShown,
  assertSupplier,
  assertVatShown,
  draftContext,
  resolveLocation,
} from './purchases'
import {
  assertPostable,
  isoOf,
  lockPostingBusiness,
  reversalDateOf,
  type PostingBusiness,
} from './stock'

// Expenses (ROADMAP.md M2 Step 5; PRODUCT.md §4 rule 13; DATA_MODEL.md §6; D-114, D-116, D-164–D-166).
// Module `expenses`: expenses.documents.view to read, .manage to save, discard and send drafts for
// approval (a member who may not see supplier prices: only the ones they entered, D-184), .approve to
// approve or reject, .post to finalize, .reverse to reverse (and with .manage, correct, seeing supplier
// prices); the router checks the keys. An expense is one amount in one category (shared with running
// costs, D-116), with the document it came with (independent of how it was paid) and an optional
// supplier; the amount is typed before VAT or with its VAT (D-157) and its net, VAT and total are
// computed on every save (computeExpense: the purchase line's maths). How it was paid is required,
// with the purchase's methods (D-159): on credit it needs its supplier, paid personally names an
// active member, and either leaves it owed (payments.ts, "Amounts owed", D-166).
//
// The month an expense is for (`period_month`, "For which month?", the owner's request of 2026-09-30):
// apart from its bill's date, since a bill often comes after the month it covers. Left out, it is the
// month before the bill's date in a category billed the month after (electricity, water, internet,
// phone), else the bill's month; up to 12 months before the bill's month and 1 month after it.
// Anything that counts expenses by month counts them in this month (real profit, Phase 3). Closed
// books close months too (D-200): once the books are closed through a month's last day, no expense
// for it is sent for approval or finalized (BOOKS_CLOSED, as for a bill dated then), the default
// month is the first open one instead, and a reversal of one finalized before counts in the first
// open month (`reversal_period_month`), as its date moves to the first open day (D-114 rule 3).
//
// Approval (D-164): optional, a business setting that applies only while the business has a team.
// The transitions are expenseTransition's (@bizcost/domain): with approval on, a member who may not
// approve sends a draft for approval; an approver approves or rejects it (a rejected expense is
// edited like a draft) or finalizes a draft directly (the approval is recorded with the posting). A
// submitted or approved expense is frozen (a database trigger keeps what was approved). Posting
// fixes what it costs the business (D-114 rule 4: VAT only when it cannot be reclaimed); it never
// touches stock. A posted expense is never edited: it is reversed ("as if never posted": it stops
// counting), or corrected (reversed, and a copy opened as a new draft).
//
// What it pays (the owner's decision of 2026-10-01, D-216): in a category that has a running cost a
// bill for its month can pay (billPeriodOf), an expense says which one it pays («فاتورة لـ…»: it takes
// the place of that running cost's regular amount alone in the month's costs) or that it is an extra
// («مصروف إضافي»: it counts as itself, on top). Said on a draft by a member who may see running costs
// (their names only, expense.payableRunningCosts), or by the one who approves or finalizes it (for a
// member who may not, the choice is hidden); required when it is finalized
// (RUNNING_COST_CHOICE_REQUIRED), never before; kept by a correction's copy and by a reversal. With
// Running Costs off nothing is asked and what an expense says stays as it is (running costs are not
// counted then).
//
// Locks: every change locks the expense FOR UPDATE first, then (posting, reversing, sending for
// approval) the business row FOR SHARE: the books-closed date and the approval setting cannot change
// until it commits. A payment locks the expense the same way (payments.ts).

type CreateInput = z.output<typeof createExpenseInput>
type UpdateInput = z.output<typeof updateExpenseInput>
type Fields = Omit<CreateInput, 'id'>
type IdInput = z.output<typeof expenseIdInput>
type VersionInput = z.output<typeof expenseVersionInput>
type ReviewInput = z.output<typeof expenseReviewInput>
type PayableInput = z.output<typeof payableRunningCostsInput>
type RejectInput = z.output<typeof rejectExpenseInput>
type CorrectInput = z.output<typeof correctExpenseInput>
type ListInput = z.output<typeof expenseListInput>
type SettingsInput = z.output<typeof updateExpenseSettingsInput>

const invalid = (message: string) => new AppError('validation', { message })

/** Whether the business requires approval now: its setting, and it has a team (D-164). */
function approvalRequired(ctx: BusinessCtx, setting: boolean): boolean {
  return setting && ctx.access.capabilities.has_team
}

/**
 * Reviewing an expense (approving or rejecting it, or finalizing it as its approver) needs its amounts
 * visible: what was sent is what is approved (D-164), and an expense's amounts are supplier prices
 * (D-165). FORBIDDEN otherwise, before anything is read, as recording a payment (D-160, D-175).
 */
function assertSeesWhatIsReviewed(ctx: BusinessCtx) {
  assertQueryable(ctx, [{ name: 'total', category: 'supplier_price' }])
}

/**
 * A member who may not see supplier prices changes only the expenses they entered themselves (the
 * owner's answer A3: an employee enters their own expenses and sends them for approval; D-180, D-184):
 * never another member's draft or rejected expense, whose amounts they cannot see. FORBIDDEN
 * otherwise, before anything is changed.
 */
function assertMayChange(ctx: BusinessCtx, head: HeadRecord) {
  if (!ctx.access.visibleCategories.has('supplier_price') && !head.entered_by_me) {
    throw new AppError('forbidden')
  }
}

// ---------------------------------------------------------------------------------------------------
// What it pays (D-216)
// ---------------------------------------------------------------------------------------------------

/**
 * Whether the member may see running costs: Running Costs on and running_costs.items.view (as the
 * Running Costs page). Only they say what an expense pays and read the running cost's name.
 */
function mayReadRunningCosts(ctx: BusinessCtx): boolean {
  return passes(ctx, ['running_costs', 'running_costs.items.view'])
}

/** What an expense says it pays, as stored. */
interface StoredPays {
  readonly pays: ExpensePays | null
  readonly runningCostId: string | null
}

const NOTHING_SAID: StoredPays = { pays: null, runningCostId: null }

/**
 * `pays` as the API returns it: the running cost's name only to a member who may see running costs
 * (null for anyone else: "Bill for a running cost"), never an amount.
 */
export function paysDtoOf(
  ctx: BusinessCtx,
  row: {
    pays: ExpensePays | null
    running_cost_id: string | null
    running_cost_name: string | null
  },
): ExpensePaysDto {
  if (row.pays === null) return null
  const shown =
    row.pays === 'running_cost' && row.running_cost_id !== null && mayReadRunningCosts(ctx)
  return {
    kind: row.pays,
    runningCost: shown ? { id: row.running_cost_id!, name: row.running_cost_name ?? '' } : null,
  }
}

/**
 * The live running costs of a category that a bill for `month` can pay (billPeriodOf: a weekly or
 * monthly one that ran a day of it; a quarterly or yearly one whose quarter or year holding it began
 * before it stopped), by name, with when each counts and the period a bill of each pays for. Names
 * and days only, never amounts.
 */
async function payableOf(
  tx: Tx,
  businessId: string,
  categoryId: string,
  month: BusinessMonth,
): Promise<PayableRunningCostDto[]> {
  const rows = (await tx.execute(sql`
    select r.id, r.name, r.frequency, r.starts_on::text as starts_on, r.ends_on::text as ends_on
      from app.running_costs r
     where r.business_id = ${businessId} and r.category_id = ${categoryId}
       and r.deleted_at is null
     order by lower(r.name), r.id
  `)) as unknown as {
    id: string
    name: string
    frequency: RunningCostFrequency
    starts_on: string
    ends_on: string | null
  }[]
  return rows.flatMap((row) => {
    const period = billPeriodOf(
      { frequency: row.frequency, startsOn: row.starts_on, endsOn: row.ends_on },
      month,
    )
    return period
      ? [
          {
            id: row.id,
            name: row.name,
            frequency: row.frequency,
            startsOn: row.starts_on,
            endsOn: row.ends_on,
            period,
          },
        ]
      : []
  })
}

/**
 * `expense.payableRunningCosts` (expenses.documents.view and running_costs.items.view, both modules
 * on; the router checks them): the running costs an expense in this category for this month can pay,
 * by name («فاتورة لـ…»). NOT_FOUND unless the category is the business's. Empty: the expense says
 * nothing about what it pays.
 */
export function listPayableRunningCosts(
  ctx: BusinessCtx,
  input: PayableInput,
): Promise<PayableRunningCostsDto> {
  return ctx.tx(async (tx) => {
    await assertCategoryExists(tx, ctx.businessId, input.categoryId)
    return { items: await payableOf(tx, ctx.businessId, input.categoryId, input.periodMonth) }
  })
}

/**
 * What an expense pays once it is saved, approved or finalized (`final`), from what the caller says
 * (`given`: left out, null or a choice) and what it says now for this category (`stored`: nothing
 * once the category changes, prepareDraft; D-217):
 *   - a member who may not see running costs says nothing: FORBIDDEN when `given` is not left out,
 *     before anything is read (with Running Costs off, nobody may);
 *   - a choice must fit: the bill of a running cost the category has for its month (NOT_FOUND unless
 *     a live running cost of the business, VALIDATION otherwise), or an extra while the category has
 *     one (VALIDATION when it has none: there is nothing to say);
 *   - left out, what it says stays while it still fits its category and month; otherwise nothing is
 *     said (it is asked again). Checked with Running Costs off too (D-217): a choice that no longer
 *     fits never stays because nobody may change it then;
 *   - finalized with Running Costs on, it must be said whenever the category has a running cost for
 *     its month (RUNNING_COST_CHOICE_REQUIRED); with it off nothing is asked.
 */
async function resolvePays(
  tx: Tx,
  ctx: BusinessCtx,
  expense: { categoryId: string; periodMonth: string },
  given: ExpensePaysInput | null | undefined,
  stored: StoredPays,
  final: boolean,
): Promise<StoredPays> {
  if (given !== undefined && !mayReadRunningCosts(ctx)) throw new AppError('forbidden')
  const asked = final && passes(ctx, ['running_costs'])
  // Nothing said, nothing to check (unless it is required now).
  if (given === undefined && stored.pays === null && !asked) return NOTHING_SAID
  const payable = await payableOf(
    tx,
    ctx.businessId,
    expense.categoryId,
    monthOf(expense.periodMonth),
  )
  const fits = (said: StoredPays) =>
    said.pays === 'extra'
      ? payable.length > 0
      : said.pays === 'running_cost' && payable.some((r) => r.id === said.runningCostId)
  let result: StoredPays
  if (given === undefined) {
    result = fits(stored) ? stored : NOTHING_SAID
  } else if (given === null) {
    result = NOTHING_SAID
  } else if (given.kind === 'extra') {
    if (payable.length === 0) {
      throw invalid('pays: its category has no running cost for its month: nothing to say')
    }
    result = { pays: 'extra', runningCostId: null }
  } else {
    const said: StoredPays = { pays: 'running_cost', runningCostId: given.runningCostId }
    if (!fits(said)) {
      const [live] = (await tx.execute(sql`
        select r.id from app.running_costs r
         where r.business_id = ${ctx.businessId} and r.id = ${given.runningCostId}
           and r.deleted_at is null
      `)) as unknown as { id: string }[]
      if (!live) throw new AppError('not_found')
      throw invalid('pays: not a running cost of its category that a bill for its month can pay')
    }
    result = said
  }
  if (asked && result.pays === null && payable.length > 0) {
    throw new AppError('running_cost_choice_required')
  }
  return result
}

/** The member who holds `userColumn` (an auth user id) in the business, as `memberNameDto`. */
const memberOf = (userColumn: SQL) => sql`
  (select m.id from app.business_members m
    where m.business_id = e.business_id and m.user_id = ${userColumn}
    order by (m.deleted_at is null) desc, m.created_at desc limit 1)`

// ---------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------

interface ExpenseRecord extends Record<string, unknown> {
  id: string
  status: ExpenseStatus
  category_id: string
  category_name: string
  supplier_id: string | null
  supplier_name: string | null
  location_id: string
  business_date: string
  period_month: string
  document_type: PurchaseDocumentType
  reference: string | null
  description: string | null
  payment_method: ExpenseDto['paymentMethod']
  paid_by_member_id: string | null
  paid_by_member_name: string | null
  prices_include_vat: boolean
  vat_not_reclaimable: boolean
  currency: string
  amount: string
  vat_rate: string
  net_total: string
  vat_total: string
  total: string
  vat_in_cost: boolean | null
  cost_total: string | null
  notes: string | null
  attachment_count: number
  expense_approval: boolean
  created_by_id: string | null
  created_by_name: string | null
  submitted_at: Date | string | null
  submitted_by_id: string | null
  submitted_by_name: string | null
  approved_at: Date | string | null
  approved_by_id: string | null
  approved_by_name: string | null
  rejected_at: Date | string | null
  rejected_by_id: string | null
  rejected_by_name: string | null
  rejection_reason: string | null
  posted_at: Date | string | null
  reversed_at: Date | string | null
  reversal_date: string | null
  copied_from_id: string | null
  pays: ExpensePays | null
  running_cost_id: string | null
  running_cost_name: string | null
  created_at: Date | string
  version: number
}

/** A member by the id `memberOf` found, or null when the event did not happen. */
function memberName(at: Date | string | null, id: string | null, name: string | null) {
  return at === null ? null : { memberId: id, name }
}

/** The expense as the API returns it (NOT_FOUND unless a live expense of this business). */
export async function readExpense(tx: Tx, ctx: BusinessCtx, id: string): Promise<ExpenseDto> {
  const [row] = (await tx.execute(sql`
    select e.id, e.status, e.category_id, c.name as category_name, e.supplier_id,
           s.name as supplier_name, e.location_id, e.business_date::text as business_date,
           to_char(e.period_month, 'YYYY-MM') as period_month,
           e.document_type, e.reference, e.description, e.payment_method, e.paid_by_member_id,
           pm.display_name as paid_by_member_name, e.prices_include_vat, e.vat_not_reclaimable,
           trim(e.currency) as currency, trim_scale(e.amount)::text as amount,
           trim_scale(e.vat_rate)::text as vat_rate, trim_scale(e.net_total)::text as net_total,
           trim_scale(e.vat_total)::text as vat_total, trim_scale(e.total)::text as total,
           e.vat_in_cost, trim_scale(e.cost_total)::text as cost_total, e.notes,
           (select count(*)::int from app.attachments a
             where a.business_id = e.business_id and a.entity = 'expense' and a.entity_id = e.id
               and a.deleted_at is null) as attachment_count,
           b.expense_approval,
           cb.id as created_by_id, cb.display_name as created_by_name,
           e.submitted_at, sb.id as submitted_by_id, sb.display_name as submitted_by_name,
           e.approved_at, ab.id as approved_by_id, ab.display_name as approved_by_name,
           e.rejected_at, rb.id as rejected_by_id, rb.display_name as rejected_by_name,
           e.rejection_reason, e.posted_at, e.reversed_at, e.reversal_date::text as reversal_date,
           e.copied_from_id, e.pays, e.running_cost_id, rc.name as running_cost_name, e.created_at,
           e.version
      from app.expenses e
      join app.businesses b on b.id = e.business_id
      join app.cost_categories c on c.business_id = e.business_id and c.id = e.category_id
      left join app.running_costs rc on rc.business_id = e.business_id and rc.id = e.running_cost_id
      left join app.suppliers s on s.business_id = e.business_id and s.id = e.supplier_id
      left join app.business_members pm
        on pm.business_id = e.business_id and pm.id = e.paid_by_member_id
      left join app.business_members cb
        on cb.business_id = e.business_id and cb.id = ${memberOf(sql.raw('e.created_by'))}
      left join app.business_members sb
        on sb.business_id = e.business_id and sb.id = ${memberOf(sql.raw('e.submitted_by'))}
      left join app.business_members ab
        on ab.business_id = e.business_id and ab.id = ${memberOf(sql.raw('e.approved_by'))}
      left join app.business_members rb
        on rb.business_id = e.business_id and rb.id = ${memberOf(sql.raw('e.rejected_by'))}
     where e.business_id = ${ctx.businessId} and e.id = ${id} and e.deleted_at is null
  `)) as unknown as ExpenseRecord[]
  if (!row) throw new AppError('not_found')
  return {
    id: row.id,
    status: row.status,
    categoryId: row.category_id,
    categoryName: row.category_name,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    locationId: row.location_id,
    businessDate: row.business_date,
    periodMonth: row.period_month,
    documentType: row.document_type,
    reference: row.reference,
    description: row.description,
    paymentMethod: row.payment_method,
    paidByMemberId: row.paid_by_member_id,
    paidByMemberName: row.paid_by_member_name,
    pricesIncludeVat: row.prices_include_vat,
    vatNotReclaimable: row.vat_not_reclaimable,
    currency: row.currency,
    amount: row.amount,
    vatRate: row.vat_rate,
    netTotal: row.net_total,
    vatTotal: row.vat_total,
    total: row.total,
    vatInCost: row.vat_in_cost,
    costTotal: row.cost_total,
    notes: row.notes,
    attachmentCount: row.attachment_count,
    approvalRequired: approvalRequired(ctx, row.expense_approval),
    createdBy: { memberId: row.created_by_id, name: row.created_by_name },
    submittedAt: isoOf(row.submitted_at),
    submittedBy: memberName(row.submitted_at, row.submitted_by_id, row.submitted_by_name),
    approvedAt: isoOf(row.approved_at),
    approvedBy: memberName(row.approved_at, row.approved_by_id, row.approved_by_name),
    rejectedAt: isoOf(row.rejected_at),
    rejectedBy: memberName(row.rejected_at, row.rejected_by_id, row.rejected_by_name),
    rejectionReason: row.rejection_reason,
    postedAt: isoOf(row.posted_at),
    reversedAt: isoOf(row.reversed_at),
    reversalDate: row.reversal_date,
    copiedFromId: row.copied_from_id,
    pays: paysDtoOf(ctx, row),
    createdAt: isoOf(row.created_at),
    version: row.version,
  }
}

/** An envelope for redaction (the redact middleware fills meta.redacted). */
function result(data: ExpenseDto): ExpenseResultDto {
  return { data, meta: { redacted: [] } }
}

/** `expense.get`. */
export function getExpense(ctx: BusinessCtx, input: IdInput): Promise<ExpenseResultDto> {
  return ctx.tx(async (tx) => result(await readExpense(tx, ctx, input.id)))
}

interface ListRecord extends Record<string, unknown> {
  id: string
  status: ExpenseStatus
  business_date: string
  period_month: string
  category_id: string
  category_name: string
  supplier_id: string | null
  supplier_name: string | null
  description: string | null
  reference: string | null
  document_type: PurchaseDocumentType
  payment_method: ExpenseDto['paymentMethod']
  currency: string
  total: string
  created_by_id: string | null
  created_by_name: string | null
  pays: ExpensePays | null
  running_cost_id: string | null
  running_cost_name: string | null
  version: number
}

/**
 * `expense.list`: newest business day first, with filters (among them the month the expenses are for,
 * whatever their bills' dates) and a cursor.
 */
export async function listExpenses(ctx: BusinessCtx, input: ListInput): Promise<ExpenseListDto> {
  const conditions = [sql`e.business_id = ${ctx.businessId}`, sql`e.deleted_at is null`]
  if (input.status !== 'all') conditions.push(sql`e.status = ${input.status}`)
  if (input.enteredBy === 'others') {
    conditions.push(sql`e.created_by is distinct from app.current_user_id()`)
  }
  if (input.categoryId) conditions.push(sql`e.category_id = ${input.categoryId}`)
  if (input.supplierId) conditions.push(sql`e.supplier_id = ${input.supplierId}`)
  if (input.periodMonth) {
    conditions.push(sql`e.period_month = ${firstDayOf(input.periodMonth)}::date`)
  }
  if (input.from) conditions.push(sql`e.business_date >= ${input.from}::date`)
  if (input.to) conditions.push(sql`e.business_date <= ${input.to}::date`)
  if (input.search) {
    const pattern = containsPattern(input.search)
    conditions.push(sql`(e.reference ilike ${pattern} or e.description ilike ${pattern}
      or s.name ilike ${pattern} or c.name ilike ${pattern})`)
  }
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cursor.key)) {
      throw new AppError('validation', { message: 'invalid cursor' })
    }
    conditions.push(sql`(e.business_date, e.id) < (${cursor.key}::date, ${cursor.id}::uuid)`)
  }
  return ctx.tx(async (tx) => {
    // A filter names a category or a supplier of this business (NOT_FOUND otherwise).
    if (input.categoryId) await assertCategoryExists(tx, ctx.businessId, input.categoryId)
    if (input.supplierId) await assertSupplier(tx, ctx.businessId, input.supplierId)
    const rows = (await tx.execute(sql`
      select e.id, e.status, e.business_date::text as business_date,
             to_char(e.period_month, 'YYYY-MM') as period_month, e.category_id,
             c.name as category_name, e.supplier_id, s.name as supplier_name, e.description,
             e.reference, e.document_type, e.payment_method, trim(e.currency) as currency,
             trim_scale(e.total)::text as total, cb.id as created_by_id,
             cb.display_name as created_by_name, e.pays, e.running_cost_id,
             rc.name as running_cost_name, e.version
        from app.expenses e
        join app.cost_categories c on c.business_id = e.business_id and c.id = e.category_id
        left join app.suppliers s on s.business_id = e.business_id and s.id = e.supplier_id
        left join app.running_costs rc
          on rc.business_id = e.business_id and rc.id = e.running_cost_id
        left join app.business_members cb
          on cb.business_id = e.business_id and cb.id = ${memberOf(sql.raw('e.created_by'))}
       where ${sql.join(conditions, sql` and `)}
       order by e.business_date desc, e.id desc
       limit ${input.limit + 1}
    `)) as unknown as ListRecord[]
    const page = rows.slice(0, input.limit)
    const last = page.at(-1)
    return {
      data: {
        items: page.map((r) => ({
          id: r.id,
          status: r.status,
          businessDate: r.business_date,
          periodMonth: r.period_month,
          categoryId: r.category_id,
          categoryName: r.category_name,
          supplierId: r.supplier_id,
          supplierName: r.supplier_name,
          description: r.description,
          reference: r.reference,
          documentType: r.document_type,
          paymentMethod: r.payment_method,
          currency: r.currency,
          total: r.total,
          createdBy: { memberId: r.created_by_id, name: r.created_by_name },
          pays: paysDtoOf(ctx, r),
          version: r.version,
        })),
        nextCursor:
          rows.length > input.limit && last
            ? encodeCursor({ key: last.business_date, id: last.id })
            : null,
      },
      meta: { redacted: [] },
    }
  })
}

// ---------------------------------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------------------------------

/** An expense's document amounts; VALIDATION with the domain's code when they cannot be computed. */
function amountsOf(
  fields: Pick<Fields, 'amount' | 'vatRate' | 'pricesIncludeVat'>,
  inCost: boolean,
  currency: CurrencyCode,
) {
  const input = {
    amount: fields.amount as Money,
    vatRate: fields.vatRate as Percent,
    pricesIncludeVat: fields.pricesIncludeVat,
    vatInCost: inCost,
  }
  const error = expenseError(input, currency)
  if (error) throw invalid(`amount: ${error}`)
  const amounts = computeExpense(input, currency)
  // An amount that fits its column can still give a total with VAT that does not (D-176).
  const { net, vat, total, cost } = amounts
  if ([net, vat, total, cost].some((value) => checkDecimal(value, 'money') !== null)) {
    throw invalid('amount: too large with its VAT')
  }
  return amounts
}

/**
 * The month a draft is for, as its first day: the one given (VALIDATION unless from 12 months before
 * the bill's month to 1 month after it; a closed month is refused only when it is sent or finalized);
 * left out, the one it has when that still fits its bill's date (`stored`, an update), else the month
 * before the bill's date in a category billed the month after, else the bill's month, never a month
 * the books are closed through (then the first open one, D-200).
 */
function periodMonthOf(
  input: Pick<Fields, 'periodMonth' | 'businessDate'>,
  billedNextMonth: boolean,
  stored: string | null,
  closedThrough: string | null,
): string {
  if (input.periodMonth !== undefined) {
    if (!periodMonthAllowed(input.periodMonth, input.businessDate)) {
      throw invalid('periodMonth: from 12 months before the bill to 1 month after it')
    }
    return firstDayOf(input.periodMonth)
  }
  if (stored !== null && periodMonthAllowed(monthOf(stored), input.businessDate)) return stored
  const month = defaultPeriodMonth(input.businessDate, billedNextMonth, closedThrough)
  // The month before a bill of January of year 1 would be in year 0, which no date has.
  if (!periodMonthAllowed(month, input.businessDate)) {
    throw invalid('periodMonth: the month before the bill is not a month a date can have')
  }
  return firstDayOf(month)
}

/**
 * An expense is sent for approval or finalized only for a month still open (D-200): BOOKS_CLOSED once
 * the books are closed through the last day of its month (`periodMonth`, its first day), as for a bill
 * dated on or before the books-closed date (assertPostable).
 */
function assertPeriodOpen(business: PostingBusiness, periodMonth: string): void {
  if (periodMonthClosed(monthOf(periodMonth), business.closedThrough)) {
    throw new AppError('books_closed')
  }
}

/**
 * Checks a draft's category (a live one; an archived one only when it already has it), supplier,
 * who paid, location, month, VAT (none unless VAT-registered) and what it pays (resolvePays), and
 * computes its amounts. Returns its columns. `current`: what the expense being saved has (its
 * category, month, payment method and what it pays), null for a new one.
 */
async function prepareDraft(
  tx: Tx,
  ctx: BusinessCtx,
  input: Fields,
  current: {
    categoryId: string
    periodMonth: string
    paymentMethod: string
    pays: StoredPays
  } | null,
) {
  assertVatShown(ctx, {
    rates: [input.vatRate],
    pricesIncludeVat: input.pricesIncludeVat,
    vatNotReclaimable: input.vatNotReclaimable,
  })
  assertPaidByShown(ctx, input.paymentMethod, current?.paymentMethod ?? null)
  const { currency, defaultLocationId, closedThrough } = await draftContext(tx, ctx.businessId)
  const category = await assertCategory(
    tx,
    ctx.businessId,
    input.categoryId,
    current?.categoryId ?? null,
  )
  const periodMonth = periodMonthOf(
    input,
    category.billedNextMonth,
    current?.periodMonth ?? null,
    closedThrough,
  )
  await assertSupplier(tx, ctx.businessId, input.supplierId)
  await assertPaidBy(tx, ctx.businessId, input)
  const locationId = await resolveLocation(tx, ctx, input.locationId, defaultLocationId)
  // What it pays was said for its category: a new category asks again (D-216), whoever moves it and
  // with Running Costs off too (D-217).
  const pays = await resolvePays(
    tx,
    ctx,
    { categoryId: input.categoryId, periodMonth },
    input.pays,
    current !== null && current.categoryId === input.categoryId ? current.pays : NOTHING_SAID,
    false,
  )
  // A draft's document amounts do not depend on the VAT rule; what it costs is fixed at posting.
  const amounts = amountsOf(input, false, currency)
  return {
    categoryId: input.categoryId,
    supplierId: input.supplierId,
    locationId,
    businessDate: input.businessDate,
    periodMonth,
    documentType: input.documentType,
    reference: input.reference,
    description: input.description,
    paymentMethod: input.paymentMethod,
    paidByMemberId: input.paidByMemberId,
    pricesIncludeVat: input.pricesIncludeVat,
    vatNotReclaimable: input.vatNotReclaimable,
    currency,
    amount: input.amount,
    vatRate: input.vatRate,
    netTotal: amounts.net,
    vatTotal: amounts.vat,
    total: amounts.total,
    notes: input.notes,
    pays: pays.pays,
    runningCostId: pays.runningCostId,
  } satisfies Omit<NewExpense, 'id' | 'businessId'>
}

/**
 * Only a member who may see running costs says what an expense pays (D-216): FORBIDDEN otherwise,
 * before anything is read, whenever `pays` is not left out (null too).
 */
function assertMaySayPays(ctx: BusinessCtx, pays: ExpensePaysInput | null | undefined) {
  if (pays !== undefined && !mayReadRunningCosts(ctx)) throw new AppError('forbidden')
}

/**
 * `expense.create`: a draft, idempotent on the client's id (the same payload again returns it; an id
 * used by another create or another business is CONFLICT).
 */
export function createExpense(ctx: BusinessCtx, input: CreateInput): Promise<ExpenseResultDto> {
  const { id, ...fields } = input
  assertMaySayPays(ctx, input.pays)
  return ctx.tx(async (tx) => {
    const values = await prepareDraft(tx, ctx, fields, null)
    const { row } = await createIdempotent(tx, expenses, {
      id,
      businessId: ctx.businessId,
      ...values,
      requestHash: requestHashOf(fields),
    })
    if (row.deletedAt !== null) throw new AppError('conflict', { message: 'expense was discarded' })
    return result(await readExpense(tx, ctx, id))
  })
}

interface HeadRecord extends Record<string, unknown> {
  id: string
  status: ExpenseStatus
  version: number
  business_date: string
  /** The first day of the month it is for. */
  period_month: string
  category_id: string
  location_id: string
  document_type: PurchaseDocumentType
  payment_method: ExpenseDto['paymentMethod']
  paid_by_member_id: string | null
  prices_include_vat: boolean
  vat_not_reclaimable: boolean
  currency: string
  amount: string
  vat_rate: string
  approved_at: Date | string | null
  rejected_at: Date | string | null
  pays: ExpensePays | null
  running_cost_id: string | null
  /** The caller entered it (created_by). */
  entered_by_me: boolean
}

/** What the locked expense says it pays. */
function storedPaysOf(head: HeadRecord): StoredPays {
  return { pays: head.pays, runningCostId: head.running_cost_id }
}

/** The expense row, locked FOR UPDATE; NOT_FOUND when not live. */
async function lockExpense(tx: Tx, businessId: string, id: string): Promise<HeadRecord> {
  const [row] = (await tx.execute(sql`
    select e.id, e.status, e.version, e.business_date::text as business_date,
           e.period_month::text as period_month, e.category_id,
           e.location_id, e.document_type, e.payment_method, e.paid_by_member_id,
           e.prices_include_vat, e.vat_not_reclaimable, trim(e.currency) as currency,
           trim_scale(e.amount)::text as amount, trim_scale(e.vat_rate)::text as vat_rate,
           e.approved_at, e.rejected_at, e.pays, e.running_cost_id,
           coalesce(e.created_by = app.current_user_id(), false) as entered_by_me
      from app.expenses e
     where e.business_id = ${businessId} and e.id = ${id} and e.deleted_at is null
       for update
  `)) as unknown as HeadRecord[]
  if (!row) throw new AppError('not_found')
  return row
}

/** The business's approval setting, with its row locked FOR SHARE (after the expense's lock). */
async function lockApprovalSetting(tx: Tx, businessId: string): Promise<boolean> {
  const [row] = (await tx.execute(sql`
    select b.expense_approval from app.businesses b
     where b.id = ${businessId} and b.deleted_at is null
       for share
  `)) as unknown as { expense_approval: boolean }[]
  if (!row) throw new AppError('forbidden')
  return row.expense_approval
}

/**
 * Where `action` takes the expense for this caller (the approval rules of @bizcost/domain), or the
 * refusal as an API error. `setting`: the business's approval setting, read under its lock when the
 * action depends on it.
 */
function transitionOf(ctx: BusinessCtx, action: ExpenseAction, head: HeadRecord, setting: boolean) {
  const transition = expenseTransition(action, {
    status: head.status,
    approvalRequired: approvalRequired(ctx, setting),
    mayApprove: can(ctx.access.effective, 'expenses.documents.approve'),
  })
  if (!transition.ok) throw new AppError(transition.refusal)
  return transition
}

/** The version the caller read must be the expense's (CONFLICT otherwise). */
function assertVersion(head: HeadRecord, version: number) {
  if (head.version !== version) throw new AppError('conflict')
}

async function setColumns(
  tx: Tx,
  businessId: string,
  id: string,
  values: PgUpdateSetSource<typeof expenses>,
) {
  await tx
    .update(expenses)
    .set(values)
    .where(and(eq(expenses.businessId, businessId), eq(expenses.id, id)))
}

/**
 * `expense.update`: the whole draft (or rejected expense, which becomes a draft again), `version` as
 * read. EXPENSE_IN_APPROVAL while it is sent for approval, DOCUMENT_POSTED once final; FORBIDDEN for
 * another member's expense when the caller may not see supplier prices (assertMayChange).
 */
export function updateExpense(ctx: BusinessCtx, input: UpdateInput): Promise<ExpenseResultDto> {
  const { id, version, ...fields } = input
  assertMaySayPays(ctx, input.pays)
  return ctx.tx(async (tx) => {
    const head = await lockExpense(tx, ctx.businessId, id)
    assertMayChange(ctx, head)
    const transition = transitionOf(ctx, 'update', head, false)
    assertVersion(head, version)
    const values = await prepareDraft(tx, ctx, fields, {
      categoryId: head.category_id,
      periodMonth: head.period_month,
      paymentMethod: head.payment_method,
      pays: storedPaysOf(head),
    })
    await setColumns(tx, ctx.businessId, id, { ...values, status: transition.to })
    return result(await readExpense(tx, ctx, id))
  })
}

/**
 * `expense.discard`: a draft (or rejected expense) is taken out (soft-deleted); never one sent for
 * approval or final. Its receipts go with it: taken off in the same transaction, their files removed
 * after it. FORBIDDEN for another member's expense when the caller may not see supplier prices.
 */
export async function discardExpense(ctx: BusinessCtx, input: VersionInput): Promise<OkDto> {
  const files = await ctx.tx(async (tx) => {
    const head = await lockExpense(tx, ctx.businessId, input.id)
    assertMayChange(ctx, head)
    transitionOf(ctx, 'discard', head, false)
    assertVersion(head, input.version)
    const paths = await detachAll(tx, ctx.businessId, 'expense', input.id)
    await setColumns(tx, ctx.businessId, input.id, { deletedAt: sql`now()` })
    return paths
  })
  await removeStoredFiles(ctx, files)
  return { ok: true as const }
}

// ---------------------------------------------------------------------------------------------------
// Approval (D-164)
// ---------------------------------------------------------------------------------------------------

/**
 * `expense.submit`: a draft (or rejected expense) is sent for approval, `version` as read.
 * APPROVAL_OFF when the business does not require approval; FUTURE_DATE for a day after today and
 * BOOKS_CLOSED for one on or before the books-closed date, or for a month the books are closed through
 * (it could not be finalized, D-200); FORBIDDEN for
 * another member's expense when the caller may not see supplier prices. Idempotent: an expense
 * already sent (or approved) is returned as it is.
 */
export function submitExpense(ctx: BusinessCtx, input: VersionInput): Promise<ExpenseResultDto> {
  return ctx.tx(async (tx) => {
    const head = await lockExpense(tx, ctx.businessId, input.id)
    assertMayChange(ctx, head)
    const setting = await lockApprovalSetting(tx, ctx.businessId)
    const transition = transitionOf(ctx, 'submit', head, setting)
    if (transition.changes) {
      assertVersion(head, input.version)
      // A day it could not be finalized on is refused now (FUTURE_DATE, BOOKS_CLOSED): once sent
      // it is frozen, and only a rejection would let its day be changed (D-176).
      const business = await lockPostingBusiness(tx, ctx.businessId)
      assertPostable(business, head.business_date)
      assertPeriodOpen(business, head.period_month)
      if (head.paid_by_member_id !== null) {
        await assertActivePayer(tx, ctx.businessId, head.paid_by_member_id)
      }
      await setColumns(tx, ctx.businessId, input.id, {
        status: 'submitted',
        submittedAt: sql`now()`,
        submittedBy: sql`app.current_user_id()`,
        rejectedAt: null,
        rejectedBy: null,
        rejectionReason: null,
      })
    }
    return result(await readExpense(tx, ctx, input.id))
  })
}

/**
 * `expense.approve` (expenses.documents.approve): an expense sent for approval is approved, `version`
 * as read (what was sent is what is approved), with what it pays when the approver says it (D-216:
 * resolvePays; left out, what it says stays). EXPENSE_NOT_SUBMITTED for a draft or a rejected one;
 * FORBIDDEN for a member who may not see supplier prices (D-175), or who says what it pays without
 * seeing running costs. Idempotent: an expense already approved is returned as it is (what it pays
 * is then said when it is finalized).
 */
export function approveExpense(ctx: BusinessCtx, input: ReviewInput): Promise<ExpenseResultDto> {
  assertSeesWhatIsReviewed(ctx)
  assertMaySayPays(ctx, input.pays)
  return ctx.tx(async (tx) => {
    const head = await lockExpense(tx, ctx.businessId, input.id)
    const transition = transitionOf(ctx, 'approve', head, false)
    if (transition.changes) {
      assertVersion(head, input.version)
      const pays =
        input.pays === undefined
          ? storedPaysOf(head)
          : await resolvePays(
              tx,
              ctx,
              { categoryId: head.category_id, periodMonth: head.period_month },
              input.pays,
              storedPaysOf(head),
              false,
            )
      await setColumns(tx, ctx.businessId, input.id, {
        status: 'approved',
        approvedAt: sql`now()`,
        approvedBy: sql`app.current_user_id()`,
        rejectedAt: null,
        rejectedBy: null,
        rejectionReason: null,
        pays: pays.pays,
        runningCostId: pays.runningCostId,
      })
    }
    return result(await readExpense(tx, ctx, input.id))
  })
}

/**
 * `expense.reject` (expenses.documents.approve): an expense sent for approval (or approved and not
 * yet final) goes back to the one who entered it, with an optional reason; it is then edited like a
 * draft. FORBIDDEN for a member who may not see supplier prices (D-175). Idempotent.
 */
export function rejectExpense(ctx: BusinessCtx, input: RejectInput): Promise<ExpenseResultDto> {
  assertSeesWhatIsReviewed(ctx)
  return ctx.tx(async (tx) => {
    const head = await lockExpense(tx, ctx.businessId, input.id)
    const transition = transitionOf(ctx, 'reject', head, false)
    if (transition.changes) {
      assertVersion(head, input.version)
      await setColumns(tx, ctx.businessId, input.id, {
        status: 'rejected',
        rejectedAt: sql`now()`,
        rejectedBy: sql`app.current_user_id()`,
        rejectionReason: input.reason,
        approvedAt: null,
        approvedBy: null,
      })
    }
    return result(await readExpense(tx, ctx, input.id))
  })
}

// ---------------------------------------------------------------------------------------------------
// Posting, reversal and correction
// ---------------------------------------------------------------------------------------------------

/**
 * `expense.post` ("Finalize"): the expense (its `version` as read) counts from now, and what it cost
 * the business is fixed (net, and its VAT when it cannot be reclaimed; D-114 rule 4). With approval
 * required, an approved expense is posted by anyone who may post; a draft or a submitted one only by
 * a member who may also approve (their approval is recorded with it), APPROVAL_REQUIRED otherwise,
 * and who sees its amounts (FORBIDDEN otherwise, D-175). A rejection it had is cleared. Idempotent:
 * an expense already posted (or reversed since) is returned as it is. What it pays (D-216) is said
 * with it or was said before: required whenever its category has a running cost a bill for its month
 * can pay (RUNNING_COST_CHOICE_REQUIRED; resolvePays), and checked again (the running cost may have
 * changed since). Refused: a date after today (FUTURE_DATE) or on or before the books-closed date, or
 * for a month the books are closed through (BOOKS_CLOSED, D-200), paid by a member who is no longer
 * an active member (NOT_FOUND), a location removed since it was saved (VALIDATION).
 */
export function postExpense(ctx: BusinessCtx, input: ReviewInput): Promise<ExpenseResultDto> {
  assertMaySayPays(ctx, input.pays)
  return ctx.tx(async (tx) => {
    const head = await lockExpense(tx, ctx.businessId, input.id)
    const setting = await lockApprovalSetting(tx, ctx.businessId)
    const transition = transitionOf(ctx, 'post', head, setting)
    if (!transition.changes) return result(await readExpense(tx, ctx, input.id))
    assertVersion(head, input.version)
    // With approval required and not yet approved, the poster may approve: their approval is it, so
    // they must see what they approve (D-175).
    const approvedNow = approvalRequired(ctx, setting) && head.approved_at === null
    if (approvedNow) assertSeesWhatIsReviewed(ctx)
    const business = await lockPostingBusiness(tx, ctx.businessId)
    assertPostable(business, head.business_date)
    assertPeriodOpen(business, head.period_month)
    if (head.paid_by_member_id !== null) {
      await assertActivePayer(tx, ctx.businessId, head.paid_by_member_id)
    }
    const [location] = (await tx.execute(sql`
      select l.id from app.locations l
       where l.business_id = ${ctx.businessId} and l.id = ${head.location_id}
         and l.deleted_at is null
    `)) as unknown as { id: string }[]
    if (!location) throw invalid('location: removed since the expense was saved')
    const pays = await resolvePays(
      tx,
      ctx,
      { categoryId: head.category_id, periodMonth: head.period_month },
      input.pays,
      storedPaysOf(head),
      true,
    )
    if (!isCurrencyCode(head.currency)) throw invalid(`currency: ${head.currency} is not supported`)
    const inCost = vatInCost({
      vatRegistered: business.vatRegistered,
      documentType: head.document_type,
      vatNotReclaimable: head.vat_not_reclaimable,
    })
    const amounts = amountsOf(
      { amount: head.amount, vatRate: head.vat_rate, pricesIncludeVat: head.prices_include_vat },
      inCost,
      head.currency,
    )
    await setColumns(tx, ctx.businessId, input.id, {
      status: 'posted',
      postedAt: sql`now()`,
      postedBy: sql`app.current_user_id()`,
      vatInCost: inCost,
      costTotal: amounts.cost,
      pays: pays.pays,
      runningCostId: pays.runningCostId,
      ...(approvedNow
        ? {
            approvedAt: sql`now()`,
            approvedBy: sql`app.current_user_id()`,
          }
        : {}),
      // A rejected expense finalized after all (as it is, or edited into a draft since): the
      // rejection no longer stands, so a final expense never reads "rejected" (D-175).
      ...(head.rejected_at !== null
        ? { rejectedAt: null, rejectedBy: null, rejectionReason: null }
        : {}),
    })
    return result(await readExpense(tx, ctx, input.id))
  })
}

/**
 * Reverses a posted expense in `tx` (already reversed: nothing to do): it stops counting, dated on
 * its own day or the first open day (D-114 rule 3; BOOKS_CLOSED when that is after today), counted in
 * its own month or the first open month (D-200).
 * EXPENSE_HAS_PAYMENTS while payments recorded on it stand (they are reversed first; the expense is
 * locked first, as recording a payment locks it, so neither slips past the other).
 */
async function reverseInTx(tx: Tx, ctx: BusinessCtx, id: string): Promise<void> {
  const head = await lockExpense(tx, ctx.businessId, id)
  const transition = transitionOf(ctx, 'reverse', head, false)
  if (!transition.changes) return
  const [paid] = (await tx.execute(sql`
    select count(*)::int as n from app.expense_payments ep
     where ep.business_id = ${ctx.businessId} and ep.expense_id = ${id}
       and ep.reversed_at is null and ep.deleted_at is null
  `)) as unknown as { n: number }[]
  if ((paid?.n ?? 0) > 0) throw new AppError('expense_has_payments')
  const business = await lockPostingBusiness(tx, ctx.businessId)
  const reversalDate = reversalDateOf(business, head.business_date)
  // It counts in the expense's own month, or the first open month when the books are closed through
  // the end of it (D-200), as its date moves to the first open day.
  const month = monthOf(head.period_month)
  const reversalMonth = periodMonthClosed(month, business.closedThrough)
    ? (firstOpenMonth(business.closedThrough) ?? month)
    : month
  await setColumns(tx, ctx.businessId, id, {
    status: 'reversed',
    reversedAt: sql`now()`,
    reversedBy: sql`app.current_user_id()`,
    reversalDate,
    reversalPeriodMonth: firstDayOf(reversalMonth),
  })
}

/** `expense.reverse`: see reverseInTx. Idempotent. */
export function reverseExpense(ctx: BusinessCtx, input: IdInput): Promise<ExpenseResultDto> {
  return ctx.tx(async (tx) => {
    await reverseInTx(tx, ctx, input.id)
    return result(await readExpense(tx, ctx, input.id))
  })
}

/**
 * `expense.correct` (reverse + a new draft copy, as purchase.correct): reverses the expense (when
 * still posted) and opens a copy of it as a new draft with the client's `newId`, in one transaction.
 * Idempotent on `newId`: the same call again returns the copy; an id used otherwise is CONFLICT. An
 * expense not final cannot be corrected (DOCUMENT_NOT_POSTED): it is edited. FORBIDDEN for a member
 * who may not see supplier prices, before anything is read: the copy carries the expense's amounts,
 * which the one who corrects it goes on to edit (D-184; as reviewing, D-175).
 */
export function correctExpense(ctx: BusinessCtx, input: CorrectInput): Promise<ExpenseResultDto> {
  assertSeesWhatIsReviewed(ctx)
  return ctx.tx(async (tx) => {
    // The expense first (the reversal's lock): two corrections wait for each other here, before
    // either inserts a copy that names it.
    const head = await lockExpense(tx, ctx.businessId, input.id)
    const requestHash = requestHashOf({ correct: input.id })
    const [existing] = (await tx.execute(sql`
      select e.id, e.request_hash, e.created_by = app.current_user_id() as mine, e.deleted_at
        from app.expenses e
       where e.business_id = ${ctx.businessId} and e.id = ${input.newId}
    `)) as unknown as {
      id: string
      request_hash: string | null
      mine: boolean
      deleted_at: Date | string | null
    }[]
    if (existing) {
      if (existing.request_hash !== requestHash || !existing.mine || existing.deleted_at) {
        throw new AppError('conflict')
      }
      return result(await readExpense(tx, ctx, input.newId))
    }
    if (head.status !== 'posted' && head.status !== 'reversed') {
      throw new AppError('document_not_posted')
    }
    const [source] = await tx
      .select()
      .from(expenses)
      .where(
        and(
          eq(expenses.businessId, ctx.businessId),
          eq(expenses.id, input.id),
          isNull(expenses.deletedAt),
        ),
      )
    if (!source) throw new AppError('not_found')
    const { currency, defaultLocationId } = await draftContext(tx, ctx.businessId)
    const [location] = (await tx.execute(sql`
      select l.id from app.locations l
       where l.business_id = ${ctx.businessId} and l.id = ${source.locationId}
         and l.deleted_at is null
    `)) as unknown as { id: string }[]
    // The copy's row first: an id used anywhere (another business too) is CONFLICT before anything
    // else happens; everything is rolled back with it.
    await tx.insert(expenses).values({
      id: input.newId,
      businessId: ctx.businessId,
      categoryId: source.categoryId,
      supplierId: source.supplierId,
      locationId: location?.id ?? defaultLocationId ?? source.locationId,
      businessDate: source.businessDate,
      periodMonth: source.periodMonth,
      documentType: source.documentType,
      reference: source.reference,
      description: source.description,
      // A member who paid and has since left is copied too: posting refuses it (NOT_FOUND) until
      // someone else is chosen.
      paymentMethod: source.paymentMethod,
      paidByMemberId: source.paidByMemberId,
      pricesIncludeVat: source.pricesIncludeVat,
      vatNotReclaimable: source.vatNotReclaimable,
      currency,
      amount: source.amount,
      vatRate: source.vatRate,
      netTotal: source.netTotal,
      vatTotal: source.vatTotal,
      total: source.total,
      notes: source.notes,
      // What it paid stays (D-216): checked again when the copy is finalized.
      pays: source.pays,
      runningCostId: source.runningCostId,
      copiedFromId: input.id,
      requestHash,
    })
    await reverseInTx(tx, ctx, input.id)
    return result(await readExpense(tx, ctx, input.newId))
  })
}

// ---------------------------------------------------------------------------------------------------
// The approval setting (D-164)
// ---------------------------------------------------------------------------------------------------

async function readSettings(tx: Tx, ctx: BusinessCtx): Promise<ExpenseSettingsDto> {
  const [row] = (await tx.execute(sql`
    select b.expense_approval from app.businesses b
     where b.id = ${ctx.businessId} and b.deleted_at is null
  `)) as unknown as { expense_approval: boolean }[]
  if (!row) throw new AppError('forbidden')
  return {
    approval: row.expense_approval,
    approvalRequired: approvalRequired(ctx, row.expense_approval),
    hasTeam: ctx.access.capabilities.has_team,
  }
}

/** `expense.settings` (expenses.documents.view): whether expenses need approval. */
export function getExpenseSettings(ctx: BusinessCtx): Promise<ExpenseSettingsDto> {
  return ctx.tx((tx) => readSettings(tx, ctx))
}

/**
 * `expense.updateSettings` (expenses.approval.manage; the business needs a team, CAPABILITY_DISABLED
 * otherwise): expenses need approval before they are final, or not. Audited (businesses). Turning it
 * off lets expenses already sent be finalized directly; turning it on sends drafts through approval.
 */
export function updateExpenseSettings(
  ctx: BusinessCtx,
  input: SettingsInput,
): Promise<ExpenseSettingsDto> {
  if (!ctx.access.capabilities.has_team) throw new AppError('capability_disabled')
  return ctx.tx(async (tx) => {
    await tx
      .update(businesses)
      .set({ expenseApproval: input.approval })
      .where(eq(businesses.id, ctx.businessId))
    return readSettings(tx, ctx)
  })
}
