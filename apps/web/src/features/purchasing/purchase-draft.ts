import {
  DOCUMENT_NOTES_MAX_LENGTH,
  DOCUMENT_REFERENCE_MAX_LENGTH,
  PURCHASE_LINE_DESCRIPTION_MAX_LENGTH,
  type CreatePurchaseInput,
  type DiscountDto,
  type MaterialDto,
  type PurchaseDto,
} from '@bizcost/contracts'
import {
  computePurchase,
  defaultPricesIncludeVat,
  lineError,
  newId,
  purchaseError,
  type CurrencyCode,
  type LineDiscount,
  type Money,
  type PaymentMethod,
  type Percent,
  type PurchaseAmounts,
  type PurchaseDocumentType,
  type PurchaseLineAmounts,
  type PurchaseLineInput,
  type Quantity,
  type StandardUnit,
} from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import {
  readAmount,
  readPercent,
  readQuantity,
  type FieldError,
  type ReadNumber,
} from '../catalog/numbers'
import {
  baseQuantity,
  defaultUnitOf,
  isUnitOf,
  lineUnitOf,
  unitRefOf,
  type LineUnit,
} from './line-units'

// The purchase editor's form (M2 Step 3; D-114 rule 4, D-134): what the person typed, checked as the
// API checks it, the running amounts worked out by the domain's purchase maths (the same function the
// API stores a draft's amounts with: discounts before VAT, the document discount and delivery split by
// line net, each amount rounded to the currency), and purchase.create / purchase.update's fields.
// VAT is asked only of a VAT-registered business; any other business types what it paid, with no VAT
// (it is part of its cost either way).

/**
 * The UAE's standard VAT rate (D-121), the one a tax invoice line of a VAT-registered business
 * starts with; the person can pick "No VAT" on a line.
 */
export const STANDARD_VAT_RATE = '5'
export const NO_VAT = '0'

export type DiscountKind = 'none' | 'percent' | 'amount'

export interface MaterialLineDraft {
  readonly kind: 'material'
  readonly id: string
  /** '' until chosen. */
  readonly materialId: string
  readonly qty: string
  readonly unit: LineUnit
  /** Per purchase unit, before VAT (as typed). */
  readonly price: string
  readonly discountKind: DiscountKind
  readonly discount: string
  /** Percent as a decimal string ('5', '0'). */
  readonly vatRate: string
  /** The material's name when the line was saved (a material removed since still has a name). */
  readonly savedName: string | null
}

export interface DeliveryLineDraft {
  readonly kind: 'delivery'
  readonly id: string
  readonly description: string
  readonly amount: string
  readonly vatRate: string
}

export type LineDraft = MaterialLineDraft | DeliveryLineDraft

export interface PurchaseDraft {
  /** '' for none. */
  readonly supplierId: string
  readonly businessDate: string
  readonly documentType: PurchaseDocumentType
  readonly reference: string
  /** '' until one is picked (required before a save). */
  readonly paymentMethod: PaymentMethod | ''
  /** paid_by_member: the member who paid from their own money ('' until picked). */
  readonly paidByMemberId: string
  /**
   * Whether the prices, discounts and delivery amounts are typed with their VAT (a VAT-registered
   * business only; the amounts worked out are before VAT, VAT and total either way).
   */
  readonly pricesIncludeVat: boolean
  /** null: the default branch. */
  readonly locationId: string | null
  readonly vatNotReclaimable: boolean
  readonly discountKind: DiscountKind
  readonly discount: string
  readonly notes: string
  readonly lines: readonly LineDraft[]
}

export interface LineErrors {
  material?: FieldError
  qty?: FieldError
  unit?: FieldError
  price?: FieldError
  discount?: FieldError
  amount?: FieldError
  description?: FieldError
}

export interface PurchaseErrors {
  businessDate?: FieldError
  reference?: FieldError
  paymentMethod?: FieldError
  notes?: FieldError
  discount?: FieldError
  /** The document as a whole (e.g. delivery without a material). */
  document?: FieldError
  lines: Record<string, LineErrors>
}

/** purchase.create's fields (without the id); purchase.update adds the id and the version. */
export type PurchaseFields = Omit<CreatePurchaseInput, 'id'>

