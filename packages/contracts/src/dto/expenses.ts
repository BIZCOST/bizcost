import {
  EXPENSE_PAYS,
  EXPENSE_STATUSES,
  RUNNING_COST_FREQUENCIES,
  SALES_CHANNEL_KINDS,
} from '@bizcost/domain'
import { z } from 'zod'
import { withMeta } from '../envelope'
import {
  COST_CATEGORY_NAME_MAX_LENGTH,
  EXPENSE_DESCRIPTION_MAX_LENGTH,
  REJECTION_REASON_MAX_LENGTH,
  RUNNING_COST_NAME_MAX_LENGTH,
} from '../expenses'
import { zBusinessDate, zBusinessMonth, zDecimal, zUuid } from '../primitives'
import {
  DOCUMENT_PAGE_SIZE,
  DOCUMENT_PAGE_SIZE_MAX,
  DOCUMENT_REFERENCE_MAX_LENGTH,
} from '../purchasing'
import { sensitive } from '../sensitivity'
import { catalogListInput, nameInput } from './catalog'
import {
  documentPaymentsFields,
  memberNameDto,
  notesInput,
  paidBy,
  paidByMessage,
  paymentInputFields,
  paymentMethodDto,
  percentInput,
  positiveMoneyInput,
  purchaseDocumentTypeDto,
} from './purchases'
import { optionalLine } from './suppliers'

// Expenses and Running Costs (ROADMAP.md M2 Step 5; docs/DATA_MODEL.md §6; D-114, D-116, D-164–D-170).
// Decimals are strings (Arabic-Indic digits accepted on input), business days YYYY-MM-DD, timestamps
// ISO strings.
//
// Sensitive (redacted for members without data.*.view; D-026, D-165): what an expense paid is
// `supplier_price`, as a purchase's amounts (its amount, net, VAT, total, cost, its payments); a
// running cost's regular and monthly amounts are `cost` (Step 6 shares them over product costs).
// Members who may see one see the other (D-144). Outputs with such fields are withMeta() envelopes.

const isoTimestamp = z.iso.datetime({ offset: true })

// ---------------------------------------------------------------------------------------------------
// Categories, shared by expenses and running costs (D-116)
// ---------------------------------------------------------------------------------------------------

/** `costCategory.list`: the catalog's list input (search, active/archived/all, cursor, limit). */
export const costCategoryListInput = catalogListInput
export type CostCategoryListInput = z.input<typeof costCategoryListInput>

const costCategoryFields = { name: nameInput(COST_CATEGORY_NAME_MAX_LENGTH) }

/**
 * Its bills usually come the month after the month they are for: a new expense in it is for the month
 * before its bill's date unless said otherwise (the owner's request of 2026-09-30).
 */
const billedNextMonth = z.boolean()

/**
 * `costCategory.create` (also from an expense or running cost being entered): idempotent on `id`.
 * `billedNextMonth` defaults to false.
 */
export const createCostCategoryInput = z.object({
  id: zUuid,
  ...costCategoryFields,
  billedNextMonth: billedNextMonth.default(false),
})
export type CreateCostCategoryInput = z.input<typeof createCostCategoryInput>

/** `costCategory.update`: a new name, `version` as read; `billedNextMonth` left out: kept. */
export const updateCostCategoryInput = z.object({
  id: zUuid,
  version: z.int().positive(),
  ...costCategoryFields,
  billedNextMonth: billedNextMonth.optional(),
})
export type UpdateCostCategoryInput = z.input<typeof updateCostCategoryInput>

export const costCategoryDto = z.object({
  id: zUuid,
  name: z.string(),
  /** Its bills usually come the month after (a new expense's month defaults to the one before). */
  billedNextMonth: z.boolean(),
  /** When it was archived (hidden from pickers); null while active. */
  archivedAt: isoTimestamp.nullable(),
  version: z.int().positive(),
})
export type CostCategoryDto = z.infer<typeof costCategoryDto>

/** By name (as people read it); `nextCursor` null on the last page. */
export const costCategoryListDto = z.object({
  items: z.array(costCategoryDto),
  nextCursor: z.string().nullable(),
})
export type CostCategoryListDto = z.infer<typeof costCategoryListDto>

// ---------------------------------------------------------------------------------------------------
// Expenses (module expenses; expenses.documents.view / manage / approve / post / reverse)
// ---------------------------------------------------------------------------------------------------

