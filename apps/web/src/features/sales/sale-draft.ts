import {
  DELIVERY_AREA_MAX_LENGTH,
  DOCUMENT_NOTES_MAX_LENGTH,
  type CreateSaleInput,
  type ProductDto,
  type SaleDto,
} from '@bizcost/contracts'
import {
  compareDecimal,
  computeSale,
  newId,
  saleError,
  type CurrencyCode,
  type Money,
  type Quantity,
  type SaleAmounts,
  type SaleLineAmounts,
  type SaleLineInput,
} from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { readAmount, readQuantity, type FieldError } from '../catalog/numbers'
import { asDiscount, discountDraft, discountOf, type DiscountKind } from '../documents/lines'

// One sale («عملية بيع», M3 Step 2; Q9): a job or a single customer. Each line names a product or
// service of the business (added on the spot when it is new), how many, its price (filled in from
// the usual price, typed as the product's prices are: before VAT, or with VAT when the product says
// so, D-121) and an optional discount; delivery is yes or no, and yes asks for the area, what the
// customer was charged (a delivery line, standard-rated for a VAT-registered business) and what it
// actually cost (typed by the member who enters the sale, D-230). The running amounts are the
// domain's sale maths (computeSale, D-220), as the API stores them.

export interface ItemLineDraft {
  readonly id: string
  /** '' until chosen. */
  readonly productId: string
  readonly qty: string
  readonly price: string
  readonly discountKind: DiscountKind
  readonly discount: string
  /** The line's name when it was saved (kept while it names the same product, D-002). */
  readonly savedName: string | null
  /** The product it named when it was saved. */
  readonly savedProductId: string | null
}

export interface SaleDraft {
  readonly businessDate: string
  /** null: the business's only channel. */
  readonly channelId: string | null
  /** null: the default branch. */
  readonly locationId: string | null
  readonly lines: readonly ItemLineDraft[]
  readonly deliveryNeeded: boolean
  readonly deliveryArea: string
  /** The delivery line's id (kept when stored). */
  readonly deliveryLineId: string
  /** What the customer was charged for delivery ('' or 0: free for them, no delivery line). */
  readonly deliveryCharged: string
  /** The charge was typed with its VAT (a VAT-registered business). */
  readonly deliveryIncludesVat: boolean
  /** What the delivery actually cost the business ('' : not known yet). */
  readonly deliveryCost: string
  readonly notes: string
}

export interface ItemLineErrors {
  item?: FieldError
  qty?: FieldError
  price?: FieldError
  discount?: FieldError
}

export interface SaleErrors {
  businessDate?: FieldError
  deliveryArea?: FieldError
  deliveryCharged?: FieldError
  deliveryCost?: FieldError
  notes?: FieldError
  lines: Record<string, ItemLineErrors>
}

/** sale.create's fields (without the id and the source); sale.update adds the id and version. */
export type SaleFields = Omit<CreateSaleInput, 'id' | 'source'>

export interface SaleFormContext {
  readonly currency: CurrencyCode
  readonly vatRegistered: boolean
  /** Today in the business's time zone (a later day cannot be saved). */
  readonly today: string
  /** Every product and service the lines may name, by id (archived ones included). */
  readonly products: ReadonlyMap<string, ProductDto>
  /**
   * Whether the member types the delivery cost here: on their own sale, or seeing costs. Otherwise it
   * is not sent (an update keeps it).
   */
  readonly deliveryCostShown: boolean
  /**
   * The delivery cost as it was opened ('' for none): sent only once changed, so a value nobody
   * touched is kept as it is (D-210, D-230).
   */
  readonly storedDeliveryCost: string
}

export interface CheckedSale {
  readonly errors: SaleErrors
  /** The fields to save; null while something must be fixed. */
  readonly fields: SaleFields | null
  /** The running amounts of what can be worked out (incomplete lines count as nothing). */
  readonly amounts: SaleAmounts | null
  /** Each item line's amounts, by line id. */
  readonly lineAmounts: ReadonlyMap<string, SaleLineAmounts>
  /** The delivery charge's amounts, when there is one. */
  readonly deliveryAmounts: SaleLineAmounts | null
  /** Whether the sale names something sold (it can be finalized only then). */
  readonly hasItem: boolean
}

