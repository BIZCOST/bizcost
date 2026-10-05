import {
  EXPENSE_PAYS,
  EXPENSE_STATUSES,
  PAYMENT_METHODS,
  PURCHASE_DOCUMENT_TYPES,
  RUNNING_COST_FREQUENCIES,
  SETTLEMENT_METHODS,
  type ExpensePays,
  type ExpenseStatus,
  type PaymentMethod,
  type PurchaseDocumentType,
  type RunningCostFrequency,
  type SettlementMethod,
} from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  numeric,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { timestamptz } from './_app'
import { tenantRef, tenantTable } from './_helpers'
import { businessMembers } from './access'
import { locations } from './locations'
import { salesChannels } from './sales'
import { suppliers } from './suppliers'

// Expenses and Running Costs (M2 Step 5; docs/DATA_MODEL.md §6; D-114, D-116, D-164–D-170). One
// category list shared by both (D-116). An expense is one amount in one category, draft → (approval)
// → posted → reversed; it never touches stock. A running cost is a regular amount per period, turned
// into a monthly amount on read; it is never posted. The value lists of the CHECKs come from
// @bizcost/domain, so code and database cannot disagree.

const quoted = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '))

const money = (name: string) => numeric(name, { precision: 20, scale: 4 })
const percent = (name: string) => numeric(name, { precision: 9, scale: 6 })

/**
 * The categories that expenses and running costs share (D-116). Each business starts with the owner's
 * list, named in its language when it is set up (existing businesses by the expenses_security
 * migration); then they are plain data. One name per business, compared the way people read it
 * (app.name_key, as materials; archived ones included). Archived: hidden from pickers, kept on what
 * uses it; never deleted.
 */
export const costCategories = tenantTable(
  'cost_categories',
  {
    name: text('name').notNull(),
    archivedAt: timestamptz('archived_at'),
    // Its bills usually come the month after the month they are for (electricity, water, internet,
    // phone among the starter categories): a new expense's month defaults to the month before its
    // bill's date (the owner's request of 2026-09-30).
    billedNextMonth: boolean('billed_next_month').notNull().default(false),
  },
  (t) => [
    uniqueIndex('cost_categories_name_key')
      .on(t.businessId, sql`app.name_key(name)`)
      .where(sql`deleted_at is null`),
    check('cost_categories_name_check', sql`btrim(name) <> '' and char_length(name) <= 100`),
  ],
)

/**
 * A running cost ("What do you pay to run your business?", D-116): a regular amount per period in a
 * category (rent, salaries, the licence…), from `starts_on` until `ends_on` (null: still paid). Its
 * monthly amount (monthlyAmount in @bizcost/domain) is worked out on read; Step 6 shares the monthly
 * total over product costs. Never posted: a change of amount ends one and starts another, or edits
 * it. A running cost entered by mistake is removed (soft-deleted, audited).
 */
export const runningCosts = tenantTable(
  'running_costs',
  {
    name: text('name').notNull(),
    categoryId: uuid('category_id').notNull(),
    // What it costs the business each period (for a VAT-registered business, without the VAT it
    // reclaims), in the business's currency.
    amount: money('amount').notNull(),
    frequency: text('frequency').$type<RunningCostFrequency>().notNull().default('monthly'),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }),
    notes: text('notes'),
  },
  (t) => [
    tenantRef('running_costs_category_fk', [t.businessId, t.categoryId], costCategories),
    index('running_costs_category_idx').on(t.businessId, t.categoryId),
    check('running_costs_name_check', sql`btrim(name) <> '' and char_length(name) <= 100`),
    check('running_costs_amount_check', sql`amount > 0`),
    check('running_costs_frequency_check', sql`frequency in (${quoted(RUNNING_COST_FREQUENCIES)})`),
    check('running_costs_dates_check', sql`ends_on >= starts_on`),
    check('running_costs_notes_check', sql`char_length(notes) <= 1000`),
  ],
)

/**
 * An expense (PRODUCT.md §4 rule 13): one amount in a category, on a business day, at a location
 * (the default one unless the business has branches), with the document it came with (independent of
 * how it was paid) and an optional supplier. `amount` is as typed, before VAT or with its VAT
 * (`prices_include_vat`); net, VAT and total are computed by the API on every save and frozen at
 * posting, with what it cost the business (`cost_total`: VAT in it only when it cannot be reclaimed,
 * `vat_in_cost`, D-114 rule 4). How it was paid is required (D-159's methods): on credit it needs its
 * supplier; paid personally names the member. With approval on, `submitted_*`, `approved_*` and
 * `rejected_*` record the review (D-164).
 */
