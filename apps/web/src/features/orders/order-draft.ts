import {
  ORDER_CUSTOMER_REF_MAX_LENGTH,
  type CreateOrderInput,
  type OrderDto,
} from '@bizcost/contracts'
import {
  compareDecimal,
  newId,
  type LineDiscount,
  type SaleAmounts,
  type SaleLineAmounts,
  type SettlementMethod,
} from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { readAmount, type FieldError } from '../catalog/numbers'
import { asDiscount, discountDraft, discountOf, type DiscountKind } from '../documents/lines'
import {
  checkSale,
  MISSING_KEYS,
  newItemLine,
  saleDraft,
  type SaleDraft,
  type SaleErrors,
  type SaleFormContext,
} from '../sales/sale-draft'

// An order (M3 Step 5; Q16, Q17, Q19, D-265): a customer (or none, a walk-in), the customer's own
// reference (their LPO), the day it was taken and when it is due, what they ordered (each line a
// product or service, as One sale's: sale-draft.ts), a discount on the whole order, delivery yes or no
// (yes asks for the area, what the customer is charged and what it costs), notes, and for a new order
// "Paid now / Deposit" with how it was paid (required, never picked for them, D-159). The running
// amounts are the domain's sale maths (computeSale, D-220), as the API stores them.

/** "Paid now": nothing yet, a deposit (part of it), or all of it. */
export type PaidNow = 'none' | 'deposit' | 'all'

export interface OrderDraft extends SaleDraft {
  readonly customerRef: string
  /** '' : not said. */
  readonly dueDate: string
  readonly discountKind: DiscountKind
  readonly discount: string
  readonly paidNow: PaidNow
  /** The deposit typed ('all' pays the total). */
  readonly paidAmount: string
  /** '' until one is picked (never preselected). */
  readonly paidMethod: SettlementMethod | ''
}

export interface OrderErrors extends SaleErrors {
  customerRef?: FieldError
  dueDate?: FieldError
  paidAmount?: FieldError
  paidMethod?: FieldError
}

/** order.create's fields (without the id and the payment); order.update adds the id and version. */
export type OrderFields = Omit<CreateOrderInput, 'id' | 'payment'>

export interface OrderFormContext extends Omit<SaleFormContext, 'documentDiscount'> {
  /** "Paid now / Deposit" is asked (a new order, with payments.customers.record). */
  readonly paymentAsked: boolean
}

export interface CheckedOrder {
  readonly errors: OrderErrors
  /** The fields to save; null while something must be fixed. */
  readonly fields: OrderFields | null
  /** "Paid now / Deposit": its method and amount (null: nothing paid now). */
  readonly payment: { readonly method: SettlementMethod; readonly amount: string } | null
  readonly amounts: SaleAmounts | null
  readonly lineAmounts: ReadonlyMap<string, SaleLineAmounts>
  readonly hasItem: boolean
}

/** Problems that only say something is missing: shown once the person tries to save. */
export const ORDER_MISSING: ReadonlySet<I18nKey> = new Set<I18nKey>([
  ...MISSING_KEYS,
  'orders.editor.errors.paidMethod',
])

/** A new order taken today, with one line; or a pending order as it is stored. */
export function orderDraft(
  order: OrderDto | undefined,
  defaults: { today: string; locationId: string | null },
): OrderDraft {
  const empty = saleDraft(undefined, {
    today: defaults.today,
    channelId: null,
    locationId: defaults.locationId,
  })
  const extra = {
    paidNow: 'none' as const,
    paidAmount: '',
    paidMethod: '' as const,
  }
  if (!order) {
    return {
      ...empty,
      lines: [newItemLine()],
      customerRef: '',
      dueDate: '',
      discountKind: 'none',
      discount: '',
      ...extra,
    }
  }
  const delivery = order.lines.find((line) => line.kind === 'delivery')
  const cost = order.ownDeliveryCost ?? order.deliveryCost
  return {
    ...empty,
    businessDate: order.businessDate,
    channelId: order.channelId,
    locationId: order.locationId,
    lines: order.lines
      .filter((line) => line.kind === 'item')
      .map((line) => ({
        id: line.id,
        productId: line.productId ?? '',
        qty: line.qty,
        price: line.unitPrice,
        ...discountDraft(line.discount),
        savedName: line.description,
        savedProductId: line.productId,
      })),
    deliveryNeeded: order.deliveryNeeded,
    deliveryArea: order.deliveryArea ?? '',
    deliveryLineId: delivery?.id ?? newId(),
    deliveryCharged: delivery?.unitPrice ?? '',
    deliveryIncludesVat: delivery?.priceIncludesVat ?? false,
    deliveryCost: typeof cost === 'string' ? cost : '',
    notes: order.notes ?? '',
    customer: order.customerId
      ? {
          id: order.customerId,
          name: order.customerName ?? '',
          kind: 'individual',
          phone: null,
          phoneLast4: order.customerPhoneLast4,
          archived: false,
        }
      : null,
    payLater: false,
    customerRef: order.customerRef ?? '',
    dueDate: order.dueDate ?? '',
    ...discountDraft(order.discount),
    ...extra,
  }
}

