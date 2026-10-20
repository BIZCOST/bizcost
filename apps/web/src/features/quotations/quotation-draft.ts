import {
  PAYMENT_STAGE_DUE_MAX_LENGTH,
  PAYMENT_STAGE_LABEL_MAX_LENGTH,
  QUOTATION_AREA_MAX_LENGTH,
  QUOTATION_CUSTOMER_REF_MAX_LENGTH,
  QUOTATION_GREETING_MAX_LENGTH,
  QUOTATION_INTRO_MAX_LENGTH,
  QUOTATION_LINE_DETAILS_MAX_LENGTH,
  QUOTATION_LINE_NOTE_MAX_LENGTH,
  QUOTATION_LINE_TITLE_MAX_LENGTH,
  QUOTATION_NOTES_MAX_LENGTH,
  QUOTATION_SITE_MAX_LENGTH,
  QUOTATION_TERMS_MAX_LENGTH,
  type CreateQuotationInput,
  type CustomerPickItemDto,
  type ProductDto,
  type QuotationDto,
} from '@bizcost/contracts'
import {
  computeSale,
  newId,
  PAYMENT_STAGES_MAX,
  paymentStageAmounts,
  paymentStagesError,
  saleError,
  solveRoundAmount,
  roundTheTotalError,
  type CurrencyCode,
  type LineDiscount,
  type Money,
  type Percent,
  type Quantity,
  type SaleAmounts,
  type SaleInput,
  type SaleLineAmounts,
  type SaleLineInput,
  type StandardUnit,
  type VatCategory,
} from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import type { Crop } from '../../components/crop/crop'
import { readAmount, readPercent, readQuantity, type FieldError } from '../catalog/numbers'
import { asDiscount, discountDraft, discountOf, type DiscountKind } from '../documents/lines'

// A quotation as its editor holds it (M3 Step 7; Q21–Q25; the owner's document requests of
// 2026-10-16): the customer and the project, the day and how long it is valid, the customer's own
// reference; its lines, each a product or service picked by name or typed (Q21: "Save as a work
// item" makes it one), with an area or room, a title, details that keep their line breaks, a
// highlighted note, a picture, how many in which unit, the price and a discount; a discount on the
// whole quotation; "Round the total" («تقريب الإجمالي», D-221): the total wanted with VAT, the
// adjustment before VAT and any rounding difference worked out here as the API works them out;
// payment stages that share the amount to pay (the last takes the rest exactly); the greeting, the
// sentence after it, the terms and notes. The running amounts are the domain's sale maths (computeSale,
// solveRoundAmount, paymentStageAmounts), as the API stores them.

/**
 * A line's picture as the editor holds it: the saved one, one picked (sent once saved), or none.
 * Every picture is saved in the PDF's frame (800 × 600, D-299): a picked one is framed at once
 * (centred, filling the frame), and "Adjust picture" moves and zooms it there.
 */
export interface LinePicture {
  /** The saved picture (an attachment of the line); null: none saved. */
  readonly saved: {
    readonly id: string
    readonly url: string | null
    readonly fileName: string
  } | null
  /** A picture picked or adjusted here (framed, 800 × 600), uploaded once the quotation is saved. */
  readonly pending: File | null
  /** The saved picture is taken off when the quotation is saved. */
  readonly remove: boolean
  /**
   * What "Adjust picture" opens again: the picture as picked (`file`; null: the saved one), with the
   * framing chosen; null: nothing adjusted yet (the saved picture, centred).
   */
  readonly source?: { readonly file: File | null; readonly crop: Crop } | null
}

export interface QuotationLineDraft {
  readonly id: string
  /** The product or service it names; null: typed (Q21). */
  readonly productId: string | null
  /** What is printed in bold: a product's name, editable, or the typed title. */
  readonly title: string
  /** The area or room it is in (one of the quotation's areas, D-299); null: none. */
  readonly area: string | null
  readonly details: string
  readonly note: string
  readonly qty: string
  /** A typed line's unit ('' : none). A product's own unit is used for a product. */
  readonly unit: StandardUnit | ''
  readonly price: string
  /** A typed line's VAT (a VAT-registered business). A product's own is used for a product. */
  readonly vatCategory: VatCategory
  readonly discountKind: DiscountKind
  readonly discount: string
  readonly picture: LinePicture
}