export const expenses = tenantTable(
  'expenses',
  {
    categoryId: uuid('category_id').notNull(),
    supplierId: uuid('supplier_id'),
    locationId: uuid('location_id').notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    // The month the bill is for (its first day): this month's electricity, billed next month, is for
    // this month. From 12 months before the bill's month to 1 month after it (the owner's request of
    // 2026-09-30). Real profit (Phase 3) counts the expense in this month.
    periodMonth: date('period_month', { mode: 'string' }).notNull(),
    documentType: text('document_type').$type<PurchaseDocumentType>().notNull(),
    // The supplier's invoice or receipt number.
    reference: text('reference'),
    // What it was for, in a few words ("Printer ink").
    description: text('description'),
    paymentMethod: text('payment_method').$type<PaymentMethod>().notNull(),
    paidByMemberId: uuid('paid_by_member_id'),
    pricesIncludeVat: boolean('prices_include_vat').notNull().default(false),
    vatNotReclaimable: boolean('vat_not_reclaimable').notNull().default(false),
    currency: char('currency', { length: 3 }).notNull(),
    // As typed (with its VAT when prices_include_vat), and the VAT rate the bill shows.
    amount: money('amount').notNull(),
    vatRate: percent('vat_rate').notNull().default('0'),
    // Computed (computeExpense) on every save of a draft; frozen at posting.
    netTotal: money('net_total').notNull(),
    vatTotal: money('vat_total').notNull(),
    total: money('total').notNull(),
    notes: text('notes'),
    status: text('status').$type<ExpenseStatus>().notNull().default('draft'),
    submittedAt: timestamptz('submitted_at'),
    submittedBy: uuid('submitted_by'),
    approvedAt: timestamptz('approved_at'),
    approvedBy: uuid('approved_by'),
    rejectedAt: timestamptz('rejected_at'),
    rejectedBy: uuid('rejected_by'),
    rejectionReason: text('rejection_reason'),
    // Set when posted: whether VAT is part of the cost, and what it cost the business.
    vatInCost: boolean('vat_in_cost'),
    costTotal: money('cost_total'),
    postedAt: timestamptz('posted_at'),
    postedBy: uuid('posted_by'),
    reversedAt: timestamptz('reversed_at'),
    reversedBy: uuid('reversed_by'),
    reversalDate: date('reversal_date', { mode: 'string' }),
    // The month the reversal counts in (its first day): the expense's own month, or the first open
    // month when the books were closed through the end of it (D-200). Null (a row reversed before it
    // was added, or written directly): the expense's own month.
    reversalPeriodMonth: date('reversal_period_month', { mode: 'string' }),
    // A draft made by "correct": the reversed expense it replaces.
    copiedFromId: uuid('copied_from_id'),
    // What it pays, in a category that has running costs (the owner's decision of 2026-10-01,
    // D-216): `running_cost`, the bill of the running cost `running_cost_id` (it takes the place of
    // that running cost's regular amount alone over the period it pays for), or `extra` (it counts
    // as itself, on top). Null: not said yet, or its category has no running cost for its month.
    // Said before it is finalized whenever its category has one (the API); kept by a correction.
    // While Sales is served (M3 Step 3, Q8) any expense may also say `channel_fees` ("App fees of
    // [channel]", `channel_id`: that channel's fees for its month when no statement covers it) or
    // `delivery` ("Delivery already on my sales and orders"); neither counts in the month's costs.
    pays: text('pays').$type<ExpensePays>(),
    runningCostId: uuid('running_cost_id'),
    channelId: uuid('channel_id'),
  },
  (t) => [
    tenantRef('expenses_category_fk', [t.businessId, t.categoryId], costCategories),
    tenantRef('expenses_supplier_fk', [t.businessId, t.supplierId], suppliers),
    tenantRef('expenses_location_fk', [t.businessId, t.locationId], locations),
    tenantRef('expenses_paid_by_member_fk', [t.businessId, t.paidByMemberId], businessMembers),
    tenantRef('expenses_running_cost_fk', [t.businessId, t.runningCostId], runningCosts),
    tenantRef('expenses_channel_fk', [t.businessId, t.channelId], salesChannels),
    foreignKey({
      name: 'expenses_copied_from_fk',
      columns: [t.businessId, t.copiedFromId],
      foreignColumns: [t.businessId, t.id],
    }),
    // Lists: newest business day first.
    index('expenses_business_date_idx').on(t.businessId, t.businessDate, t.id),
    index('expenses_category_idx').on(t.businessId, t.categoryId),
    index('expenses_supplier_idx').on(t.businessId, t.supplierId),
    index('expenses_paid_by_member_idx').on(t.businessId, t.paidByMemberId),
    // A member's own expenses ("My expenses", D-181): the ones they entered.
    index('expenses_created_by_idx').on(t.businessId, t.createdBy),
    // Expenses by the month they are for.
    index('expenses_period_month_idx').on(t.businessId, t.periodMonth),
    // The bills of a running cost (D-216).
    index('expenses_running_cost_idx').on(t.businessId, t.runningCostId),
    // The fees of a channel (Q8).
    index('expenses_channel_idx').on(t.businessId, t.channelId),
    check(
      'expenses_document_type_check',
      sql`document_type in (${quoted(PURCHASE_DOCUMENT_TYPES)})`,
    ),
    check('expenses_payment_method_check', sql`payment_method in (${quoted(PAYMENT_METHODS)})`),
    check(
      'expenses_paid_by_member_check',
      sql`(payment_method = 'paid_by_member') = (paid_by_member_id is not null)`,
    ),
    check(
      'expenses_supplier_credit_check',
      sql`payment_method <> 'supplier_credit' or supplier_id is not null`,
    ),
    check('expenses_status_check', sql`status in (${quoted(EXPENSE_STATUSES)})`),
    check('expenses_currency_check', sql`currency ~ '^[A-Z]{3}$'`),
    check('expenses_amount_check', sql`amount > 0`),
    check('expenses_vat_rate_check', sql`vat_rate between 0 and 100`),
    check(
      'expenses_totals_check',
      sql`net_total >= 0 and vat_total >= 0 and total = net_total + vat_total`,
    ),
    check(
      'expenses_reference_check',
      sql`btrim(reference) <> '' and char_length(reference) <= 100`,
    ),
    check(
      'expenses_description_check',
      sql`btrim(description) <> '' and char_length(description) <= 200`,
    ),
    check('expenses_notes_check', sql`char_length(notes) <= 1000`),
    check(
      'expenses_rejection_reason_check',
      sql`btrim(rejection_reason) <> '' and char_length(rejection_reason) <= 500`,
    ),
    check(
      'expenses_review_check',
      sql`(submitted_at is null) = (submitted_by is null)
        and (approved_at is null) = (approved_by is null)
        and (rejected_at is null) = (rejected_by is null)
        and (rejected_at is not null or rejection_reason is null)
        and (status <> 'submitted' or submitted_at is not null)
        and (status <> 'approved' or approved_at is not null)
        and (status <> 'rejected' or rejected_at is not null)`,
    ),
    check(
      'expenses_posted_check',
      sql`(status in ('posted', 'reversed')) = (posted_at is not null)
        and (posted_at is null) = (posted_by is null)
        and (posted_at is null) = (vat_in_cost is null)
        and (posted_at is null) = (cost_total is null)`,
    ),
    check(
      'expenses_reversed_check',
      sql`(status = 'reversed') = (reversed_at is not null)
        and (status = 'reversed') = (reversed_by is not null)
        and (status = 'reversed') = (reversal_date is not null)`,
    ),
    check('expenses_copied_from_check', sql`copied_from_id <> id`),
    // `running_cost` names its running cost and `channel_fees` its channel; the others name
    // neither (D-216, M3 Step 3).
    check(
      'expenses_pays_check',
      sql`(pays is null or pays in (${quoted(EXPENSE_PAYS)}))
        and (running_cost_id is null) = (pays is distinct from 'running_cost')
        and (channel_id is null) = (pays is distinct from 'channel_fees')`,
    ),
    check(
      'expenses_period_month_check',
      sql`period_month = date_trunc('month', period_month)::date
        and period_month >= (date_trunc('month', business_date) - interval '12 months')::date
        and period_month <= (date_trunc('month', business_date) + interval '1 month')::date`,
    ),
    check(
      'expenses_reversal_period_month_check',
      sql`reversal_period_month is null
        or (status = 'reversed'
          and reversal_period_month = date_trunc('month', reversal_period_month)::date
          and reversal_period_month >= period_month)`,
    ),
  ],
)

