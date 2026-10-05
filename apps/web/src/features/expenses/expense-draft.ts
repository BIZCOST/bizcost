import {
  DOCUMENT_NOTES_MAX_LENGTH,
  DOCUMENT_REFERENCE_MAX_LENGTH,
  EXPENSE_DESCRIPTION_MAX_LENGTH,
  type CreateExpenseInput,
  type ExpenseDto,
  type ExpensePaysDto,
  type ExpensePaysInput,
} from '@bizcost/contracts'
import {
  addMonths,
  computeExpense,
  defaultPeriodMonth,
  defaultPricesIncludeVat,
  PERIOD_MONTHS_AFTER,
  PERIOD_MONTHS_BEFORE,
  periodMonthAllowed,
  periodMonthClosed,
  type CurrencyCode,
  type ExpenseAmounts,
  type Money,
  type PaymentMethod,
  type Percent,
  type PurchaseDocumentType,
} from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { readAmount, type FieldError } from '../catalog/numbers'
import { NO_VAT } from '../documents/lines'
import { defaultVatRate } from '../purchasing/purchase-draft'

// The expense form (M2 Step 5; D-114, D-157, D-159, D-168): one amount in one category, typed before
// VAT or with it (a VAT-registered business only; any other types what it paid, with no VAT), the
// document it came with (apart from how it was paid), how it was paid (required: on credit needs the
// supplier, paid personally names who), and optional details. Checked as the API checks it; the
// amounts shown as it is typed are the domain's (computeExpense: the purchase line's maths, as the
// API stores them). What it costs the business (VAT in or out) is fixed when it is finalized. In a
// category that has a running cost a bill for its month can pay, it says what it pays (D-216): the
// bill of one of them, or an extra; said only by a member who may see running costs, and needed to
// finalize it.

/** What an expense pays when it is an extra (`ExpenseDraft.pays`; a running cost's id otherwise). */
export const EXTRA = 'extra'

export interface ExpenseDraft {
  /** As typed: before VAT, or with its VAT (`pricesIncludeVat`). */
  readonly amount: string
  /** Percent as a decimal string ('5', '0'). */
  readonly vatRate: string
  /** Whether the amount is typed with its VAT (a VAT-registered business only). */
  readonly pricesIncludeVat: boolean
  /** '' until chosen. */
  readonly categoryId: string
  readonly businessDate: string
  /**
   * "For which month?" (`YYYY-MM`, the owner's request of 2026-09-30, D-194): the month the bill is
   * for. Follows the bill's date and category (`withPeriodDefault`) until the person picks one.
   */
  readonly periodMonth: string
  readonly documentType: PurchaseDocumentType
  /** '' until one is picked (required before a save). */
  readonly paymentMethod: PaymentMethod | ''
  /** paid_by_member: the member who paid from their own money ('' until picked). */
  readonly paidByMemberId: string
  /** '' for none. */
  readonly supplierId: string
  /** What it was for, in a few words. */
  readonly description: string
  readonly reference: string
  /** null: the default branch. */
  readonly locationId: string | null
  readonly vatNotReclaimable: boolean
  readonly notes: string
  /**
   * What it pays (D-216): the id of the running cost whose bill it is, EXTRA, or '' (not said). Asked
   * only when its category has a running cost a bill for its month can pay.
   */
  readonly pays: string
}

export interface ExpenseErrors {
  amount?: FieldError
  category?: FieldError
  businessDate?: FieldError
  periodMonth?: FieldError
  paymentMethod?: FieldError
  description?: FieldError
  reference?: FieldError
  notes?: FieldError
}

/** expense.create's fields (without the id); expense.update adds the id and the version. */
export type ExpenseFields = Omit<CreateExpenseInput, 'id'>

export interface ExpenseFormContext {
  readonly currency: CurrencyCode
  readonly vatRegistered: boolean
  /** Today in the business's time zone (a later day cannot be finalized). */
  readonly today: string
  /**
   * The categories it may name, by id (active ones, and the one it already has): a category archived
   * or gone since is picked again before a save. Undefined until they are read.
   */
  readonly categories?: ReadonlySet<string>
  /** The members who may be said to have paid (expense.payers), once read. */
  readonly payers?: ReadonlySet<string>
  /**
   * The running costs a bill in its category for its month can pay (expense.payableRunningCosts), by
   * id, once read, for a member who may see running costs. Undefined otherwise: what it pays is then
   * not sent (the API keeps what the expense says while it still fits).
   */
  readonly payable?: readonly { readonly id: string }[]
  /**
   * The channels whose app fees it may pay (expense.payableChannels), while Sales is served, for a
   * member who sees costs (M3 Step 3). Undefined otherwise: a channel's fees or delivery is kept.
   */
  readonly channels?: readonly { readonly id: string }[]
}

