import {
  INVOICE_LPO_MAX_LENGTH,
  INVOICE_NOTES_MAX_LENGTH,
  INVOICE_TERMS_MAX_LENGTH,
  QUOTATION_SITE_MAX_LENGTH,
  type CreateInvoiceInput,
  type CustomerPickItemDto,
  type InvoiceDto,
  type ProductDto,
  type UpdateInvoiceInput,
} from '@bizcost/contracts'
import type { CurrencyCode, SaleAmounts, SaleLineAmounts } from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import type { FieldError } from '../catalog/numbers'
import { discountDraft, type DiscountKind } from '../documents/lines'
import {
  checkLines,
  newQuotationLine,
  type LineErrors,
  type QuotationLineDraft,
  type Rounding,
} from '../quotations/quotation-draft'

// An invoice as its editor holds it (M3 Step 8; Q3, Q22, Q26): made from scratch, its customer, lines
// (a product or service picked by name, or typed, with an area, details, a red note and a picture, as
// a quotation's, Q21), a discount on the whole invoice and "Round the total" (D-221, worked out here
// as the API works them out); made from a quotation, an order or a sale, its lines and customer are
// the source's and only its header changes. The header: the date of supply (on or before today; empty
// is the issue date), the due date, the customer's LPO, the channel its sale posts on (when the business
// has several and the invoice counts), the answer to "already in your recorded sales?" (required when
// asked, never preselected), the terms and notes.

export interface InvoiceDraft {
  /** From scratch: the customer (a sourced draft keeps its source's). */
  readonly customer: CustomerPickItemDto | null
  /** null: the default branch (a draft keeps its own). */
  readonly locationId: string | null
  /** '' : none chosen (the business's only channel, or the source's). */
  readonly channelId: string
  /** '' : the issue date. */
  readonly supplyDate: string
  readonly dueDate: string
  readonly lpoReference: string
  /** The project or site (a quotation's, copied; or typed). */
  readonly site: string
  /** "Is this sale already in your recorded sales?": never preselected ('' : not answered). */
  readonly countedElsewhere: '' | 'yes' | 'no'
  readonly terms: string
  readonly notes: string
  /** From scratch only. */
  readonly lines: readonly QuotationLineDraft[]
  readonly discountKind: DiscountKind
  readonly discount: string
  readonly roundTo: string
}

export interface InvoiceErrors {
  customer?: FieldError
  supplyDate?: FieldError
  dueDate?: FieldError
  lpoReference?: FieldError
  site?: FieldError
  terms?: FieldError
  notes?: FieldError
  countedElsewhere?: FieldError
  channel?: FieldError
  discount?: FieldError
  roundTo?: FieldError
  lines: Record<string, LineErrors>
}

/** invoice.create's fields (without the id); invoice.update takes them with the id and version. */
export type InvoiceFields = Omit<CreateInvoiceInput, 'id'>
/** What a sourced draft's save sends (its header; never its customer or lines). */
export type InvoiceHeaderFields = Omit<UpdateInvoiceInput, 'id' | 'version'>

export interface InvoiceFormContext {
  readonly currency: CurrencyCode
  readonly vatRegistered: boolean
  /** Today in the business's time zone (a later date of supply cannot be saved). */
  readonly today: string
  readonly products: ReadonlyMap<string, ProductDto>
  /** Made from a quotation, an order or a sale: only its header is sent. */
  readonly sourced: boolean
  /** It asks "already in your recorded sales?" (the API says so once the draft is saved). */
  readonly asks: boolean
  /** A channel must be chosen: the business has several active ones and the invoice's sale posts. */
  readonly needsChannel: boolean
}

export interface CheckedInvoice {
  readonly errors: InvoiceErrors
  /** What to save; null while something must be fixed. */
  readonly fields: InvoiceFields | InvoiceHeaderFields | null
  readonly amounts: SaleAmounts | null
  readonly lineAmounts: ReadonlyMap<string, SaleLineAmounts>
  readonly rounding: Rounding | null
}

/** Problems that only say something is missing: shown once the person tries to save. */
export const INVOICE_MISSING: ReadonlySet<I18nKey> = new Set<I18nKey>([
  'catalog.numbers.required',
  'documents.invoices.editor.errors.customer',
  'documents.quotations.editor.errors.title',
  'documents.invoices.editor.errors.channel',
])