export interface QuotationStageDraft {
  /** The form's own key (stages are saved whole, never by id). */
  readonly key: string
  readonly label: string
  readonly due: string
  readonly percent: string
}

export interface QuotationDraft {
  readonly customer: CustomerPickItemDto | null
  readonly businessDate: string
  /** '' : on a new quotation, the business's usual number of days; on a saved one, not said. */
  readonly validUntil: string
  readonly customerRef: string
  readonly site: string
  /** null: the default branch. */
  readonly locationId: string | null
  readonly lines: readonly QuotationLineDraft[]
  readonly discountKind: DiscountKind
  readonly discount: string
  /** "Round the total": the total wanted, with VAT ('' : none). */
  readonly roundTo: string
  readonly greeting: string
  readonly intro: string
  readonly terms: string
  readonly notes: string
  readonly stages: readonly QuotationStageDraft[]
}

/**
 * Where a draft's rounded total was rounded when it came already rounded (D-297): on the
 * revision before (a revision), on the quotation it was copied from (a copy, revision 1), or here
 * (null: the editor speaks only once the amounts change).
 */
export function carriedRounding(
  quotation: Pick<QuotationDto, 'roundTo' | 'revision' | 'copiedFromId'> | undefined,
): 'revision' | 'copy' | null {
  if (!quotation?.roundTo) return null
  if (quotation.revision > 1) return 'revision'
  return quotation.copiedFromId !== null ? 'copy' : null
}

/**
 * What a quotation's amounts come from (its lines' products, quantities, prices, VAT and discounts, and
 * the discount on the whole quotation), to tell when they changed after its total was rounded (D-297).
 */
export function amountsKey<T extends Pick<LinesDraft, 'discountKind' | 'discount' | 'lines'>>(
  draft: T,
): string {
  return JSON.stringify([
    draft.discountKind,
    draft.discount,
    draft.lines.map((l) => [
      l.productId,
      l.qty,
      l.unit,
      l.price,
      l.vatCategory,
      l.discountKind,
      l.discount,
    ]),
  ])
}

export interface LineErrors {
  title?: FieldError
  qty?: FieldError
  price?: FieldError
  discount?: FieldError
  area?: FieldError
  details?: FieldError
  note?: FieldError
}

export interface StageErrors {
  label?: FieldError
  due?: FieldError
  percent?: FieldError
}

export interface QuotationErrors {
  customer?: FieldError
  businessDate?: FieldError
  validUntil?: FieldError
  customerRef?: FieldError
  site?: FieldError
  discount?: FieldError
  roundTo?: FieldError
  greeting?: FieldError
  intro?: FieldError
  terms?: FieldError
  notes?: FieldError
  /** The stages together (their % must add up to 100). */
  stages?: FieldError
  lines: Record<string, LineErrors>
  stageRows: Record<string, StageErrors>
}

/** quotation.create's fields (without the id); quotation.update adds the id and version. */
export type QuotationFields = Omit<CreateQuotationInput, 'id'>

export interface QuotationFormContext {
  readonly currency: CurrencyCode
  readonly vatRegistered: boolean
  /** Today in the business's time zone (a later day cannot be saved). */
  readonly today: string
  /** Every product and service the lines may name, by id (archived ones included). */
  readonly products: ReadonlyMap<string, ProductDto>
  /** A saved quotation (its terms and validity are sent as they stand; a new one's left out). */
  readonly saved: boolean
}

/** What "Round the total" came to: the adjustment before VAT, and what no rate could reach. */
export interface Rounding {
  /** The total wanted, with VAT, as read. */
  readonly wanted: string
  readonly adjustment: string
  readonly difference: string
}

export interface CheckedQuotation {
  readonly errors: QuotationErrors
  /** The fields to save; null while something must be fixed. */
  readonly fields: QuotationFields | null
  /** The running amounts of the lines that read (incomplete lines count as nothing). */
  readonly amounts: SaleAmounts | null
  readonly lineAmounts: ReadonlyMap<string, SaleLineAmounts>
  readonly rounding: Rounding | null
  /** Each stage's share of the amount to pay, by its key (when the stages read). */
  readonly stageAmounts: ReadonlyMap<string, string>
}