export const expenseStatusDto = z.enum(EXPENSE_STATUSES)
export type ExpenseStatusDto = z.infer<typeof expenseStatusDto>

// What an expense pays (the owner's decision of 2026-10-01, D-216). In a category that has running
// costs a bill for its month can pay (`expense.payableRunningCosts`), an expense says which one it
// pays, its bill «فاتورة لـ…» / "Bill for …" (it takes the place of that running cost's regular amount
// alone over the period it pays for), or that it is an extra «مصروف إضافي» / "Extra expense" (it
// counts as itself, on top). It must be said before the expense is finalized
// (RUNNING_COST_CHOICE_REQUIRED); a draft or an expense sent for approval may wait. Only a member who
// may see running costs (running_costs.items.view, with Running Costs on) says it: for anyone else it
// is said by the one who approves or finalizes the expense (expense.approve and expense.post take it).
//
// While Sales is served (M3 Step 3, Q8), any expense may also say it pays "App fees of [channel]"
// (`channel_fees`: that channel's fees for its month when no statement covers it) or "Delivery already
// on my sales and orders" (`delivery`), from `expense.payableChannels`. Neither counts in the month's
// costs. Only a member who sees costs (the costs switch) says them, with Sales on.

export const expensePaysKindDto = z.enum(EXPENSE_PAYS)
export type ExpensePaysKindDto = z.infer<typeof expensePaysKindDto>

/**
 * What an expense pays, as said: `running_cost` names a running cost of its category that a bill for
 * its month can pay (NOT_FOUND unless a live running cost of the business; VALIDATION when it is of
 * another category or cannot be paid for that month); `extra` (VALIDATION when its category has no
 * running cost for its month: then there is nothing to say); `channel_fees` names a sales channel of
 * the business (NOT_FOUND otherwise; an archived one only when the expense already names it);
 * `delivery`.
 */
export const expensePaysInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('running_cost'), runningCostId: zUuid }),
  z.object({ kind: z.literal('extra') }),
  z.object({ kind: z.literal('channel_fees'), channelId: zUuid }),
  z.object({ kind: z.literal('delivery') }),
])
export type ExpensePaysInput = z.input<typeof expensePaysInput>

/**
 * What it pays, said or left out. Left out: an update keeps what the expense says while it still fits
 * its category and month (else nothing is said: it is asked again; a channel's fees and delivery fit
 * any category and month); a new expense says nothing. Null: nothing said. The bill of a running cost
 * and an extra only from a member who may see running costs, a channel's fees and delivery only from
 * one who sees costs with Sales on, null from either (FORBIDDEN otherwise).
 */
const paysField = expensePaysInput.nullable().optional()

/**
 * What an expense pays (null: nothing said: a draft or an expense under review not yet said, or a
 * category without a running cost for its month; it counts as itself).
 */
export const expensePaysDto = z
  .object({
    kind: expensePaysKindDto,
    /**
     * `running_cost`: the running cost it pays, by its name as it is now, to a member who may see
     * running costs (running_costs.items.view, with Running Costs on); null for anyone else ("Bill
     * for a running cost") and for an extra. Never an amount.
     */
    runningCost: z.object({ id: zUuid, name: z.string() }).nullable(),
    /** `channel_fees`: the channel whose app fees it pays, by its name as it is now; else null. */
    channel: z.object({ id: zUuid, name: z.string() }).nullable(),
  })
  .nullable()
export type ExpensePaysDto = z.infer<typeof expensePaysDto>