/** A new invoice with one empty line; or a saved draft as it is stored. */
export function invoiceDraft(
  invoice: InvoiceDto | undefined,
  defaults: { locationId: string | null },
): InvoiceDraft {
  if (!invoice) {
    return {
      customer: null,
      locationId: defaults.locationId,
      channelId: '',
      supplyDate: '',
      dueDate: '',
      lpoReference: '',
      site: '',
      countedElsewhere: '',
      terms: '',
      notes: '',
      lines: [newQuotationLine()],
      discountKind: 'none',
      discount: '',
      roundTo: '',
    }
  }
  return {
    customer: {
      id: invoice.customerId,
      name: invoice.customer.name,
      kind: invoice.customer.kind ?? 'individual',
      phone: null,
      phoneLast4: invoice.customerPhoneLast4,
      archived: false,
    },
    locationId: invoice.locationId,
    channelId: invoice.channelId ?? '',
    supplyDate: invoice.supplyDate ?? '',
    dueDate: invoice.dueDate ?? '',
    lpoReference: invoice.lpoReference ?? '',
    site: invoice.site ?? '',
    countedElsewhere:
      invoice.countedElsewhere === null ? '' : invoice.countedElsewhere ? 'yes' : 'no',
    terms: invoice.terms ?? '',
    notes: invoice.notes ?? '',
    lines: invoice.lines
      .filter((line) => line.kind === 'item')
      .map((line) => ({
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
    ...discountDraft(invoice.discount),
    roundTo: invoice.roundTo ?? '',
  }
}

/** Whether an invoice is made from scratch (its lines and customer are its own). */
export function isScratch(invoice: Pick<InvoiceDto, 'quotationId' | 'orderId' | 'saleId'>) {
  return invoice.quotationId === null && invoice.orderId === null && invoice.saleId === null
}

const BUSINESS_DAY = /^\d{4}-\d{2}-\d{2}$/

function tooLong(value: string, max: number): FieldError | undefined {
  return value.trim().length > max
    ? { key: 'documents.quotations.editor.errors.tooLong', values: { count: max } }
    : undefined
}

const orNull = (value: string) => (value.trim() === '' ? null : value.trim())

/** Every problem of the draft, its running amounts (from scratch), and the fields to save. */
export function checkInvoice(draft: InvoiceDraft, context: InvoiceFormContext): CheckedInvoice {
  const lines = context.sourced
    ? null
    : checkLines(draft, {
        currency: context.currency,
        vatRegistered: context.vatRegistered,
        products: context.products,
      })
  const errors: InvoiceErrors = lines ? { ...lines.errors } : { lines: {} }
  if (!context.sourced && !draft.customer) {
    errors.customer = { key: 'documents.invoices.editor.errors.customer' }
  }
  const supplyDate = draft.supplyDate.trim()
  if (supplyDate !== '') {
    if (!BUSINESS_DAY.test(supplyDate)) {
      errors.supplyDate = { key: 'documents.invoices.editor.errors.date' }
    } else if (supplyDate > context.today) errors.supplyDate = { key: 'errors.future_date' }
  }
  const dueDate = draft.dueDate.trim()
  if (dueDate !== '') {
    if (!BUSINESS_DAY.test(dueDate)) {
      errors.dueDate = { key: 'documents.invoices.editor.errors.date' }
    } else if (dueDate < (supplyDate !== '' ? supplyDate : context.today)) {
      errors.dueDate = { key: 'documents.invoices.editor.errors.dueBefore' }
    }
  }
  errors.lpoReference = tooLong(draft.lpoReference, INVOICE_LPO_MAX_LENGTH)
  errors.site = tooLong(draft.site, QUOTATION_SITE_MAX_LENGTH)
  errors.terms = tooLong(draft.terms, INVOICE_TERMS_MAX_LENGTH)
  errors.notes = tooLong(draft.notes, INVOICE_NOTES_MAX_LENGTH)
  if (context.needsChannel && draft.channelId === '') {
    errors.channel = { key: 'documents.invoices.editor.errors.channel' }
  }

  const header: InvoiceHeaderFields = {
    locationId: draft.locationId,
    channelId: draft.channelId === '' ? null : draft.channelId,
    supplyDate: supplyDate === '' ? null : supplyDate,
    dueDate: dueDate === '' ? null : dueDate,
    lpoReference: orNull(draft.lpoReference),
    site: orNull(draft.site),
    // Saved as answered; "issue" asks it again when it is still needed.
    countedElsewhere:
      context.asks && draft.countedElsewhere !== '' ? draft.countedElsewhere === 'yes' : null,
    terms: orNull(draft.terms),
    notes: orNull(draft.notes),
  }
  const valid =
    Object.keys(errors.lines).length === 0 &&
    Object.entries(errors).every(([key, value]) => key === 'lines' || value === undefined) &&
    (lines === null || lines.fieldLines.length === draft.lines.length)
  let fields: InvoiceFields | InvoiceHeaderFields | null = null
  if (valid) {
    fields =
      lines === null
        ? header
        : {
            ...header,
            customerId: draft.customer!.id,
            discount: lines.discount,
            roundTo: lines.roundTo,
            lines: lines.fieldLines,
          }
  }
  return {
    errors,
    fields,
    amounts: lines?.amounts ?? null,
    lineAmounts: lines?.lineAmounts ?? new Map(),
    rounding: lines?.rounding ?? null,
  }
}