/** Problems that only say something is missing: shown once the person tries to save. */
export const QUOTATION_MISSING: ReadonlySet<I18nKey> = new Set<I18nKey>([
  'catalog.numbers.required',
  'documents.quotations.editor.errors.customer',
  'documents.quotations.editor.errors.title',
  'documents.quotations.editor.errors.due',
])

const NO_PICTURE: LinePicture = { saved: null, pending: null, remove: false }

export function newQuotationLine(): QuotationLineDraft {
  return {
    id: newId(),
    productId: null,
    title: '',
    area: null,
    details: '',
    note: '',
    qty: '1',
    unit: '',
    price: '',
    vatCategory: 'standard',
    discountKind: 'none',
    discount: '',
    picture: NO_PICTURE,
  }
}

/**
 * A line nothing was entered in yet (a new quotation's first line, a line just added): "Add an area"
 * puts such a line without an area into the new area instead of adding another (D-299).
 */
export function isBlankLine(line: QuotationLineDraft): boolean {
  return (
    line.productId === null &&
    line.title.trim() === '' &&
    line.details.trim() === '' &&
    line.note.trim() === '' &&
    line.price.trim() === '' &&
    ['', '1'].includes(line.qty.trim()) &&
    line.discountKind === 'none' &&
    line.picture.pending === null &&
    line.picture.saved === null
  )
}

export function newStage(percent = ''): QuotationStageDraft {
  return { key: newId(), label: '', due: '', percent }
}

/** A new quotation dated today with one empty line; or a saved draft as it is stored. */
export function quotationDraft(
  quotation: QuotationDto | undefined,
  defaults: { today: string; locationId: string | null },
): QuotationDraft {
  if (!quotation) {
    return {
      customer: null,
      businessDate: defaults.today,
      validUntil: '',
      customerRef: '',
      site: '',
      locationId: defaults.locationId,
      lines: [newQuotationLine()],
      discountKind: 'none',
      discount: '',
      roundTo: '',
      greeting: '',
      intro: '',
      terms: '',
      notes: '',
      stages: [],
    }
  }
  return {
    customer: {
      id: quotation.customerId,
      name: quotation.customerName,
      kind: 'individual',
      phone: null,
      phoneLast4: quotation.customerPhoneLast4,
      archived: false,
    },
    businessDate: quotation.businessDate,
    validUntil: quotation.validUntil ?? '',
    customerRef: quotation.customerRef ?? '',
    site: quotation.site ?? '',
    locationId: quotation.locationId,
    lines: quotation.lines.map((line) => ({
      id: line.id,
      productId: line.productId,
      title: line.description,
      area: line.area,
      details: line.details ?? '',
      note: line.note ?? '',
      qty: line.qty,
      unit: line.unit ?? '',
      price: line.unitPrice,
      vatCategory: line.vatCategory ?? 'standard',
      ...discountDraft(line.discount),
      picture: {
        saved: line.picture
          ? { id: line.picture.id, url: line.picture.url, fileName: line.picture.fileName }
          : null,
        pending: null,
        remove: false,
      },
    })),
    ...discountDraft(quotation.discount),
    roundTo: quotation.roundTo ?? '',
    greeting: quotation.greeting ?? '',
    intro: quotation.intro ?? '',
    terms: quotation.terms ?? '',
    notes: quotation.notes ?? '',
    stages: quotation.stages.map((stage) => ({
      key: stage.id,
      label: stage.label ?? '',
      due: stage.due,
      percent: stage.percent,
    })),
  }
}

const BUSINESS_DAY = /^\d{4}-\d{2}-\d{2}$/

/** Why a discount on the whole quotation can't be taken, by the domain's code. */
const DOCUMENT_DISCOUNT_ERRORS: Readonly<Record<string, I18nKey>> = {
  document_discount_negative: 'catalog.numbers.notNegative',
  document_discount_over_100_percent: 'documents.quotations.editor.errors.discountOver100',
  document_discount_over_net: 'documents.quotations.editor.errors.discountOverLines',
  document_discount_mixed_prices: 'documents.quotations.editor.errors.discountMixed',
}

/** Why "Round the total" can't reach a total, by the domain's code. */
const ROUND_ERRORS: Readonly<Record<string, I18nKey>> = {
  wanted_too_many_decimals: 'catalog.numbers.tooManyDecimals',
  wanted_opposite_sign: 'catalog.numbers.notNegative',
  unreachable: 'documents.quotations.editor.errors.roundUnreachable',
}