const expenseFields = {
  /** A live category of the business (NOT_FOUND otherwise); an archived one only if it already has it. */
  categoryId: zUuid,
  /** Optional (on credit needs one): a supplier of the business. */
  supplierId: zUuid.nullable().default(null),
  businessDate: zBusinessDate,
  /**
   * The month the bill is for, "For which month?" (the owner's request of 2026-09-30): from 12 months
   * before the bill's month to 1 month after it (VALIDATION otherwise). Left out: the month before the
   * bill's date for a category billed the month after (electricity, water, internet, phone), else the
   * bill's month.
   */
  periodMonth: zBusinessMonth.optional(),
  /** What it came with, independent of how it was paid (PRODUCT.md §4 rule 13). */
  documentType: purchaseDocumentTypeDto,
  /** The supplier's invoice or receipt number. */
  reference: optionalLine(DOCUMENT_REFERENCE_MAX_LENGTH),
  /** What it was for, in a few words. */
  description: optionalLine(EXPENSE_DESCRIPTION_MAX_LENGTH),
  /**
   * How it was paid (required, D-159): `supplier_credit` needs `supplierId`; `paid_by_member` needs
   * `paidByMemberId` (an active member).
   */
  paymentMethod: paymentMethodDto,
  paidByMemberId: zUuid.nullable().default(null),
  /** Whether `amount` is typed with its VAT (default false: before VAT). */
  pricesIncludeVat: z.boolean().default(false),
  /**
   * Where it was spent. Only with multi_location (CAPABILITY_DISABLED for another than the default
   * location without it); null: the default location.
   */
  locationId: zUuid.nullable().default(null),
  /** The document is marked "VAT can't be reclaimed" (D-114 rule 4). */
  vatNotReclaimable: z.boolean().default(false),
  /**
   * What the bill says: more than zero, at most the currency's decimals (VALIDATION otherwise),
   * before VAT or with its VAT (`pricesIncludeVat`).
   */
  amount: positiveMoneyInput,
  /** The VAT rate on the bill, in percent (5 for the UAE standard rate; 0 without VAT). */
  vatRate: percentInput.default('0'),
  notes: notesInput,
  /** What it pays in a category that has running costs (D-216; see expensePaysInput). */
  pays: paysField,
}

/** `expense.create` (a draft): idempotent on the client's `id`. */
export const createExpenseInput = z
  .object({ id: zUuid, ...expenseFields })
  .refine(paidBy, paidByMessage)
export type CreateExpenseInput = z.input<typeof createExpenseInput>

/** `expense.update` (a draft or a rejected expense): the whole expense, `version` as read. */
export const updateExpenseInput = z
  .object({ id: zUuid, version: z.int().positive(), ...expenseFields })
  .refine(paidBy, paidByMessage)
export type UpdateExpenseInput = z.input<typeof updateExpenseInput>

/** `expense.get`, `expense.reverse`. */
export const expenseIdInput = z.object({ id: zUuid })
export type ExpenseIdInput = z.input<typeof expenseIdInput>

/** `expense.discard`, `.submit`: the `version` as read. */
export const expenseVersionInput = z.object({ id: zUuid, version: z.int().positive() })
export type ExpenseVersionInput = z.input<typeof expenseVersionInput>

/**
 * `expense.approve`, `.post`: the `version` as read, and what the expense pays when the one who
 * approves or finalizes it says it (D-216: for a member who entered it without seeing running costs).
 * Left out: what it says stays. Finalizing needs it said whenever its category has a running cost a
 * bill for its month can pay (RUNNING_COST_CHOICE_REQUIRED).
 */
export const expenseReviewInput = expenseVersionInput.extend({ pays: paysField })
export type ExpenseReviewInput = z.input<typeof expenseReviewInput>

/**
 * `expense.payableRunningCosts` (expenses.documents.view and running_costs.items.view, both modules
 * on): the running costs an expense in this category for this month can pay (D-216).
 */
export const payableRunningCostsInput = z.object({
  categoryId: zUuid,
  /** The month the expense is for (`YYYY-MM`). */
  periodMonth: zBusinessMonth,
})
export type PayableRunningCostsInput = z.input<typeof payableRunningCostsInput>

/**
 * A running cost an expense can pay, by name, never with its amount: the choice «فاتورة لـ{name}» /
 * "Bill for {name}". `period`: what its bill pays for (its month, or for a quarterly or yearly one its
 * quarter or year, D-203), so the hint can say "for this month" or "for this quarter". `startsOn` /
 * `endsOn`: when it counts (D-176: `endsOn` is the first day it no longer counts), so two of the same
 * name (a rent changed that month) can be told apart (D-217).
 */
export const payableRunningCostDto = z.object({
  id: zUuid,
  name: z.string(),
  frequency: z.enum(RUNNING_COST_FREQUENCIES),
  startsOn: zBusinessDate,
  endsOn: zBusinessDate.nullable(),
  period: z.object({
    from: zBusinessMonth,
    to: zBusinessMonth,
    months: z.union([z.literal(1), z.literal(3), z.literal(12)]),
  }),
})
export type PayableRunningCostDto = z.infer<typeof payableRunningCostDto>

/**
 * By name. Empty: the category has no running cost for that month, and the expense says nothing about
 * what it pays (the choice does not show).
 */
export const payableRunningCostsDto = z.object({ items: z.array(payableRunningCostDto) })
export type PayableRunningCostsDto = z.infer<typeof payableRunningCostsDto>