/**
 * A payment of what an expense left owed (bought on credit, or paid by a member from their own money),
 * as purchase_payments is for purchases (D-160, D-166): never edited or deleted; one recorded by
 * mistake is reversed and stops counting. An expense with payments that stand is not reversed.
 */
export const expensePayments = tenantTable(
  'expense_payments',
  {
    expenseId: uuid('expense_id').notNull(),
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
    tenantRef('expense_payments_expense_fk', [t.businessId, t.expenseId], expenses),
    index('expense_payments_expense_idx').on(t.businessId, t.expenseId),
    check('expense_payments_method_check', sql`method in (${quoted(SETTLEMENT_METHODS)})`),
    check('expense_payments_amount_check', sql`amount > 0`),
    check('expense_payments_currency_check', sql`currency ~ '^[A-Z]{3}$'`),
    check('expense_payments_note_check', sql`btrim(note) <> '' and char_length(note) <= 500`),
    check(
      'expense_payments_reversed_check',
      sql`(reversed_at is null) = (reversed_by is null)
        and (reversed_at is null) = (reversal_date is null)`,
    ),
  ],
)

export type CostCategory = typeof costCategories.$inferSelect
export type NewCostCategory = typeof costCategories.$inferInsert
export type Expense = typeof expenses.$inferSelect
export type NewExpense = typeof expenses.$inferInsert
export type ExpensePayment = typeof expensePayments.$inferSelect
export type NewExpensePayment = typeof expensePayments.$inferInsert
export type RunningCost = typeof runningCosts.$inferSelect
export type NewRunningCost = typeof runningCosts.$inferInsert