export interface CheckedExpense {
  readonly errors: ExpenseErrors
  /** The fields to save; null while something must be fixed. */
  readonly fields: ExpenseFields | null
  /** Before VAT, the VAT and the total of what is typed (zero while the amount does not read). */
  readonly amounts: Pick<ExpenseAmounts, 'net' | 'vat' | 'total'>
  /**
   * Its category has a running cost for its month and nothing is said about what it pays: it can be
   * saved or sent for approval, not finalized (RUNNING_COST_CHOICE_REQUIRED).
   */
  readonly paysMissing: boolean
}

/** Problems that only say something is missing: shown once the person tries to save. */
export const EXPENSE_MISSING: ReadonlySet<I18nKey> = new Set<I18nKey>([
  'catalog.numbers.required',
  'expenses.editor.errors.category',
  'purchasing.editor.errors.paymentMethod',
  'purchasing.editor.errors.paymentMethodMember',
])

/**
 * The form's first state: a new expense dated today (the document type a VAT-registered business
 * usually gets is a tax invoice, with the standard VAT; the amount typed before VAT on a tax invoice
 * and with it otherwise, D-157; no category and no payment method until picked; this month, or the
 * first open one once the books are closed through it, D-200), or a saved draft as it is stored.
 */
export function expenseDraft(
  expense: ExpenseDto | undefined,
  defaults: { today: string; vatRegistered: boolean; closedThrough?: string | null },
): ExpenseDraft {
  if (!expense) {
    const documentType: PurchaseDocumentType = defaults.vatRegistered
      ? 'tax_invoice'
      : 'non_tax_invoice'
    return {
      amount: '',
      vatRate: defaultVatRate(defaults.vatRegistered, documentType),
      pricesIncludeVat: defaultPricesIncludeVat(documentType),
      categoryId: '',
      businessDate: defaults.today,
      // No category yet: the bill's own month until one is picked.
      periodMonth: defaultPeriodMonth(defaults.today, false, defaults.closedThrough ?? null),
      documentType,
      paymentMethod: '',
      paidByMemberId: '',
      supplierId: '',
      description: '',
      reference: '',
      locationId: null,
      vatNotReclaimable: false,
      notes: '',
      pays: '',
    }
  }
  return {
    amount: expense.amount ?? '',
    vatRate: expense.vatRate,
    pricesIncludeVat: expense.pricesIncludeVat,
    categoryId: expense.categoryId,
    businessDate: expense.businessDate,
    periodMonth: expense.periodMonth,
    documentType: expense.documentType,
    paymentMethod: expense.paymentMethod,
    paidByMemberId: expense.paidByMemberId ?? '',
    supplierId: expense.supplierId ?? '',
    description: expense.description ?? '',
    reference: expense.reference ?? '',
    locationId: expense.locationId,
    vatNotReclaimable: expense.vatNotReclaimable,
    notes: expense.notes ?? '',
    pays: paysChoiceOf(expense.pays),
  }
}

/**
 * While Sales is served (M3 Step 3, Q8), an expense may also pay a channel's app fees
 * (`fees:<channel id>`) or delivery already on the sales (DELIVERY), said by a member who sees costs;
 * or nothing of these (ORDINARY: it counts as itself, said only in a category without running costs).
 * For a member who may not say them, a channel's fees or delivery already said is kept as it is: left
 * out, the API keeps it, since it fits any category.
 */
export const FEES = 'fees:'
export const DELIVERY = 'delivery'
export const ORDINARY = 'ordinary'

/** A channel's fees or delivery already on the sales (they stay when the category changes, D-239). */
export function isSalesChoice(choice: string): boolean {
  return choice === DELIVERY || choice.startsWith(FEES)
}

/**
 * What a saved expense says it pays, as the form's choice: the running cost's id (named only to a
 * member who may see running costs), EXTRA, a channel's fees (`fees:<id>`) or DELIVERY, or ''
 * (nothing said, or a running cost not named).
 */