/** A text that may be at most `max` characters, trimmed; its problem, if any. */
function tooLong(value: string, max: number): FieldError | undefined {
  return value.trim().length > max
    ? { key: 'documents.quotations.editor.errors.tooLong', values: { count: max } }
    : undefined
}

const orNull = (value: string) => (value.trim() === '' ? null : value.trim())

/** A document's lines, its discount and "Round the total" as an editor holds them. */
export interface LinesDraft {
  readonly lines: readonly QuotationLineDraft[]
  readonly discountKind: DiscountKind
  readonly discount: string
  /** "Round the total": the total wanted, with VAT ('' : none). */
  readonly roundTo: string
}

export interface LinesErrors {
  discount?: FieldError
  roundTo?: FieldError
  lines: Record<string, LineErrors>
}

/** What a document's lines come to (the quotation's and the invoice's editors, M3 Steps 7–8). */
export interface CheckedLines {
  readonly errors: LinesErrors
  /** The lines that read, as the API takes them (every line when nothing is wrong). */
  readonly fieldLines: NonNullable<QuotationFields['lines']>
  /** The discount on the whole document (null: none, or it can't be taken). */
  readonly discount: LineDiscount | null
  /** The total wanted, with VAT (null: none, or it can't be reached). */
  readonly roundTo: string | null
  readonly amounts: SaleAmounts | null
  readonly lineAmounts: ReadonlyMap<string, SaleLineAmounts>
  readonly rounding: Rounding | null
}

/**
 * Every problem of a document's lines, its discount and "Round the total", and their running amounts
 * (the domain's sale maths, as the API works them out): what a quotation and an invoice made from
 * scratch share.
 */
