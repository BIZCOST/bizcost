import {
  PAYMENT_NOTE_MAX_LENGTH,
  type PayableKindDto,
  type RecordPurchasePaymentInput,
} from '@bizcost/contracts'
import {
  compareDecimal,
  roundDocument,
  type CurrencyCode,
  type SettlementMethod,
} from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { readAmount, type FieldError } from '../catalog/numbers'
import { closedFor } from './books'

// Recording a payment of what is owed on a purchase (the owner's request of 2026-09-29) or an expense
// (M2 Step 5, D-166): the day it was paid (the business's day; not after today, not before the
// document, not on a closed day), how (cash, card, bank transfer or cheque), how much (more than zero,
// at most what is still owed, in the currency's minor unit: part of it is fine) and an optional note.
// checkPayment says every problem as purchasePayment.record and expensePayment.record would, and gives
// their fields.

export interface PaymentDraft {
  readonly businessDate: string
  /** '' until one is picked. */
  readonly method: SettlementMethod | ''
  readonly amount: string
  readonly note: string
}

export interface PaymentErrors {
  businessDate?: FieldError
  method?: FieldError
  amount?: FieldError
  note?: FieldError
}

export type PaymentFields = Omit<RecordPurchasePaymentInput, 'id' | 'purchaseId'>

/** "This day is before the purchase" (or the expense). */
const BEFORE_DOCUMENT = {
  purchase: 'purchasing.payment.beforePurchase',
  expense: 'purchasing.payment.beforeExpense',
} as const satisfies Record<PayableKindDto, I18nKey>

/** Problems that only say something is missing: shown once the person tries to save. */
export const PAYMENT_MISSING: ReadonlySet<I18nKey> = new Set<I18nKey>([
  'catalog.numbers.required',
  'purchasing.payment.methodRequired',
])

/**
 * A new payment: paid today, all that is still owed, written with the currency's decimals (the person
 * may change it to part of it).
 */
export function paymentDraft(
  outstanding: string,
  today: string,
  currency: CurrencyCode,
): PaymentDraft {
  return { businessDate: today, method: '', amount: roundDocument(outstanding, currency), note: '' }
}

const BUSINESS_DAY = /^\d{4}-\d{2}-\d{2}$/

export function checkPayment(
  draft: PaymentDraft,
  context: {
    readonly currency: CurrencyCode
    readonly outstanding: string
    /** What is paid: a purchase (the default) or an expense. */
    readonly kind?: PayableKindDto
    /** The document's own day: a payment is never before it. */
    readonly documentDate: string
    readonly today: string
    readonly closedThrough: string | null
  },
): { errors: PaymentErrors; fields: PaymentFields | null } {
  const errors: PaymentErrors = {}
  if (!BUSINESS_DAY.test(draft.businessDate)) {
    errors.businessDate = { key: 'purchasing.editor.errors.date' }
  } else if (draft.businessDate > context.today) {
    errors.businessDate = { key: 'errors.future_date' }
  } else if (draft.businessDate < context.documentDate) {
    errors.businessDate = { key: BEFORE_DOCUMENT[context.kind ?? 'purchase'] }
  } else if (closedFor(draft.businessDate, context.today, context.closedThrough)) {
    errors.businessDate = { key: 'purchasing.payment.booksClosed' }
  }
  if (draft.method === '') errors.method = { key: 'purchasing.payment.methodRequired' }
  const amount = readAmount(draft.amount, { positive: true, currency: context.currency })
  if (!amount.ok) errors.amount = amount.error
  else if (compareDecimal(amount.value, context.outstanding) > 0) {
    errors.amount = { key: 'errors.exceeds_outstanding' }
  }
  const note = draft.note.trim()
  if (note.length > PAYMENT_NOTE_MAX_LENGTH) {
    errors.note = { key: 'purchasing.tooLong', values: { count: PAYMENT_NOTE_MAX_LENGTH } }
  }
  const valid = Object.keys(errors).length === 0 && amount.ok && draft.method !== ''
  return {
    errors,
    fields: valid
      ? {
          businessDate: draft.businessDate,
          method: draft.method as SettlementMethod,
          amount: (amount as { value: string }).value,
          note: note || null,
        }
      : null,
  }
}