const BUSINESS_DAY = /^\d{4}-\d{2}-\d{2}$/

/** Every problem of the order, its running amounts, and the fields to send when there is none. */
export function checkOrder(draft: OrderDraft, context: OrderFormContext): CheckedOrder {
  // The discount on the whole order, as typed.
  const discountRead = discountOf(draft.discountKind, draft.discount)
  const documentDiscount: LineDiscount | null =
    discountRead && discountRead.ok ? asDiscount(draft.discountKind, discountRead.value) : null
  const sale = checkSale(draft, { ...context, documentDiscount })
  const errors: OrderErrors = { ...sale.errors }
  if (discountRead && !discountRead.ok) errors.discount = discountRead.error

  const ref = draft.customerRef.trim()
  if (ref.length > ORDER_CUSTOMER_REF_MAX_LENGTH) {
    errors.customerRef = { key: 'orders.tooLong', values: { count: ORDER_CUSTOMER_REF_MAX_LENGTH } }
  }
  const due = draft.dueDate.trim()
  if (due !== '') {
    if (!BUSINESS_DAY.test(due)) errors.dueDate = { key: 'orders.editor.errors.dueDate' }
    else if (BUSINESS_DAY.test(draft.businessDate) && due < draft.businessDate) {
      errors.dueDate = { key: 'orders.editor.errors.dueBefore' }
    }
  }

  // "Paid now / Deposit": how much (a deposit: more than zero, at most the total) and how.
  let payment: CheckedOrder['payment'] = null
  if (context.paymentAsked && draft.paidNow !== 'none') {
    const total = sale.amounts?.total ?? '0'
    let amount: string | null = null
    if (draft.paidNow === 'all') {
      if (compareDecimal(total, '0') <= 0)
        errors.paidAmount = { key: 'orders.editor.errors.nothingToPay' }
      else amount = total
    } else {
      const read = readAmount(draft.paidAmount, { positive: true, currency: context.currency })
      if (!read.ok) errors.paidAmount = read.error
      else if (compareDecimal(read.value, total) > 0) {
        errors.paidAmount = { key: 'orders.editor.errors.depositOverTotal' }
      } else amount = read.value
    }
    if (draft.paidMethod === '') errors.paidMethod = { key: 'orders.editor.errors.paidMethod' }
    if (amount !== null && draft.paidMethod !== '') {
      payment = { method: draft.paidMethod, amount }
    }
  }

  const valid =
    sale.fields !== null &&
    !errors.discount &&
    !errors.customerRef &&
    !errors.dueDate &&
    !errors.paidAmount &&
    !errors.paidMethod
  let fields: OrderFields | null = null
  if (valid && sale.fields) {
    const saleFields = sale.fields
    fields = {
      customerId: saleFields.customerId ?? null,
      customerRef: ref || null,
      businessDate: saleFields.businessDate,
      dueDate: due || null,
      locationId: saleFields.locationId ?? null,
      channelId: saleFields.channelId ?? null,
      discount: documentDiscount,
      deliveryNeeded: saleFields.deliveryNeeded ?? false,
      deliveryArea: saleFields.deliveryArea ?? null,
      ...('deliveryCost' in saleFields ? { deliveryCost: saleFields.deliveryCost } : {}),
      notes: saleFields.notes ?? null,
      lines: saleFields.lines ?? [],
    }
  }
  return {
    errors,
    fields,
    payment,
    amounts: sale.amounts,
    lineAmounts: sale.lineAmounts,
    hasItem: sale.hasItem,
  }
}