/**
 * `expense.payableChannels` (Expenses and Sales on, expenses.documents.view and the costs switch; M3
 * Step 3, Q8): the business's active sales channels by name, for "App fees of {name}"
 * («عمولات تطبيق {name}»), with their kind (a delivery app or a marketplace first keeps a part of
 * each sale). Never a commission %. With Sales off or not served the choice does not show.
 */
export const payableChannelsDto = z.object({
  items: z.array(z.object({ id: zUuid, name: z.string(), kind: z.enum(SALES_CHANNEL_KINDS) })),
})
export type PayableChannelsDto = z.infer<typeof payableChannelsDto>

/** `expense.reject`: the `version` as read, and why (optional; the one who entered it reads it). */
export const rejectExpenseInput = z.object({
  id: zUuid,
  version: z.int().positive(),
  reason: optionalLine(REJECTION_REASON_MAX_LENGTH),
})
export type RejectExpenseInput = z.input<typeof rejectExpenseInput>

/** `expense.correct`: reverse a posted expense and open a copy of it as a new draft (`newId`). */
export const correctExpenseInput = z.object({ id: zUuid, newId: zUuid })
export type CorrectExpenseInput = z.input<typeof correctExpenseInput>

/** `expense.list`: newest business day first. */
export const expenseListInput = z
  .object({
    /** Default: every expense that was not discarded. `submitted`: waiting for approval. */
    status: z.enum(['all', ...EXPENSE_STATUSES]).default('all'),
    /**
     * Default: whoever entered it. `others`: only those another member entered (with approval off,
     * who may finalize hears that drafts of the team wait for them, D-184).
     */
    enteredBy: z.enum(['anyone', 'others']).default('anyone'),
    categoryId: zUuid.optional(),
    supplierId: zUuid.optional(),
    /** Only the expenses for this month (the month the bill is for, not its date). */
    periodMonth: zBusinessMonth.optional(),
    /** Business days from and to (both included). */
    from: zBusinessDate.optional(),
    to: zBusinessDate.optional(),
    /** Part of the reference, what it was for, the supplier's or the category's name. */
    search: z.string().trim().max(100).optional(),
    cursor: z.string().min(1).max(500).optional(),
    limit: z.int().min(1).max(DOCUMENT_PAGE_SIZE_MAX).default(DOCUMENT_PAGE_SIZE),
  })
  .prefault({})
export type ExpenseListInput = z.input<typeof expenseListInput>

const paid = () => sensitive(zDecimal, 'supplier_price')

export const expenseDto = z.object({
  id: zUuid,
  status: expenseStatusDto,
  categoryId: zUuid,
  /** The category's name as it is now. */
  categoryName: z.string(),
  supplierId: zUuid.nullable(),
  supplierName: z.string().nullable(),
  locationId: zUuid,
  businessDate: zBusinessDate,
  /** The month the bill is for (`YYYY-MM`). */
  periodMonth: zBusinessMonth,
  documentType: purchaseDocumentTypeDto,
  reference: z.string().nullable(),
  description: z.string().nullable(),
  paymentMethod: paymentMethodDto,
  /** `paid_by_member`: the member who paid, and their name in the business as it is now. */
  paidByMemberId: zUuid.nullable(),
  paidByMemberName: z.string().nullable(),
  pricesIncludeVat: z.boolean(),
  vatNotReclaimable: z.boolean(),
  /** ISO 4217 (the business's currency). */
  currency: z.string(),
  /** As typed (with its VAT when pricesIncludeVat). */
  amount: paid(),
  vatRate: zDecimal,
  /** Before VAT, the VAT and the total (what was paid). */
  netTotal: paid(),
  vatTotal: paid(),
  total: paid(),
  /** Posted: whether VAT is part of the cost (D-114 rule 4); null before. */
  vatInCost: z.boolean().nullable(),
  /** Posted: what it cost the business (net, and the VAT when it cannot be reclaimed). */
  costTotal: sensitive(zDecimal.nullable(), 'supplier_price'),
  notes: z.string().nullable(),
  attachmentCount: z.int().nonnegative(),
  /** Whether the business requires approval now (its setting, with a team; D-164). */
  approvalRequired: z.boolean(),
  /** Who entered it. */
  createdBy: memberNameDto,
  submittedAt: isoTimestamp.nullable(),
  submittedBy: memberNameDto.nullable(),
  approvedAt: isoTimestamp.nullable(),
  approvedBy: memberNameDto.nullable(),
  rejectedAt: isoTimestamp.nullable(),
  rejectedBy: memberNameDto.nullable(),
  rejectionReason: z.string().nullable(),
  postedAt: isoTimestamp.nullable(),
  reversedAt: isoTimestamp.nullable(),
  /** The reversal's business day (the expense's own, or the first open day). */
  reversalDate: zBusinessDate.nullable(),
  /** A draft made by "correct": the reversed expense it replaces. */
  copiedFromId: zUuid.nullable(),
  /** What it pays in a category that has running costs (D-216). */
  pays: expensePaysDto,
  createdAt: isoTimestamp,
  version: z.int().positive(),
})
export type ExpenseDto = z.infer<typeof expenseDto>