/** Problems that only say something is missing: shown once the person tries to save. */
export const MISSING_KEYS: ReadonlySet<I18nKey> = new Set<I18nKey>([
  'catalog.numbers.required',
  'sales.editor.errors.item',
])

export function newItemLine(product?: ProductDto): ItemLineDraft {
  return {
    id: newId(),
    productId: product?.id ?? '',
    qty: '1',
    price: product?.defaultPrice ?? '',
    discountKind: 'none',
    discount: '',
    savedName: null,
    savedProductId: null,
  }
}

/**
 * The form's first state: a new sale dated today with one line, or a saved draft as it is stored.
 * `deliveryCost`: what the member may read of it (their own, or seeing costs; '' otherwise).
 */
export function saleDraft(
  sale: SaleDto | undefined,
  defaults: { today: string; channelId: string | null; locationId: string | null },
): SaleDraft {
  if (!sale) {
    return {
      businessDate: defaults.today,
      channelId: defaults.channelId,
      locationId: defaults.locationId,
      lines: [newItemLine()],
      deliveryNeeded: false,
      deliveryArea: '',
      deliveryLineId: newId(),
      deliveryCharged: '',
      deliveryIncludesVat: false,
      deliveryCost: '',
      notes: '',
    }
  }
  const delivery = sale.lines.find((line) => line.kind === 'delivery')
  const cost = sale.ownDeliveryCost ?? sale.deliveryCost
  return {
    businessDate: sale.businessDate,
    channelId: sale.channelId,
    locationId: sale.locationId,
    lines: sale.lines
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
    deliveryNeeded: sale.deliveryNeeded,
    deliveryArea: sale.deliveryArea ?? '',
    deliveryLineId: delivery?.id ?? newId(),
    deliveryCharged: delivery?.unitPrice ?? '',
    deliveryIncludesVat: delivery?.priceIncludesVat ?? false,
    deliveryCost: typeof cost === 'string' ? cost : '',
    notes: sale.notes ?? '',
  }
}

const BUSINESS_DAY = /^\d{4}-\d{2}-\d{2}$/