export function paysChoiceOf(pays: ExpensePaysDto | undefined): string {
  if (!pays) return ''
  if (pays.kind === 'extra') return EXTRA
  if (pays.kind === 'channel_fees') return `${FEES}${pays.channel?.id ?? ''}`
  if (pays.kind === 'delivery') return DELIVERY
  return pays.runningCost?.id ?? ''
}

/**
 * What to send for the choice, given the running costs its category can pay that month and (while
 * Sales is served, for a member who sees costs) the channels: the bill of one of them, an extra while
 * there is one, a channel's fees, delivery already on the sales, null otherwise (nothing said).
 * Undefined while they are not known, or for a member who may not say it: left out, the API keeps
 * what the expense says while it still fits (a channel's fees or delivery always does).
 */
export function paysInputOf(
  choice: string,
  payable: readonly { readonly id: string }[] | undefined,
  channels?: readonly { readonly id: string }[],
): ExpensePaysInput | null | undefined {
  if (isSalesChoice(choice)) {
    if (channels === undefined) return undefined
    if (choice === DELIVERY) return { kind: 'delivery' }
    const channelId = choice.slice(FEES.length)
    // An archived channel the expense already names: kept as it is.
    return channels.some((channel) => channel.id === channelId)
      ? { kind: 'channel_fees', channelId }
      : undefined
  }
  // Nothing of these, said by a member who may (a category without running costs).
  if (choice === ORDINARY) return channels !== undefined || payable !== undefined ? null : undefined
  if (payable === undefined) return undefined
  if (payable.length === 0) return null
  if (choice === EXTRA) return { kind: 'extra' }
  return payable.some((cost) => cost.id === choice)
    ? { kind: 'running_cost', runningCostId: choice }
    : null
}

/**
 * The draft with another document type: the VAT rate follows the new type's while it is still the
 * old type's, and so does "typed with VAT" until the person chose it (`vatModeChosen`).
 */
export function withDocumentType(
  draft: ExpenseDraft,
  documentType: PurchaseDocumentType,
  { vatRegistered, vatModeChosen }: { vatRegistered: boolean; vatModeChosen: boolean },
): ExpenseDraft {
  const before = defaultVatRate(vatRegistered, draft.documentType)
  return {
    ...draft,
    documentType,
    vatRate: draft.vatRate === before ? defaultVatRate(vatRegistered, documentType) : draft.vatRate,
    pricesIncludeVat: vatModeChosen
      ? draft.pricesIncludeVat
      : defaultPricesIncludeVat(documentType),
  }
}

/**
 * The draft's month when the person has not picked one (`chosen` false): the month before the bill's
 * date for a category billed the month after (electricity, water, internet, phone), else the bill's
 * month, never one the books are closed through (then the first open one), as the API would default
 * it (D-194, D-200). A month the person picked is kept.
 */
export function withPeriodDefault(
  draft: ExpenseDraft,
  {
    chosen,
    billedNextMonth,
    closedThrough = null,
  }: { chosen: boolean; billedNextMonth: boolean; closedThrough?: string | null },
): ExpenseDraft {
  if (chosen || !BUSINESS_DAY.test(draft.businessDate)) return draft
  const periodMonth = defaultPeriodMonth(draft.businessDate, billedNextMonth, closedThrough)
  return periodMonth === draft.periodMonth ? draft : { ...draft, periodMonth }
}

const BUSINESS_DAY = /^\d{4}-\d{2}-\d{2}$/
const ZERO = { net: '0', vat: '0', total: '0' } as Pick<ExpenseAmounts, 'net' | 'vat' | 'total'>