export const expenseResultDto = withMeta(expenseDto)
export type ExpenseResultDto = z.infer<typeof expenseResultDto>

export const expenseListItemDto = z.object({
  id: zUuid,
  status: expenseStatusDto,
  businessDate: zBusinessDate,
  /** The month the bill is for (`YYYY-MM`). */
  periodMonth: zBusinessMonth,
  categoryId: zUuid,
  categoryName: z.string(),
  supplierId: zUuid.nullable(),
  supplierName: z.string().nullable(),
  description: z.string().nullable(),
  reference: z.string().nullable(),
  documentType: purchaseDocumentTypeDto,
  paymentMethod: paymentMethodDto,
  currency: z.string(),
  total: paid(),
  /** Who entered it (an approver's list shows it). */
  createdBy: memberNameDto,
  /** What it pays in a category that has running costs (D-216). */
  pays: expensePaysDto,
  version: z.int().positive(),
})
export type ExpenseListItemDto = z.infer<typeof expenseListItemDto>

/** `expense.list`: newest business day first; `nextCursor` null on the last page. */
export const expenseListDto = withMeta(
  z.object({ items: z.array(expenseListItemDto), nextCursor: z.string().nullable() }),
)
export type ExpenseListDto = z.infer<typeof expenseListDto>

/** `expense.settings`: whether expenses need approval (D-164). */
export const expenseSettingsDto = z.object({
  /** The business's setting (kept when the team is turned off). */
  approval: z.boolean(),
  /** Whether it applies now: the setting, and the business has a team. */
  approvalRequired: z.boolean(),
  /** The business has a team (the setting is offered only then). */
  hasTeam: z.boolean(),
})
export type ExpenseSettingsDto = z.infer<typeof expenseSettingsDto>

/** `expense.updateSettings` (expenses.approval.manage, with a team). */
export const updateExpenseSettingsInput = z.object({ approval: z.boolean() })
export type UpdateExpenseSettingsInput = z.input<typeof updateExpenseSettingsInput>

// ---------------------------------------------------------------------------------------------------
// What an expense left owed, and paying it (as purchases, D-160, D-166)
// ---------------------------------------------------------------------------------------------------

/**
 * `expensePayment.record` (expenses.payments.record, and supplier prices visible): a payment of what
 * is owed on a final expense bought on credit or paid by a member; the rules of
 * recordPurchasePaymentInput. Idempotent on the client's `id`.
 */
export const recordExpensePaymentInput = z.object({
  id: zUuid,
  expenseId: zUuid,
  ...paymentInputFields,
})
export type RecordExpensePaymentInput = z.input<typeof recordExpensePaymentInput>

/** `expensePayment.reverse` (expenses.payments.record): as purchasePayment.reverse. Idempotent. */
export const reverseExpensePaymentInput = z.object({ id: zUuid })
export type ReverseExpensePaymentInput = z.input<typeof reverseExpensePaymentInput>

/** `expensePayment.list` (expenses.payments.view): the payments of one expense. */
export const expensePaymentsInput = z.object({ expenseId: zUuid })
export type ExpensePaymentsInput = z.input<typeof expensePaymentsInput>

/** An expense's payments and what is still owed on it (`returned` is always 0). */
export const expensePaymentsDto = withMeta(
  z.object({ expenseId: zUuid, status: expenseStatusDto, ...documentPaymentsFields }),
)
export type ExpensePaymentsDto = z.infer<typeof expensePaymentsDto>

// ---------------------------------------------------------------------------------------------------
// Running costs (module running_costs; running_costs.items.view / manage; D-116)
// ---------------------------------------------------------------------------------------------------