export function checkLines(
  draft: LinesDraft,
  context: Pick<QuotationFormContext, 'currency' | 'vatRegistered' | 'products'>,
): CheckedLines {
  const errors: LinesErrors = { lines: {} }
  // Each line on its own; the ones that read count in the running amounts.
  const fieldLines: NonNullable<QuotationFields['lines']> = []
  const counted: { id: string; input: SaleLineInput }[] = []
  for (const line of draft.lines) {
    const lineErrors: LineErrors = {}
    const product = line.productId ? context.products.get(line.productId) : undefined
    const title = line.title.trim()
    if (title === '' && !product)
      lineErrors.title = { key: 'documents.quotations.editor.errors.title' }
    else if (line.productId && !product) {
      lineErrors.title = { key: 'documents.quotations.editor.errors.productGone' }
    } else {
      lineErrors.title = tooLong(line.title, QUOTATION_LINE_TITLE_MAX_LENGTH)
    }
    lineErrors.area = tooLong(line.area ?? '', QUOTATION_AREA_MAX_LENGTH)
    lineErrors.details = tooLong(line.details, QUOTATION_LINE_DETAILS_MAX_LENGTH)
    lineErrors.note = tooLong(line.note, QUOTATION_LINE_NOTE_MAX_LENGTH)
    const qty = readQuantity(line.qty)
    if (!qty.ok) lineErrors.qty = qty.error
    const price = readAmount(line.price)
    if (!price.ok) lineErrors.price = price.error
    const discount = discountOf(line.discountKind, line.discount)
    if (discount && !discount.ok) lineErrors.discount = discount.error
    const clean = Object.values(lineErrors).every((error) => error === undefined)
    if (clean && qty.ok && price.ok && (!discount || discount.ok)) {
      const lineDiscount = asDiscount(line.discountKind, discount?.ok ? discount.value : '')
      const input: SaleLineInput = {
        kind: 'item',
        qty: qty.value as Quantity,
        unitPrice: price.value as Money,
        priceIncludesVat:
          context.vatRegistered && product !== undefined && product.priceIncludesVat,
        discount: lineDiscount,
        vatCategory: product
          ? product.vatCategory
          : context.vatRegistered
            ? line.vatCategory
            : 'standard',
      }
      if (saleError({ lines: [input], vatRegistered: context.vatRegistered }, context.currency)) {
        lineErrors.discount = { key: 'documents.quotations.editor.errors.discountOverLine' }
      } else {
        counted.push({ id: line.id, input })
        fieldLines.push({
          id: line.id,
          productId: product ? product.id : null,
          area: orNull(line.area ?? ''),
          description: title === '' ? null : title,
          details: orNull(line.details),
          note: orNull(line.note),
          qty: qty.value,
          unit: product ? null : line.unit === '' ? null : line.unit,
          unitPrice: price.value,
          priceIncludesVat: false,
          vatCategory: product || !context.vatRegistered ? 'standard' : line.vatCategory,
          discount: lineDiscount,
        })
      }
    }
    const shown = Object.fromEntries(
      Object.entries(lineErrors).filter(([, error]) => error !== undefined),
    ) as LineErrors
    if (Object.keys(shown).length > 0) errors.lines[line.id] = shown
  }

  // The discount on the whole quotation: off the lines by their net (D-220).
  const discountRead = discountOf(draft.discountKind, draft.discount)
  if (discountRead && !discountRead.ok) errors.discount = discountRead.error
  const documentDiscount: LineDiscount | null =
    discountRead && discountRead.ok ? asDiscount(draft.discountKind, discountRead.value) : null
  const inputs = counted.map((line) => line.input)
  const base: SaleInput = {
    lines: inputs,
    vatRegistered: context.vatRegistered,
    discount: documentDiscount,
  }
  const discountProblem =
    documentDiscount && inputs.length > 0 ? saleError(base, context.currency) : null
  if (discountProblem && discountProblem.line === undefined) {
    errors.discount = {
      key:
        DOCUMENT_DISCOUNT_ERRORS[discountProblem.code] ??
        'documents.quotations.editor.errors.discountOverLines',
    }
  }
  const counting: SaleInput = errors.discount ? { ...base, discount: null } : base

  // "Round the total": the total wanted, with VAT, reached by an adjustment before VAT (D-221).
  let roundTo: string | null = null
  let rounding: Rounding | null = null
  let amounts: SaleAmounts | null = null
  if (draft.roundTo.trim() !== '') {
    const read = readAmount(draft.roundTo, { positive: true, currency: context.currency })
    if (!read.ok) errors.roundTo = read.error
    else if (inputs.length === 0) {
      errors.roundTo = { key: 'documents.quotations.editor.errors.roundNothing' }
    } else {
      const problem = roundTheTotalError(counting, read.value as Money, context.currency)
      if (problem) {
        errors.roundTo = {
          key: ROUND_ERRORS[problem.code] ?? 'documents.quotations.editor.errors.roundUnreachable',
        }
      } else {
        const solved = solveRoundAmount(counting, read.value as Money, context.currency)
        roundTo = read.value
        amounts = solved.sale
        rounding = {
          wanted: read.value,
          adjustment: solved.adjustment,
          difference: solved.roundingDifference,
        }
      }
    }
  }
  if (amounts === null && inputs.length > 0 && saleError(counting, context.currency) === null) {
    amounts = computeSale(counting, context.currency)
  }
  const lineAmounts = new Map(
    amounts ? counted.map((line, index) => [line.id, amounts.lines[index]!] as const) : [],
  )
  return {
    errors,
    fieldLines,
    discount: errors.discount ? null : documentDiscount,
    roundTo,
    amounts,
    lineAmounts,
    rounding,
  }
}

