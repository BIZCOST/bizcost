import type { DocumentPaymentStateDto, RefundSaleInput, SaleLineDto } from '@bizcost/contracts'
import {
  compareDecimal,
  computeSale,
  creditError,
  creditTotals,
  fitCredit,
  planCredit,
  saleError,
  subtractDecimals,
  type CreditBy,
  type CreditLinePlan,
  type CreditRequest,
  type CurrencyCode,
  type Money,
  type Quantity,
  type SaleLineInput,
  type SettlementMethod,
} from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { readAmount, readQuantity, type FieldError } from '../catalog/numbers'
import { closedFor } from '../documents/books'

// A refund (M3 Step 5; D-266; VAT ER Art. 60): of a finalized sale, or of a delivered order's sale.
// By quantity (goods came back: what they cost comes off too) or by amount (a price cut: no cost comes
// off), each line never more than is left of it; each later refund starts from what the earlier ones
// left. What it gives back is worked out here exactly as sale.refund works it out (the domain's
// credit maths: planCredit, computeSale once per VAT rate, fitCredit), so the sheet says it before it
// is recorded. On an order or a sale "they'll pay later", the money given back can be recorded with
// it, up to what was then paid beyond what it comes to (its method required, never picked for them).

export interface RefundDraft {
  readonly by: CreditBy
  readonly businessDate: string
  /** What each line takes back, as typed: a quantity, or an amount (by line id; '' : none). */
  readonly values: Readonly<Record<string, string>>
  readonly notes: string
  /** Give the money back now (only when there is money to give back). */
  readonly giveBack: boolean
  readonly method: SettlementMethod | ''
  readonly amount: string
}

export interface RefundErrors {
  businessDate?: FieldError
  lines: Record<string, FieldError>
  /** Nothing is taken back yet. */
  nothing?: FieldError
  method?: FieldError
  amount?: FieldError
  notes?: FieldError
}

/** A line that can be taken back: an item, a charge or delivery of a finalized sale, with what is left. */
export type RefundableLine = SaleLineDto & { readonly left: NonNullable<SaleLineDto['left']> }

/** What the refund takes back (positive), in all and per line. */
export interface RefundAmounts {
  readonly net: string
  readonly vat: string
  readonly total: string
}

export interface CheckedRefund {
  readonly errors: RefundErrors
  /** sale.refund's lines (null while something must be fixed). */
  readonly lines: RefundSaleInput['lines'] | null
  /** What it gives back in all (null while a line can't be worked out). */
  readonly amounts: RefundAmounts | null
  readonly perLine: ReadonlyMap<string, RefundAmounts>
  /** What could be given back with it: paid beyond what the document would come to ('0': none). */
  readonly canGiveBack: string
  /** What the customer would still owe after it (an order or a sale they'll pay later). */
  readonly owedAfter: string | null
  /** The money given back with it (null: none). */
  readonly payment: { readonly method: SettlementMethod; readonly amount: string } | null
}

/** The lines a refund may take back `by`: those with something left. */
export function refundableLines(lines: readonly SaleLineDto[], by: CreditBy): RefundableLine[] {
  return lines.filter((line): line is RefundableLine => {
    if (line.left === null || line.refundOfLineId !== null) return false
    if (by === 'quantity') return compareDecimal(line.left.qty, '0') > 0
    return compareDecimal(line.left.typed, '0') > 0
  })
}

const CREDIT_ERRORS = {
  not_positive: 'catalog.numbers.positive',
  too_many_decimals: 'catalog.numbers.tooManyDecimals',
  exceeds_left: 'orders.refund.errors.exceedsLeft',
} as const satisfies Record<string, I18nKey>

export const REFUND_MISSING: ReadonlySet<I18nKey> = new Set<I18nKey>([
  'orders.refund.errors.nothing',
  'orders.payment.methodRequired',
])

/** The computeSale input of a part of `line` (a plan that is not `whole`), as sale.refund makes it. */
function partOf(line: SaleLineDto, plan: CreditLinePlan & { whole: false }): SaleLineInput {
  const base = {
    qty: plan.qty as Quantity,
    unitPrice: plan.unitPrice as Money,
    priceIncludesVat: line.priceIncludesVat,
    discount: plan.discountAmount ? { amount: plan.discountAmount as Money } : null,
  }
  if (line.kind === 'delivery') return { kind: 'delivery', ...base }
  return {
    kind: line.kind === 'charge' ? 'charge' : 'item',
    ...base,
    vatCategory: line.vatCategory ?? 'standard',
  }
}

const BUSINESS_DAY = /^\d{4}-\d{2}-\d{2}$/