export const runningCostFrequencyDto = z.enum(RUNNING_COST_FREQUENCIES)
export type RunningCostFrequencyDto = z.infer<typeof runningCostFrequencyDto>

/** Whether it counts today: started and not ended, not started yet, or ended. */
export const runningCostStateDto = z.enum(['active', 'upcoming', 'ended'])
export type RunningCostStateDto = z.infer<typeof runningCostStateDto>

const runningCostFields = {
  name: nameInput(RUNNING_COST_NAME_MAX_LENGTH),
  /** A live category of the business (NOT_FOUND otherwise). */
  categoryId: zUuid,
  /**
   * The regular amount per period, in the business's currency: more than zero, at most the
   * currency's decimals (VALIDATION otherwise). What it costs the business (for a VAT-registered
   * business, without the VAT it reclaims).
   */
  amount: positiveMoneyInput,
  /** How often it is paid (default monthly). */
  frequency: runningCostFrequencyDto.default('monthly'),
  /** From when it counts (any day, past or future). */
  startsOn: zBusinessDate,
  /** Until when it counts (on or after `startsOn`); null: still paid. */
  endsOn: zBusinessDate.nullable().default(null),
  notes: notesInput,
}

const datesInOrder = (cost: { startsOn: string; endsOn: string | null }) =>
  cost.endsOn === null || cost.endsOn >= cost.startsOn
const datesMessage = { message: 'endsOn is before startsOn' }

/** `runningCost.create`: idempotent on the client's `id`. */
export const createRunningCostInput = z
  .object({ id: zUuid, ...runningCostFields })
  .refine(datesInOrder, datesMessage)
export type CreateRunningCostInput = z.input<typeof createRunningCostInput>

/** `runningCost.update`: the whole record, `version` as read. */
export const updateRunningCostInput = z
  .object({ id: zUuid, version: z.int().positive(), ...runningCostFields })
  .refine(datesInOrder, datesMessage)
export type UpdateRunningCostInput = z.input<typeof updateRunningCostInput>

/** `runningCost.get`. */
export const runningCostIdInput = z.object({ id: zUuid })
export type RunningCostIdInput = z.input<typeof runningCostIdInput>

/** `runningCost.remove` (one entered by mistake): the `version` as read. */
export const removeRunningCostInput = z.object({ id: zUuid, version: z.int().positive() })
export type RemoveRunningCostInput = z.input<typeof removeRunningCostInput>

/** `runningCost.list`: by name. */
export const runningCostListInput = z
  .object({
    /** Which, as of today (the business's time zone): default all. */
    state: z.enum(['all', 'active', 'upcoming', 'ended']).default('all'),
    categoryId: zUuid.optional(),
    /** Part of its name or of its category's name. */
    search: z.string().trim().max(100).optional(),
    cursor: z.string().min(1).max(500).optional(),
    limit: z.int().min(1).max(DOCUMENT_PAGE_SIZE_MAX).default(DOCUMENT_PAGE_SIZE),
  })
  .prefault({})
export type RunningCostListInput = z.input<typeof runningCostListInput>

const regular = () => sensitive(zDecimal, 'cost')

export const runningCostDto = z.object({
  id: zUuid,
  name: z.string(),
  categoryId: zUuid,
  /** The category's name as it is now. */
  categoryName: z.string(),
  amount: regular(),
  frequency: runningCostFrequencyDto,
  /** The amount per month (12 decimals, never rounded; monthlyAmount in @bizcost/domain). */
  monthlyAmount: regular(),
  startsOn: zBusinessDate,
  endsOn: zBusinessDate.nullable(),
  /** As of today (the business's time zone). */
  state: runningCostStateDto,
  notes: z.string().nullable(),
  createdAt: isoTimestamp,
  version: z.int().positive(),
})
export type RunningCostDto = z.infer<typeof runningCostDto>

export const runningCostResultDto = withMeta(runningCostDto)
export type RunningCostResultDto = z.infer<typeof runningCostResultDto>

export const runningCostListDto = withMeta(
  z.object({
    items: z.array(runningCostDto),
    nextCursor: z.string().nullable(),
    /** The business's currency. */
    currency: z.string(),
    /** Today in the business's time zone (what `state` is as of). */
    today: zBusinessDate,
    /** Σ monthly amounts of the running costs active today (all of them, whatever the filters). */
    monthlyTotal: regular(),
  }),
)
export type RunningCostListDto = z.infer<typeof runningCostListDto>