export interface PurchaseFormContext {
  readonly currency: CurrencyCode
  /** Materials by id (every material the lines may name, archived ones included). */
  readonly materials: ReadonlyMap<string, MaterialDto>
  readonly vatRegistered: boolean
  /** Today in the business's time zone (a later day cannot be posted). */
  readonly today: string
  /**
   * The members who may be said to have paid (purchase.payers), once read: a draft naming someone
   * who left picks another before it is saved.
   */
  readonly payers?: ReadonlySet<string>
}

export interface CheckedPurchase {
  readonly errors: PurchaseErrors
  /** The fields to save; null while something must be fixed. */
  readonly fields: PurchaseFields | null
  /** The running amounts of the lines that can be worked out (incomplete lines count as nothing). */
  readonly amounts: PurchaseAmounts
  /** Each line's amounts, by line id (only lines counted in `amounts`). */
  readonly lineAmounts: ReadonlyMap<string, PurchaseLineAmounts>
  /** Whether the document has a material line (it can be finalized only then). */
  readonly hasMaterial: boolean
}

/** Problems that only say something is missing: shown once the person tries to save. */
export const MISSING_KEYS: ReadonlySet<I18nKey> = new Set<I18nKey>([
  'catalog.numbers.required',
  'catalog.form.pickUnit',
  'purchasing.editor.errors.material',
  'purchasing.editor.errors.paymentMethod',
  'purchasing.editor.errors.paymentMethodMember',
])

/** The VAT rate a new line starts with: the standard rate on a VAT-registered tax invoice. */
export function defaultVatRate(vatRegistered: boolean, documentType: PurchaseDocumentType): string {
  return vatRegistered && documentType === 'tax_invoice' ? STANDARD_VAT_RATE : NO_VAT
}

export function newMaterialLine(vatRate: string, material?: MaterialDto): MaterialLineDraft {
  return {
    kind: 'material',
    id: newId(),
    materialId: material?.id ?? '',
    qty: '',
    unit: material ? defaultUnitOf(material) : '',
    price: '',
    discountKind: 'none',
    discount: '',
    vatRate,
    savedName: null,
  }
}

export function newDeliveryLine(vatRate: string): DeliveryLineDraft {
  return { kind: 'delivery', id: newId(), description: '', amount: '', vatRate }
}

function discountDraft(discount: DiscountDto | null | undefined): {
  discountKind: DiscountKind
  discount: string
} {
  if (!discount) return { discountKind: 'none', discount: '' }
  return 'percent' in discount
    ? { discountKind: 'percent', discount: discount.percent }
    : { discountKind: 'amount', discount: discount.amount }
}

/**
 * The form's first state: a new purchase dated today (the document type a VAT-registered business
 * usually gets is a tax invoice; prices before VAT on a tax invoice, with VAT otherwise; no payment
 * method until one is picked), or a saved draft as it is stored.
 */
export function purchaseDraft(
  purchase: PurchaseDto | undefined,
  defaults: { today: string; vatRegistered: boolean },
): PurchaseDraft {
  if (!purchase) {
    const documentType: PurchaseDocumentType = defaults.vatRegistered
      ? 'tax_invoice'
      : 'non_tax_invoice'
    return {
      supplierId: '',
      businessDate: defaults.today,
      documentType,
      reference: '',
      paymentMethod: '',
      paidByMemberId: '',
      pricesIncludeVat: defaultPricesIncludeVat(documentType),
      locationId: null,
      vatNotReclaimable: false,
      discountKind: 'none',
      discount: '',
      notes: '',
      lines: [newMaterialLine(defaultVatRate(defaults.vatRegistered, documentType))],
    }
  }
  return {
    supplierId: purchase.supplierId ?? '',
    businessDate: purchase.businessDate,
    documentType: purchase.documentType,
    reference: purchase.reference ?? '',
    paymentMethod: purchase.paymentMethod ?? '',
    paidByMemberId: purchase.paidByMemberId ?? '',
    pricesIncludeVat: purchase.pricesIncludeVat,
    locationId: purchase.locationId,
    vatNotReclaimable: purchase.vatNotReclaimable,
    ...discountDraft(purchase.discount),
    notes: purchase.notes ?? '',
    lines: purchase.lines.map((line): LineDraft =>
      line.kind === 'delivery'
        ? {
            kind: 'delivery',
            id: line.id,
            description: line.description ?? '',
            amount: line.unitPrice ?? '',
            vatRate: line.vatRate,
          }
        : {
            kind: 'material',
            id: line.id,
            materialId: line.materialId ?? '',
            qty: line.qty,
            unit: lineUnitOf(line.unit, line.packId),
            price: line.unitPrice ?? '',
            ...discountDraft(line.discount),
            vatRate: line.vatRate,
            savedName: line.description,
          },
    ),
  }
}

