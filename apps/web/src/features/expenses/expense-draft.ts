import {
  DOCUMENT_NOTES_MAX_LENGTH,
  DOCUMENT_REFERENCE_MAX_LENGTH,
  EXPENSE_DESCRIPTION_MAX_LENGTH,
  type CreateExpenseInput,
  type ExpenseDto,
} from '@bizcost/contracts'
import {
  computeExpense,
  defaultPricesIncludeVat,
  type CurrencyCode,
  type ExpenseAmounts,
  type Money,
  type PaymentMethod,
  type Percent,
  type PurchaseDocumentType,
} from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { readAmount, type FieldError } from '../catalog/numbers'
import { defaultVatRate, NO_VAT } from '../purchasing/purchase-draft'

// The expense form (M2 Step 5; D-114, D-157, D-159, D-168): one amount in one category, typed before
// VAT or with it (a VAT-registered business only; any other types what it paid, with no VAT), the
// document it came with (apart from how it was paid), how it was paid (required: on credit needs the
// supplier, paid personally names who), and optional details. Checked as the API checks it; the
// amounts shown as it is typed are the domain's (computeExpense: the purchase line's maths, as the
// API stores them). What it costs the business (VAT in or out) is fixed when it is finalized.

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
}

export interface ExpenseErrors {
  amount?: FieldError
  category?: FieldError
  businessDate?: FieldError
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
}

export interface CheckedExpense {
  readonly errors: ExpenseErrors
  /** The fields to save; null while something must be fixed. */
  readonly fields: ExpenseFields | null
  /** Before VAT, the VAT and the total of what is typed (zero while the amount does not read). */
  readonly amounts: Pick<ExpenseAmounts, 'net' | 'vat' | 'total'>
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
 * and with it otherwise, D-157; no category and no payment method until picked), or a saved draft as
 * it is stored.
 */
export function expenseDraft(
  expense: ExpenseDto | undefined,
  defaults: { today: string; vatRegistered: boolean },
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
      documentType,
      paymentMethod: '',
      paidByMemberId: '',
      supplierId: '',
      description: '',
      reference: '',
      locationId: null,
      vatNotReclaimable: false,
      notes: '',
    }
  }
  return {
    amount: expense.amount ?? '',
    vatRate: expense.vatRate,
    pricesIncludeVat: expense.pricesIncludeVat,
    categoryId: expense.categoryId,
    businessDate: expense.businessDate,
    documentType: expense.documentType,
    paymentMethod: expense.paymentMethod,
    paidByMemberId: expense.paidByMemberId ?? '',
    supplierId: expense.supplierId ?? '',
    description: expense.description ?? '',
    reference: expense.reference ?? '',
    locationId: expense.locationId,
    vatNotReclaimable: expense.vatNotReclaimable,
    notes: expense.notes ?? '',
  }
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
  return {
    errors,
    amounts: { net: amounts.net, vat: amounts.vat, total: amounts.total },
    fields: valid
      ? {
          categoryId: draft.categoryId,
          supplierId: draft.supplierId || null,
          businessDate: draft.businessDate,
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
        }
      : null,
  }
}