export function checkRefund(
  draft: RefundDraft,
  context: {
    readonly lines: readonly SaleLineDto[]
    readonly currency: CurrencyCode
    /** The sale's VAT registration (frozen when it was finalized). */
    readonly vatRegistered: boolean
    /** The sale's day: a refund is never before it. */
    readonly saleDate: string
    readonly today: string
    readonly closedThrough: string | null
    /**
     * An order's or a sale "they'll pay later"'s payments (null: a sale paid when made, or payments
     * not seen): what can be given back with the refund.
     */
    readonly owed: DocumentPaymentStateDto | null
    /** The member may record the money given back (payments.customers.record). */
    readonly canGiveBack: boolean
  },
): CheckedRefund {
  const errors: RefundErrors = { lines: {} }
  const { currency } = context
  if (!BUSINESS_DAY.test(draft.businessDate)) {
    errors.businessDate = { key: 'orders.refund.errors.date' }
  } else if (draft.businessDate > context.today) {
    errors.businessDate = { key: 'errors.future_date' }
  } else if (draft.businessDate < context.saleDate) {
    errors.businessDate = { key: 'orders.refund.errors.beforeSale' }
  } else if (closedFor(draft.businessDate, context.today, context.closedThrough)) {
    errors.businessDate = { key: 'orders.refund.errors.booksClosed' }
  }
  const notes = draft.notes.trim()
  if (notes.length > 1000) errors.notes = { key: 'orders.tooLong', values: { count: 1000 } }

  // Each line asked: what it takes back, planned as sale.refund plans it.
  const planned: { line: RefundableLine; plan: CreditLinePlan; request: CreditRequest }[] = []
  const lines: NonNullable<CheckedRefund['lines']>[number][] = []
  for (const line of refundableLines(context.lines, draft.by)) {
    const typed = (draft.values[line.id] ?? '').trim()
    if (typed === '') continue
    let request: CreditRequest
    if (draft.by === 'quantity') {
      const qty = readQuantity(typed)
      if (!qty.ok) {
        errors.lines[line.id] = qty.error
        continue
      }
      request = { by: 'quantity', qty: qty.value }
    } else {
      const amount = readAmount(typed)
      if (!amount.ok) {
        errors.lines[line.id] = amount.error
        continue
      }
      request = { by: 'amount', amount: amount.value }
    }
    const problem = creditError(line.left, request, currency)
    if (problem) {
      errors.lines[line.id] = { key: CREDIT_ERRORS[problem] }
      continue
    }
    const credited = {
      qty: line.qty,
      unitPrice: line.unitPrice,
      priceIncludesVat: line.priceIncludesVat,
      net: line.net,
      vat: line.vat,
      total: line.total,
    }
    planned.push({ line, plan: planCredit(credited, line.left, request, currency), request })
    lines.push(
      request.by === 'quantity'
        ? { lineId: line.id, qty: request.qty }
        : { lineId: line.id, amount: request.amount },
    )
  }

  // The parts' amounts: computeSale, VAT once per rate, under the sale's VAT registration.
  const parts = planned.filter((p) => !p.plan.whole)
  const input = {
    vatRegistered: context.vatRegistered,
    lines: parts.map((p) => partOf(p.line, p.plan as CreditLinePlan & { whole: false })),
  }
  const computable = parts.length === 0 || saleError(input, currency) === null
  const computed = parts.length > 0 && computable ? computeSale(input, currency) : null
  const perLine = new Map<string, RefundAmounts>()
  if (computable) {
    for (const p of planned) {
      if (p.plan.whole) {
        perLine.set(p.line.id, creditTotals([p.plan]))
      } else {
        const at = parts.indexOf(p)
        const a = computed!.lines[at]!
        perLine.set(p.line.id, creditTotals([fitCredit(p.line.left, a, p.line.priceIncludesVat)]))
      }
    }
  }
  const amounts = computable && planned.length > 0 ? creditTotals([...perLine.values()]) : null
  const anyLineError = Object.keys(errors.lines).length > 0
  if (planned.length === 0 && !anyLineError)
    errors.nothing = { key: 'orders.refund.errors.nothing' }

  // The money given back: what was paid beyond what the document would come to after this refund.
  let canGiveBack = '0'
  let owedAfter: string | null = null
  if (context.owed && amounts) {
    const paid = subtractDecimals(context.owed.paid, context.owed.refunded)
    const comesTo = subtractDecimals(context.owed.total, context.owed.credited, amounts.total)
    const beyond = subtractDecimals(paid, comesTo)
    canGiveBack = compareDecimal(beyond, '0') > 0 ? beyond : '0'
    owedAfter = compareDecimal(beyond, '0') < 0 ? subtractDecimals('0', beyond) : '0'
  }
  let payment: CheckedRefund['payment'] = null
  const offered = context.canGiveBack && compareDecimal(canGiveBack, '0') > 0
  if (offered && draft.giveBack) {
    if (draft.method === '') errors.method = { key: 'orders.payment.methodRequired' }
    const amount = readAmount(draft.amount, { positive: true, currency })
    if (!amount.ok) errors.amount = amount.error
    else if (compareDecimal(amount.value, canGiveBack) > 0) {
      errors.amount = { key: 'orders.payment.overMoneyBack' }
    } else if (draft.method !== '') payment = { method: draft.method, amount: amount.value }
  }

  const valid =
    !errors.businessDate &&
    !errors.notes &&
    !anyLineError &&
    !errors.nothing &&
    !errors.method &&
    !errors.amount &&
    amounts !== null
  return {
    errors,
    lines: valid ? lines : null,
    amounts,
    perLine,
    canGiveBack,
    owedAfter,
    payment,
  }
}