function discountOf(kind: DiscountKind, value: string): ReadNumber | null {
  if (kind === 'none') return null
  return kind === 'percent' ? readPercent(value) : readAmount(value)
}

function asDiscount(kind: DiscountKind, value: string): LineDiscount | null {
  if (kind === 'none') return null
  return kind === 'percent' ? { percent: value as Percent } : { amount: value as Money }
}

const BUSINESS_DAY = /^\d{4}-\d{2}-\d{2}$/

/** Every problem of the form, the running amounts, and the fields to send when there is none. */
export function checkPurchase(draft: PurchaseDraft, context: PurchaseFormContext): CheckedPurchase {
  const errors: PurchaseErrors = { lines: {} }
  const vatRateOf = (rate: string) => (context.vatRegistered ? rate : NO_VAT)
  // Only a VAT-registered business chooses; any other types what it paid, with no VAT.
  const pricesIncludeVat = context.vatRegistered && draft.pricesIncludeVat

  if (!BUSINESS_DAY.test(draft.businessDate)) {
    errors.businessDate = { key: 'purchasing.editor.errors.date' }
  } else if (draft.businessDate > context.today) {
    errors.businessDate = { key: 'errors.future_date' }
  }
  // How it was paid is required (the API refuses a save without it); on credit needs the supplier,
  // paid by a member needs the member.
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

  // Each line on its own; the ones that read count in the running amounts.
  const fieldLines: PurchaseFields['lines'] = []
  const counted: { id: string; input: PurchaseLineInput }[] = []
  for (const line of draft.lines) {
    const lineErrors: LineErrors = {}
    if (line.kind === 'delivery') {
      const amount = readAmount(line.amount)
      if (!amount.ok) lineErrors.amount = amount.error
      const description = line.description.trim()
      if (description.length > PURCHASE_LINE_DESCRIPTION_MAX_LENGTH) {
        lineErrors.description = {
          key: 'purchasing.tooLong',
          values: { count: PURCHASE_LINE_DESCRIPTION_MAX_LENGTH },
        }
      }
      if (amount.ok) {
        counted.push({
          id: line.id,
          input: {
            kind: 'delivery',
            amount: amount.value as Money,
            vatRate: vatRateOf(line.vatRate) as Percent,
          },
        })
        fieldLines.push({
          kind: 'delivery',
          id: line.id,
          description: description || null,
          amount: amount.value,
          vatRate: vatRateOf(line.vatRate),
        })
      }
      if (Object.keys(lineErrors).length > 0) errors.lines[line.id] = lineErrors
      continue
    }

    const material = line.materialId ? context.materials.get(line.materialId) : undefined
    if (!line.materialId) lineErrors.material = { key: 'purchasing.editor.errors.material' }
    else if (!material) lineErrors.material = { key: 'purchasing.editor.errors.materialGone' }
    const qty = readQuantity(line.qty)
    if (!qty.ok) lineErrors.qty = qty.error
    const ref = unitRefOf(line.unit)
    if (!ref) lineErrors.unit = { key: 'catalog.form.pickUnit' }
    else if (material && !isUnitOf(material, line.unit)) {
      lineErrors.unit = { key: 'purchasing.editor.errors.unitGone' }
    } else if (material && ref && qty.ok) {
      const base = baseQuantity(material, qty.value as Quantity, ref)
      if (!base.ok) {
        lineErrors.qty = {
          key:
            base.error === 'too_large'
              ? 'purchasing.editor.errors.qtyTooLarge'
              : base.error === 'too_small'
                ? 'purchasing.editor.errors.qtyTooSmall'
                : 'purchasing.editor.errors.unitGone',
        }
      }
    }
    const price = readAmount(line.price)
    if (!price.ok) lineErrors.price = price.error
    const discount = discountOf(line.discountKind, line.discount)
    if (discount && !discount.ok) lineErrors.discount = discount.error
    if (qty.ok && price.ok && (!discount || discount.ok)) {
      const input = {
        kind: 'material' as const,
        qty: qty.value as Quantity,
        unitPrice: price.value as Money,
        discount: asDiscount(line.discountKind, discount?.ok ? discount.value : ''),
        vatRate: vatRateOf(line.vatRate) as Percent,
      }
      if (lineError(input, context.currency) === 'discount_over_subtotal') {
        lineErrors.discount = { key: 'purchasing.editor.errors.discountOverLine' }
      } else {
        counted.push({ id: line.id, input })
      }
    }
    if (Object.keys(lineErrors).length === 0 && ref) {
      fieldLines.push({
        kind: 'material',
        id: line.id,
        materialId: line.materialId,
        qty: (qty as { value: string }).value,
        unit: typeof ref === 'string' ? (ref as StandardUnit) : null,
        packId: typeof ref === 'string' ? null : ref.pack,
        unitPrice: (price as { value: string }).value,
        discount: discount?.ok
          ? line.discountKind === 'percent'
            ? { percent: discount.value }
            : { amount: discount.value }
          : null,
        vatRate: vatRateOf(line.vatRate),
      })
    }
    if (Object.keys(lineErrors).length > 0) errors.lines[line.id] = lineErrors
  }

  const hasMaterial = draft.lines.some((line) => line.kind === 'material')
  const hasDelivery = draft.lines.some((line) => line.kind === 'delivery')
  const documentDiscount = discountOf(draft.discountKind, draft.discount)
  if (documentDiscount && !documentDiscount.ok) errors.discount = documentDiscount.error
  if (!hasMaterial && (hasDelivery || draft.discountKind !== 'none')) {
    errors.document = { key: 'purchasing.editor.errors.noMaterial' }
  }

  // The running amounts: what can be worked out now (a discount larger than the lines is said on it
  // and left out until it is fixed).
  let discount = documentDiscount?.ok
    ? asDiscount(draft.discountKind, documentDiscount.value)
    : null
  let lines = counted
  const inputOf = () => ({
    lines: lines.map((l) => l.input),
    discount,
    vatInCost: false,
    pricesIncludeVat,
  })
  for (let attempt = 0; attempt < 3; attempt++) {
    const problem = purchaseError(inputOf(), context.currency)
    if (!problem) break
    if (problem.line !== undefined) {
      const id = lines[problem.line]!.id
      lines = lines.filter((line) => line.id !== id)
      continue
    }
    if (discount && problem.code !== 'no_material_line') {
      errors.discount = { key: 'purchasing.editor.errors.discountOverNet' }
    }
    if (discount) discount = null
    else lines = lines.filter((line) => line.input.kind === 'material')
  }
  const amounts = computePurchase(inputOf(), context.currency)
  const lineAmounts = new Map(lines.map((line, index) => [line.id, amounts.lines[index]!]))

  const valid =
    Object.keys(errors.lines).length === 0 &&
    !errors.businessDate &&
    !errors.reference &&
    !errors.paymentMethod &&
    !errors.notes &&
    !errors.discount &&
    !errors.document &&
    fieldLines.length === draft.lines.length
  return {
    errors,
    amounts,
    lineAmounts,
    hasMaterial,
    fields:
      valid && draft.paymentMethod !== ''
        ? {
            supplierId: draft.supplierId || null,
            businessDate: draft.businessDate,
            documentType: draft.documentType,
            reference: reference || null,
            paymentMethod: draft.paymentMethod,
            paidByMemberId: draft.paymentMethod === 'paid_by_member' ? draft.paidByMemberId : null,
            pricesIncludeVat,
            locationId: draft.locationId,
            vatNotReclaimable: context.vatRegistered ? draft.vatNotReclaimable : false,
            discount: documentDiscount?.ok
              ? draft.discountKind === 'percent'
                ? { percent: documentDiscount.value }
                : { amount: documentDiscount.value }
              : null,
            notes: notes || null,
            lines: fieldLines,
          }
        : null,
  }
}

/** The names of the materials on the lines, each once, in their order (for the confirmations). */
export function materialNames(
  draft: Pick<PurchaseDraft, 'lines'>,
  materials: ReadonlyMap<string, MaterialDto>,
): string[] {
  const names: string[] = []
  for (const line of draft.lines) {
    if (line.kind !== 'material') continue
    const name = materials.get(line.materialId)?.name ?? line.savedName
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}