/** Every problem of the form, the running amounts, and the fields to send when there is none. */
export function checkSale(draft: SaleDraft, context: SaleFormContext): CheckedSale {
  const errors: SaleErrors = { lines: {} }
  if (!BUSINESS_DAY.test(draft.businessDate)) {
    errors.businessDate = { key: 'sales.editor.errors.date' }
  } else if (draft.businessDate > context.today) {
    errors.businessDate = { key: 'errors.future_date' }
  }
  const notes = draft.notes.trim()
  if (notes.length > DOCUMENT_NOTES_MAX_LENGTH) {
    errors.notes = { key: 'sales.tooLong', values: { count: DOCUMENT_NOTES_MAX_LENGTH } }
  }

  // Each item line on its own; the ones that read count in the running amounts.
  const fieldLines: Extract<SaleFields['lines'], readonly unknown[]> = []
  const counted: { id: string; input: SaleLineInput }[] = []
  for (const line of draft.lines) {
    const lineErrors: ItemLineErrors = {}
    const product = line.productId ? context.products.get(line.productId) : undefined
    if (!line.productId) lineErrors.item = { key: 'sales.editor.errors.item' }
    else if (!product) lineErrors.item = { key: 'sales.editor.errors.itemGone' }
    const qty = readQuantity(line.qty)
    if (!qty.ok) lineErrors.qty = qty.error
    const price = readAmount(line.price)
    if (!price.ok) lineErrors.price = price.error
    const discount = discountOf(line.discountKind, line.discount)
    if (discount && !discount.ok) lineErrors.discount = discount.error
    if (product && qty.ok && price.ok && (!discount || discount.ok)) {
      const input: SaleLineInput = {
        kind: 'item',
        qty: qty.value as Quantity,
        unitPrice: price.value as Money,
        priceIncludesVat: context.vatRegistered && product.priceIncludesVat,
        discount: asDiscount(line.discountKind, discount?.ok ? discount.value : ''),
        vatCategory: product.vatCategory,
      }
      const problem = saleError(
        { lines: [input], vatRegistered: context.vatRegistered },
        context.currency,
      )
      if (problem) lineErrors.discount = { key: 'sales.editor.errors.discountOverLine' }
      else {
        counted.push({ id: line.id, input })
        fieldLines.push({
          kind: 'item',
          id: line.id,
          productId: line.productId,
          // The name it was saved with, while it names the same product (editable later, D-002).
          description:
            line.savedName && line.savedProductId === line.productId ? line.savedName : undefined,
          qty: qty.value,
          unitPrice: price.value,
          discount: asDiscount(line.discountKind, discount?.ok ? discount.value : ''),
        })
      }
    }
    if (Object.keys(lineErrors).length > 0) errors.lines[line.id] = lineErrors
  }

  // Delivery: the area, what the customer was charged (a line only when more than zero) and what it
  // cost (when the member types it here).
  let deliveryLine: SaleLineInput | null = null
  // Left out (undefined): kept by an update, cleared with delivery (D-230).
  let deliveryCost: string | null | undefined
  if (draft.deliveryNeeded) {
    if (draft.deliveryArea.trim().length > DELIVERY_AREA_MAX_LENGTH) {
      errors.deliveryArea = { key: 'sales.tooLong', values: { count: DELIVERY_AREA_MAX_LENGTH } }
    }
    if (draft.deliveryCharged.trim() !== '') {
      const charged = readAmount(draft.deliveryCharged)
      if (!charged.ok) errors.deliveryCharged = charged.error
      else if (compareDecimal(charged.value, '0') > 0) {
        deliveryLine = {
          kind: 'delivery',
          qty: '1' as Quantity,
          unitPrice: charged.value as Money,
          priceIncludesVat: context.vatRegistered && draft.deliveryIncludesVat,
        }
      }
    }
    if (context.deliveryCostShown && draft.deliveryCost.trim() !== context.storedDeliveryCost) {
      if (draft.deliveryCost.trim() === '') deliveryCost = null
      else {
        const cost = readAmount(draft.deliveryCost)
        if (!cost.ok) errors.deliveryCost = cost.error
        else deliveryCost = cost.value
      }
    }
  }

  const inputs = [...counted.map((line) => line.input), ...(deliveryLine ? [deliveryLine] : [])]
  const amounts =
    inputs.length > 0 &&
    saleError({ lines: inputs, vatRegistered: context.vatRegistered }, context.currency) === null
      ? computeSale({ lines: inputs, vatRegistered: context.vatRegistered }, context.currency)
      : null
  const lineAmounts = new Map(
    amounts ? counted.map((line, index) => [line.id, amounts.lines[index]!] as const) : [],
  )
  const deliveryAmounts = amounts && deliveryLine ? amounts.lines[counted.length]! : null

  const valid =
    Object.keys(errors.lines).length === 0 &&
    !errors.businessDate &&
    !errors.notes &&
    !errors.deliveryArea &&
    !errors.deliveryCharged &&
    !errors.deliveryCost &&
    fieldLines.length === draft.lines.length
  const area = draft.deliveryArea.trim()
  return {
    errors,
    amounts,
    lineAmounts,
    deliveryAmounts,
    hasItem: draft.lines.some((line) => line.productId !== ''),
    fields: valid
      ? {
          businessDate: draft.businessDate,
          periodFrom: null,
          locationId: draft.locationId,
          channelId: draft.channelId,
          deliveryNeeded: draft.deliveryNeeded,
          deliveryArea: draft.deliveryNeeded && area ? area : null,
          ...(deliveryCost === undefined ? {} : { deliveryCost }),
          notes: notes || null,
          lines: [
            ...fieldLines,
            ...(deliveryLine
              ? [
                  {
                    kind: 'delivery' as const,
                    id: draft.deliveryLineId,
                    amount: deliveryLine.unitPrice,
                    amountIncludesVat: deliveryLine.priceIncludesVat,
                  },
                ]
              : []),
          ],
        }
      : null,
  }
}
