import {
  DOCUMENT_NOTES_MAX_LENGTH,
  DOCUMENT_REFERENCE_MAX_LENGTH,
  type CreatePurchaseReturnInput,
  type PurchaseDto,
  type PurchaseLineDto,
  type PurchaseReturnDto,
} from '@bizcost/contracts'
import {
  compareDecimal,
  currencyMinorUnit,
  isCurrencyCode,
  newId,
  proportionOf,
  subtractDecimals,
  sumDecimals,
  type PurchaseReturnKind,
} from '@bizcost/domain'
import { readAmount, readQuantity, type FieldError } from '../catalog/numbers'

// The supplier return and credit note form (M2 Step 3; D-120, D-136): for a final purchase, a
// quantity per line sent back (at most what is left of the line), or an amount per line before VAT
// taken off by the supplier, or one amount for the whole purchase that the API shares over its lines.
// The API checks the same limits again when it saves and when it posts (EXCEEDS_PURCHASE).

export interface ReturnDraft {
  readonly businessDate: string
  readonly reference: string
  readonly notes: string
  /** Credit notes: one amount for the whole purchase instead of an amount per line. */
  readonly split: boolean
  readonly splitAmount: string
  /** What was typed per purchase line (a quantity for a return, an amount for a credit note). */
  readonly values: Readonly<Record<string, string>>
}

export interface ReturnErrors {
  businessDate?: FieldError
  reference?: FieldError
  notes?: FieldError
  splitAmount?: FieldError
  /** Nothing to return or credit yet. */
  document?: FieldError
  lines: Record<string, FieldError>
}

export type ReturnFields = Omit<CreatePurchaseReturnInput, 'id' | 'purchaseId' | 'kind'>

/** The purchase's material lines, the only ones a return or credit note can name. */
export function returnableLines(purchase: PurchaseDto): PurchaseLineDto[] {
  return purchase.lines.filter((line) => line.kind === 'material')
}

/** How much of a line can still be sent back: bought less what final returns took back. */
export function quantityLeft(line: PurchaseLineDto): string {
  return subtractDecimals(line.qty, line.returnedQty)
}

export function returnDraft(
  kind: PurchaseReturnKind,
  document: PurchaseReturnDto | undefined,
  today: string,
): ReturnDraft {
  if (!document) {
    return {
      businessDate: today,
      reference: '',
      notes: '',
      split: false,
      splitAmount: '',
      values: {},
    }
  }
  const values: Record<string, string> = {}
  for (const line of document.lines) {
    const value = kind === 'return' ? line.qty : line.amount
    if (value) values[line.purchaseLineId] = value
  }
  return {
    businessDate: document.businessDate,
    reference: document.reference ?? '',
    notes: document.notes ?? '',
    // A credit note saved as one amount comes back with its shares per line.
    split: false,
    splitAmount: '',
    values,
  }
}

const BUSINESS_DAY = /^\d{4}-\d{2}-\d{2}$/

/** Every problem of the form, and the fields to send when there is none. */
export function checkReturn(
  kind: PurchaseReturnKind,
  draft: ReturnDraft,
  purchase: PurchaseDto,
  context: { today: string; stored?: PurchaseReturnDto },
): { errors: ReturnErrors; fields: ReturnFields | null } {
  const errors: ReturnErrors = { lines: {} }
  if (!BUSINESS_DAY.test(draft.businessDate)) {
    errors.businessDate = { key: 'purchasing.editor.errors.date' }
  } else if (draft.businessDate > context.today) {
    errors.businessDate = { key: 'errors.future_date' }
  } else if (draft.businessDate < purchase.businessDate) {
    errors.businessDate = { key: 'purchasing.returns.beforePurchase' }
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

  const storedIds = new Map(
    (context.stored?.lines ?? []).map((line) => [line.purchaseLineId, line.id] as const),
  )
  const lines: ReturnFields['lines'] = []
  let splitAmount: string | null = null
  // A credit is a document amount: at most the currency's decimals (the API refuses more, D-142).
  const currency = isCurrencyCode(purchase.currency) ? purchase.currency : undefined
  if (kind === 'credit_note' && draft.split) {
    const amount = readAmount(draft.splitAmount, { positive: true, currency })
    if (!amount.ok) errors.splitAmount = amount.error
    else splitAmount = amount.value
  } else {
    for (const line of returnableLines(purchase)) {
      const typed = (draft.values[line.id] ?? '').trim()
      if (typed === '') continue
      const id = storedIds.get(line.id) ?? newId()
      if (kind === 'return') {
        const qty = readQuantity(typed)
        if (!qty.ok) errors.lines[line.id] = qty.error
        else if (compareDecimal(qty.value, quantityLeft(line)) > 0) {
          errors.lines[line.id] = { key: 'errors.exceeds_purchase' }
        } else lines.push({ id, purchaseLineId: line.id, qty: qty.value })
      } else {
        const amount = readAmount(typed, { positive: true, currency })
        if (!amount.ok) errors.lines[line.id] = amount.error
        else lines.push({ id, purchaseLineId: line.id, amount: amount.value })
      }
    }
    if (lines.length === 0 && Object.keys(errors.lines).length === 0) {
      errors.document = {
        key: kind === 'return' ? 'purchasing.returns.pickReturn' : 'purchasing.returns.pickCredit',
      }
    }
  }
  const valid =
    !errors.businessDate &&
    !errors.reference &&
    !errors.notes &&
    !errors.splitAmount &&
    !errors.document &&
    Object.keys(errors.lines).length === 0
  if (!valid) return { errors, fields: null }
  return {
    errors,
    fields: {
      businessDate: draft.businessDate,
      reference: reference || null,
      notes: notes || null,
      lines,
      splitAmount,
    },
  }
}

/**
 * What a return's lines are worth before VAT, as the API will put them on the document (D-120 rule
 * 2): all that is left of a line takes exactly what is left of its amount, a part its share of it,
 * rounded to the currency. Null when a line's amounts are hidden from this member (redaction).
 */
export function returnAmount(purchase: PurchaseDto, fields: ReturnFields): string | null {
  if (!isCurrencyCode(purchase.currency)) return null
  const digits = currencyMinorUnit(purchase.currency)
  const amounts: string[] = []
  for (const typed of fields.lines ?? []) {
    const line = purchase.lines.find((l) => l.id === typed.purchaseLineId)
    if (!line || typed.qty == null) return null
    if (line.taxable === undefined || line.returnedAmount === undefined) return null
    if (line.creditedAmount === undefined) return null
    const left = quantityLeft(line)
    const netLeft = subtractDecimals(line.taxable, line.returnedAmount, line.creditedAmount)
    amounts.push(
      compareDecimal(typed.qty, left) === 0
        ? netLeft
        : proportionOf(netLeft, typed.qty, left, digits),
    )
  }
  return sumDecimals(amounts)
}

/** What a credit note takes off before VAT: its one amount, or its lines' amounts. */
export function creditTotal(fields: ReturnFields): string {
  return fields.splitAmount ?? sumDecimals((fields.lines ?? []).map((line) => line.amount ?? '0'))
}