/** Every problem of the form, the amounts of what is typed, and the fields to send when there is none. */
export function checkExpense(draft: ExpenseDraft, context: ExpenseFormContext): CheckedExpense {
  const errors: ExpenseErrors = {}
  // Only a VAT-registered business chooses; any other types what it paid, with no VAT.
  const vatRate = context.vatRegistered ? draft.vatRate : NO_VAT
  const pricesIncludeVat = context.vatRegistered && draft.pricesIncludeVat

  const amount = readAmount(draft.amount, { positive: true, currency: context.currency })
  if (!amount.ok) errors.amount = amount.error
  if (!draft.categoryId) errors.category = { key: 'expenses.editor.errors.category' }
  else if (context.categories && !context.categories.has(draft.categoryId)) {
    errors.category = { key: 'expenses.editor.errors.categoryGone' }
  }
  if (!BUSINESS_DAY.test(draft.businessDate)) {
    errors.businessDate = { key: 'purchasing.editor.errors.date' }
  } else if (draft.businessDate > context.today) {
    errors.businessDate = { key: 'errors.future_date' }
  } else if (!periodMonthAllowed(draft.periodMonth, draft.businessDate)) {
    // From 12 months before the bill's month to 1 after it (the API refuses the rest).
    errors.periodMonth = { key: 'expenses.editor.errors.periodMonth' }
  }
  // How it was paid is required (the API refuses a save without it); on credit needs the supplier,
  // paid by a member needs the member (D-159, D-166).
  if (draft.paymentMethod === '') {
    errors.paymentMethod = { key: 'purchasing.editor.errors.paymentMethod' }
  } else if (draft.paymentMethod === 'supplier_credit' && !draft.supplierId) {
    errors.paymentMethod = { key: 'purchasing.editor.errors.paymentMethodSupplier' }
  } else if (draft.paymentMethod === 'paid_by_member' && !draft.paidByMemberId) {
    errors.paymentMethod = { key: 'purchasing.editor.errors.paymentMethodMember' }
  } else if (
    draft.paymentMethod === 'paid_by_member' &&
    context.payers &&
    !context.payers.has(draft.paidByMemberId)
  ) {
    errors.paymentMethod = { key: 'purchasing.editor.errors.payerLeft' }
  }
  const description = draft.description.trim()
  if (description.length > EXPENSE_DESCRIPTION_MAX_LENGTH) {
    errors.description = {
      key: 'purchasing.tooLong',
      values: { count: EXPENSE_DESCRIPTION_MAX_LENGTH },
    }
  }
  const reference = draft.reference.trim()
  if (reference.length > DOCUMENT_REFERENCE_MAX_LENGTH) {
    errors.reference = {
      key: 'purchasing.tooLong',
      values: { count: DOCUMENT_REFERENCE_MAX_LENGTH },
    }
  }
  const notes = draft.notes.trim()
  if (notes.length > DOCUMENT_NOTES_MAX_LENGTH) {
    errors.notes = { key: 'purchasing.tooLong', values: { count: DOCUMENT_NOTES_MAX_LENGTH } }
  }

  // A draft's document amounts do not depend on the VAT rule (what it costs is fixed at posting).
  const amounts = amount.ok
    ? computeExpense(
        {
          amount: amount.value as Money,
          vatRate: vatRate as Percent,
          pricesIncludeVat,
          vatInCost: false,
        },
        context.currency,
      )
    : ZERO

  const paymentMethod = draft.paymentMethod
  const valid = Object.keys(errors).length === 0 && amount.ok && paymentMethod !== ''
  const pays = paysInputOf(draft.pays, context.payable, context.channels)
  return {
    errors,
    amounts: { net: amounts.net, vat: amounts.vat, total: amounts.total },
    paysMissing: pays === null && (context.payable?.length ?? 0) > 0,
    fields: valid
      ? {
          categoryId: draft.categoryId,
          supplierId: draft.supplierId || null,
          businessDate: draft.businessDate,
          periodMonth: draft.periodMonth,
          documentType: draft.documentType,
          reference: reference || null,
          description: description || null,
          paymentMethod,
          paidByMemberId: paymentMethod === 'paid_by_member' ? draft.paidByMemberId : null,
          pricesIncludeVat,
          locationId: draft.locationId,
          vatNotReclaimable:
            context.vatRegistered && draft.documentType === 'tax_invoice'
              ? draft.vatNotReclaimable
              : false,
          amount: amount.value,
          vatRate,
          notes: notes || null,
          ...(pays === undefined ? {} : { pays }),
        }
      : null,
  }
}

/**
 * The months "For which month?" offers (D-194, D-200), newest first: from 1 month after the bill's
 * month to 12 before it, without those the books are closed through (unless every one of them is: a
 * bill dated in the closed period, whose date says so), and the draft's own month when it is not
 * among them (a saved one; the field then says why it cannot be finalized).
 */
export function periodMonthOptions(
  billMonth: string,
  current: string,
  closedThrough: string | null,
): string[] {
  const all = Array.from({ length: PERIOD_MONTHS_BEFORE + PERIOD_MONTHS_AFTER + 1 }, (_, index) =>
    addMonths(billMonth, PERIOD_MONTHS_AFTER - index),
  )
  const open = all.filter((month) => !periodMonthClosed(month, closedThrough))
  const months = open.length > 0 ? open : all
  return months.includes(current) ? months : [...months, current]
}