/** Every problem of the quotation, its running amounts, and the fields to send when there is none. */
export function checkQuotation(
  draft: QuotationDraft,
  context: QuotationFormContext,
): CheckedQuotation {
  const checked = checkLines(draft, context)
  const { fieldLines, amounts, lineAmounts, rounding, roundTo } = checked
  const errors: QuotationErrors = { ...checked.errors, stageRows: {} }
  if (!draft.customer) errors.customer = { key: 'documents.quotations.editor.errors.customer' }
  if (!BUSINESS_DAY.test(draft.businessDate)) {
    errors.businessDate = { key: 'documents.quotations.editor.errors.date' }
  } else if (draft.businessDate > context.today) {
    errors.businessDate = { key: 'errors.future_date' }
  }
  const validUntil = draft.validUntil.trim()
  if (validUntil !== '') {
    if (!BUSINESS_DAY.test(validUntil)) {
      errors.validUntil = { key: 'documents.quotations.editor.errors.date' }
    } else if (BUSINESS_DAY.test(draft.businessDate) && validUntil < draft.businessDate) {
      errors.validUntil = { key: 'documents.quotations.editor.errors.validBefore' }
    }
  }
  errors.customerRef = tooLong(draft.customerRef, QUOTATION_CUSTOMER_REF_MAX_LENGTH)
  errors.site = tooLong(draft.site, QUOTATION_SITE_MAX_LENGTH)
  errors.greeting = tooLong(draft.greeting, QUOTATION_GREETING_MAX_LENGTH)
  errors.intro = tooLong(draft.intro, QUOTATION_INTRO_MAX_LENGTH)
  errors.terms = tooLong(draft.terms, QUOTATION_TERMS_MAX_LENGTH)
  errors.notes = tooLong(draft.notes, QUOTATION_NOTES_MAX_LENGTH)

  // Payment stages: each "when" and %, the % adding up to 100; their amounts share what is paid.
  const stages: QuotationFields['stages'] = []
  const percents: string[] = []
  for (const stage of draft.stages) {
    const stageErrors: StageErrors = {}
    stageErrors.label = tooLong(stage.label, PAYMENT_STAGE_LABEL_MAX_LENGTH)
    if (stage.due.trim() === '') stageErrors.due = { key: 'documents.quotations.editor.errors.due' }
    else stageErrors.due = tooLong(stage.due, PAYMENT_STAGE_DUE_MAX_LENGTH)
    const percent = readPercent(stage.percent)
    if (!percent.ok) stageErrors.percent = percent.error
    else if (percent.value === '0' || /^0(\.0+)?$/.test(percent.value)) {
      stageErrors.percent = { key: 'catalog.numbers.positive' }
    } else if (/\.\d{5,}$/.test(percent.value)) {
      stageErrors.percent = { key: 'catalog.numbers.tooManyDecimals' }
    } else percents.push(percent.value)
    const shown = Object.fromEntries(
      Object.entries(stageErrors).filter(([, error]) => error !== undefined),
    ) as StageErrors
    if (Object.keys(shown).length > 0) errors.stageRows[stage.key] = shown
    else
      stages.push({ label: orNull(stage.label), due: stage.due.trim(), percent: percents.at(-1)! })
  }
  if (draft.stages.length > PAYMENT_STAGES_MAX) {
    errors.stages = {
      key: 'documents.quotations.editor.errors.stagesTooMany',
      values: { count: PAYMENT_STAGES_MAX },
    }
  } else if (percents.length === draft.stages.length && draft.stages.length > 0) {
    const problem = paymentStagesError(percents as Percent[])
    if (problem?.code === 'not_100_percent') {
      errors.stages = { key: 'documents.quotations.editor.errors.stagesNot100' }
    } else if (problem) errors.stages = { key: 'documents.quotations.editor.errors.stagesInvalid' }
  }
  const stageAmounts = new Map<string, string>()
  if (!errors.stages && percents.length === draft.stages.length && draft.stages.length > 0) {
    const payable = (amounts?.payable ?? '0') as Money
    paymentStageAmounts(payable, percents as Percent[], context.currency).forEach((amount, i) =>
      stageAmounts.set(draft.stages[i]!.key, amount),
    )
  }

  const valid =
    Object.keys(errors.lines).length === 0 &&
    Object.keys(errors.stageRows).length === 0 &&
    fieldLines.length === draft.lines.length &&
    Object.entries(errors).every(
      ([key, value]) => key === 'lines' || key === 'stageRows' || value === undefined,
    )
  const fields: QuotationFields | null =
    valid && draft.customer
      ? {
          customerId: draft.customer.id,
          locationId: draft.locationId,
          businessDate: draft.businessDate,
          // A new quotation left without a day: the business's usual validity (the API's default).
          ...(validUntil === '' && !context.saved ? {} : { validUntil: validUntil || null }),
          customerRef: orNull(draft.customerRef),
          site: orNull(draft.site),
          discount: checked.discount,
          roundTo,
          greeting: orNull(draft.greeting),
          intro: orNull(draft.intro),
          // A new quotation left without terms: the business's default terms (the API's).
          ...(draft.terms.trim() === '' && !context.saved ? {} : { terms: orNull(draft.terms) }),
          notes: orNull(draft.notes),
          lines: fieldLines,
          stages,
        }
      : null
  return { errors, fields, amounts, lineAmounts, rounding, stageAmounts }
}
