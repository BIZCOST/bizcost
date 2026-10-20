import { hasVisibleCharacter } from '@bizcost/contracts'
import {
  compareDecimal,
  DOCUMENT_ACCENTS,
  isDocumentAccent,
  printedSubtotal,
  subtractDecimals,
  sumDecimals,
  type CreditReason,
  type CurrencyCode,
  type DocumentAccent,
  type Emirate,
  type Money,
  type Percent,
  type StandardUnit,
  type VatCategory,
} from '@bizcost/domain'
import { resources, type Messages } from '@bizcost/i18n'
import type {
  Bilingual,
  DocumentPdfImage,
  DocumentPdfInput,
  DocumentPdfLine,
  DocumentPdfReference,
  DocumentPdfStage,
  DocumentPdfStatementEntry,
  DocumentPdfTotalRow,
  TypedText,
} from './input'

// Builds a quotation's DocumentPdfInput (M3 Step 7; D-224) from its frozen values and the business's
// own details: the letterhead from the business's names, logo, accent, contact lines and signature
// (the owner's «بحسب اسم ومعلومات كل شركة»), the labels in both languages from the `documents.pdf`
// messages, every amount formatted here (Latin digits, grouped; whole amounts without ".00" only when
// the business asked for it). Pure: no database, no Storage. The images it names were read and checked
// by the caller (images.ts).

/** What a quotation PDF needs of the business (its settings and contact lines). */
export interface PdfBusiness {
  readonly legalName: string
  readonly legalNameAr: string | null
  readonly locale: 'en' | 'ar'
  readonly vatRegistered: boolean
  readonly trn: string | null
  readonly phone: string | null
  readonly phone2: string | null
  readonly email: string | null
  readonly addressLine: string | null
  readonly city: string | null
  readonly emirate: Emirate | null
  readonly tradeLicenceNo: string | null
  readonly accent: DocumentAccent | string
  readonly watermark: boolean
  readonly wholeAmounts: boolean
  readonly signatory: string | null
  readonly footer: string | null
}

export interface PdfQuotationLine {
  readonly area: string | null
  readonly title: string
  readonly details: string | null
  readonly note: string | null
  readonly qty: string
  readonly unit: StandardUnit | null
  readonly unitPrice: string
  readonly subtotal: string
  /** Its own discount, as an amount. */
  readonly lineDiscount: string
  /** Whether its price was typed with VAT (its amounts then include VAT). */
  readonly priceIncludesVat: boolean
  readonly vatCategory: VatCategory | null
  readonly vatRate: string | null
  /** Its picture's image key, when the caller mapped one. */
  readonly picture: string | null
}

export interface PdfQuotation {
  readonly number: string
  readonly revision: number
  readonly draft: boolean
  readonly businessDate: string
  readonly validUntil: string | null
  readonly customerRef: string | null
  readonly site: string | null
  readonly currency: string
  readonly vatRegistered: boolean
  readonly subtotal: string
  readonly discountTotal: string
  readonly adjustment: string
  readonly roundingDifference: string
  readonly netTotal: string
  readonly vatTotal: string
  readonly total: string
  readonly payable: string
  readonly vatRates: readonly {
    readonly vatCategory: VatCategory | null
    readonly vatRate: string | null
    readonly net: string
    readonly vat: string
  }[]
  /** The greeting typed on it; null: the default of the business's language. */
  readonly greeting: string | null
  readonly intro: string | null
  readonly terms: string | null
  readonly notes: string | null
  /** When it was sent (a draft: when it was last saved): the PDF's own date. */
  readonly issuedAt: Date
  readonly lines: readonly PdfQuotationLine[]
  readonly stages: readonly {
    readonly label: string | null
    readonly due: string
    readonly percent: string
    readonly amount: string
  }[]
}

export interface PdfCustomer {
  readonly name: string
  readonly phone: string | null
  readonly trn: string | null
  readonly addressLine: string | null
  readonly city: string | null
  readonly emirate: Emirate | null
  /** The project or site the work is for (an invoice made from a quotation, or typed on it). */
  readonly site?: string | null
}

/** The image keys of the business's own images the caller mapped (null: none). */
export interface PdfBusinessImages {
  readonly logo: string | null
  readonly signature: string | null
  readonly stamp: string | null
}

// ---------------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------------

const STRONG_RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u
const STRONG_LTR = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/u

/** The direction of a text's first strong character (`fallback` when it has none). */
export function firstStrongDir(text: string, fallback: 'ltr' | 'rtl'): 'ltr' | 'rtl' {
  for (const char of text) {
    if (STRONG_RTL.test(char)) return 'rtl'
    if (STRONG_LTR.test(char)) return 'ltr'
  }
  return fallback
}

/** Spaces a line may not break at (no-break, figure and narrow no-break spaces), made plain ones. */
const NO_BREAK_SPACES = /[\u00A0\u2007\u202F]/g
/** Zero-width characters that only forbid a break (word joiner, zero-width no-break space). */
const BREAK_FORBIDDERS = /[\u2060\uFEFF]/g
const ZERO_WIDTH_SPACE = '\u200B'
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * Text as typed, made to fit its cell (D-295): spaces that forbid a break become plain ones, and a run
 * of more than `maxRun` letters with no space in it (a long code, an address, or text made to run out
 * of its cell) gets a zero-width break point every `maxRun` letters, so it wraps inside its cell instead
 * of running over the next one. Text that fits is printed exactly as typed.
 */
export function breakable(value: string, maxRun: number): string {
  const plain = value.replace(NO_BREAK_SPACES, ' ').replace(BREAK_FORBIDDERS, '')
  return plain
    .split(/(\s+)/)
    .map((part) => {
      if (/^\s*$/.test(part) || part.length <= maxRun) return part
      const letters = [...graphemes.segment(part)].map((g) => g.segment)
      if (letters.length <= maxRun) return part
      const pieces: string[] = []
      for (let i = 0; i < letters.length; i += maxRun)
        pieces.push(letters.slice(i, i + maxRun).join(''))
      return pieces.join(ZERO_WIDTH_SPACE)
    })
    .join('')
}

/**
 * The longest run of letters with no break point each kind of text keeps, from the narrowest cell it
 * prints in and the widest letters (a run of "W" in bold): a line's title, details and note in the
 * description column (narrowed by a picture, an area, a discount and VAT), a payment stage's name and
 * time, the customer's name, project and address, a reference, the letterhead's email and address, the
 * terms, notes and bank details, and the signatory and names under the signatures. The description and
 * the payment stages sit beside number columns that grow with the amounts: the template measures those
 * cells and breaks a run again where it is wider than its cell (document.typ `fit`, D-295), so these
 * lengths only keep its work small.
 */
const RUN = {
  title: 20,
  details: 24,
  area: 16,
  stage: 12,
  customer: 20,
  reference: 16,
  contact: 40,
  closing: 32,
  sentence: 48,
  name: 36,
} as const

function typedText(
  value: string | null,
  fallback: 'ltr' | 'rtl',
  maxRun: number = RUN.sentence,
): TypedText | null {
  if (value === null || value.trim() === '') return null
  const text = breakable(value, maxRun)
  return { text, dir: firstStrongDir(text, fallback) }
}

/** The `documents` messages of a language. */
function messagesOf(locale: 'en' | 'ar'): Messages {
  return resources[locale].documents
}

function pick(messages: Messages, path: string): string {
  let node: Messages | string | undefined = messages
  for (const part of path.split('.')) {
    if (typeof node !== 'object') break
    node = node[part]
  }
  if (typeof node !== 'string') throw new Error(`documents.${path} is missing`)
  return node
}

function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match)
}

/** A message of `documents` in both languages, filled in. */
function both(path: string, values: Readonly<Record<string, string>> = {}): Bilingual {
  return {
    en: fill(pick(messagesOf('en'), path), values),
    ar: fill(pick(messagesOf('ar'), path), values),
  }
}

/** Every `documents.pdf` label the template looks up by key (L("table.no")…), both languages. */
function labelsOf(): Record<string, Bilingual> {
  const out: Record<string, Bilingual> = {}
  const walk = (node: Messages, prefix: string) => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key
      if (typeof value === 'string') out[path] = both(`pdf.${path}`)
      else walk(value, path)
    }
  }
  walk(messagesOf('en').pdf as Messages, '')
  return out
}

let labels: Record<string, Bilingual> | null = null

// ---------------------------------------------------------------------------------------------------
// Numbers and dates (Latin digits, as every BizCost document)
// ---------------------------------------------------------------------------------------------------

/** "1234567.5" → "1,234,567.5" (the digits as given; a minus kept). */
function grouped(value: string): string {
  const negative = value.startsWith('-')
  const [whole = '0', fraction] = (negative ? value.slice(1) : value).split('.')
  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}${groupedWhole}${fraction === undefined ? '' : `.${fraction}`}`
}

/**
 * An amount with exactly `digits` decimals ("16100.5" → "16,100.50"), or with none when it has no
 * fraction and `whole` (the business's setting) is on. Amounts are stored rounded to the currency.
 */
export function formatAmount(value: string, digits: number, whole: boolean): string {
  const negative = value.startsWith('-')
  const [intPart = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.')
  const trimmed = fraction.replace(/0+$/, '')
  if (whole && trimmed === '') return grouped(`${negative ? '-' : ''}${intPart}`)
  const padded = (trimmed + '0'.repeat(digits)).slice(0, Math.max(digits, trimmed.length))
  return grouped(`${negative ? '-' : ''}${intPart}${padded ? `.${padded}` : ''}`)
}

/** A quantity as stored ("12.500000" → "12.5"), grouped. */
export function formatQuantity(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.')
  const trimmed = fraction.replace(/0+$/, '')
  return grouped(trimmed ? `${whole}.${trimmed}` : whole)
}

/** A percentage ("50.000000" → "50%"). */
export function formatPercent(value: string): string {
  return `${formatQuantity(value)}%`
}

const MONTHS_EN = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]
const MONTHS_AR = [
  'يناير',
  'فبراير',
  'مارس',
  'أبريل',
  'مايو',
  'يونيو',
  'يوليو',
  'أغسطس',
  'سبتمبر',
  'أكتوبر',
  'نوفمبر',
  'ديسمبر',
]

/** "2026-10-08" → 8 October 2026 · 8 أكتوبر 2026 (Latin digits in both). */
export function formatDate(day: string): Bilingual {
  const [year = '', month = '1', date = '1'] = day.split('-')
  const index = Number(month) - 1
  const d = String(Number(date))
  return { en: `${d} ${MONTHS_EN[index]} ${year}`, ar: `${d} ${MONTHS_AR[index]} ${year}` }
}

/** The minor-unit digits of a currency (AED 2, KWD 3). */
const CURRENCY_DIGITS: Readonly<Record<string, number>> = {
  KWD: 3,
  BHD: 3,
  OMR: 3,
}

// ---------------------------------------------------------------------------------------------------
// The quotation's input
// ---------------------------------------------------------------------------------------------------

/**
 * One address line as the documents print it: "Office 12, Al Quoz, Dubai", the emirate's name and the
 * comma in the language the address is written in (a Latin address keeps English names), else the
 * business's. Settings → Documents previews the same line (D-297).
 */
export function addressOf(
  line: string | null,
  city: string | null,
  emirate: Emirate | null,
  locale: 'en' | 'ar',
): string | null {
  // The emirate in the language the address is written in (a Latin address keeps English names).
  const written = firstStrongDir(
    [line, city].filter(Boolean).join(' '),
    locale === 'ar' ? 'rtl' : 'ltr',
  )
  const language = written === 'rtl' ? 'ar' : 'en'
  const emirateName = emirate ? pick(messagesOf(language), `emirates.${emirate}`) : null
  // A city that is the emirate's own name ("Sharjah, Sharjah") is said once.
  const sameAsCity =
    emirateName !== null &&
    city !== null &&
    city.trim().toLocaleLowerCase() === emirateName.toLocaleLowerCase()
  const parts = [line, city, sameAsCity ? null : emirateName]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part !== '')
  if (parts.length === 0) return null
  return parts.join(language === 'ar' ? '، ' : ', ')
}

/**
 * The DocumentPdfInput of a quotation revision: `images` are the files the caller mapped (their keys
 * are those named in `pictures`, `business`'s logo, signature and stamp).
 */
export function buildQuotationPdfInput(source: {
  readonly business: PdfBusiness
  readonly quotation: PdfQuotation
  readonly customer: PdfCustomer
  readonly businessImages: PdfBusinessImages
  readonly images: Readonly<Record<string, DocumentPdfImage>>
}): DocumentPdfInput {
  const { business, quotation: q, customer } = source
  const locale = business.locale
  const fallback = locale === 'ar' ? 'rtl' : 'ltr'
  const digits = CURRENCY_DIGITS[q.currency] ?? 2
  const money = (value: string) => formatAmount(value, digits, business.wholeAmounts)
  const zero = (value: string) => compareDecimal(value, '0') === 0
  labels ??= labelsOf()
  const images = source.images
  const known = (key: string | null) => (key !== null && key in images ? key : null)

  // A taxed line whose price was typed with VAT: its amount includes VAT (marked on its row).
  const includesVat = (line: PdfQuotationLine) =>
    q.vatRegistered &&
    line.priceIncludesVat &&
    line.vatRate !== null &&
    compareDecimal(line.vatRate, '0') > 0
  const lines: DocumentPdfLine[] = q.lines.map((line, i) => ({
    no: i + 1,
    // A name with nothing to see (stored before the API refused one, D-299) prints as no area.
    area:
      line.area !== null && hasVisibleCharacter(line.area)
        ? typedText(line.area, fallback, RUN.area)
        : null,
    picture: known(line.picture),
    title: typedText(line.title, fallback, RUN.title) ?? { text: line.title, dir: fallback },
    details: typedText(line.details, fallback, RUN.details),
    note: typedText(line.note, fallback, RUN.details),
    qty: formatQuantity(line.qty),
    unit: line.unit ? pick(messagesOf(locale), `pdf.unit.${line.unit}`) : null,
    unitPrice: money(line.unitPrice),
    discount: zero(line.lineDiscount) ? null : money(line.lineDiscount),
    vatRate: null,
    amount: money(subtractDecimals(line.subtotal, line.lineDiscount)),
    includesVat: includesVat(line),
  }))

  // Totals: what the table adds up to, the quotation's discount, the rounding adjustment, VAT per
  // rate (VAT-registered only), the total, and any rounding difference with the amount to pay. The
  // subtotal and the discount are in one basis with the total before VAT (before VAT when a taxed
  // price includes VAT), so the rows add up as printed (D-296).
  const lineDiscounts = sumDecimals(q.lines.map((line) => line.lineDiscount))
  const printed = printedSubtotal(
    q.lines.map((line) => ({
      amount: subtractDecimals(line.subtotal, line.lineDiscount) as Money,
      priceIncludesVat: includesVat(line),
      vatRate: line.vatRate as Percent | null,
    })),
    {
      documentDiscount: subtractDecimals(q.discountTotal, lineDiscounts) as Money,
      net: q.netTotal as Money,
      adjustment: q.adjustment as Money,
    },
    q.currency as CurrencyCode,
  )
  const rows: DocumentPdfTotalRow[] = []
  const hasDiscount = !zero(printed.discount)
  const hasAdjustment = !zero(q.adjustment)
  const hasDifference = !zero(q.roundingDifference)
  // The subtotal only when something comes off it (else it is the total before VAT, said once).
  if (hasDiscount || hasAdjustment) {
    rows.push({
      label: both('pdf.totals.subtotal'),
      amount: money(printed.subtotal),
      strong: false,
    })
  }
  if (hasDiscount) {
    rows.push({
      label: both('pdf.totals.discount'),
      amount: money(subtractDecimals('0', printed.discount)),
      strong: false,
    })
  }
  if (hasAdjustment) {
    rows.push({ label: both('pdf.totals.adjustment'), amount: money(q.adjustment), strong: false })
  }
  if (q.vatRegistered) {
    rows.push({ label: both('pdf.totals.net'), amount: money(q.netTotal), strong: false })
    for (const rate of q.vatRates) {
      const taxable = money(rate.net)
      const label =
        rate.vatCategory === 'exempt'
          ? both('pdf.totals.exempt', { taxable })
          : rate.vatCategory === 'zero_rated'
            ? both('pdf.totals.zeroRated', { taxable })
            : both('pdf.totals.vatRate', {
                rate: formatQuantity(rate.vatRate ?? '0'),
                taxable,
              })
      rows.push({ label, amount: money(rate.vat), strong: false })
    }
  }
  rows.push({ label: both('pdf.totals.total'), amount: money(q.total), strong: !hasDifference })
  if (hasDifference) {
    rows.push({
      label: both('pdf.totals.roundingDifference'),
      amount: money(q.roundingDifference),
      strong: false,
    })
    rows.push({ label: both('pdf.totals.payable'), amount: money(q.payable), strong: true })
  }

  const stages: DocumentPdfStage[] = q.stages.map((stage, i) => ({
    label:
      typedText(stage.label, fallback, RUN.stage) ?? both('pdf.stages.label', { n: String(i + 1) }),
    due: typedText(stage.due, fallback, RUN.stage) ?? { text: stage.due, dir: fallback },
    percent: formatPercent(stage.percent),
    amount: money(stage.amount),
  }))

  const site = q.site?.trim() ? q.site.trim() : null
  const validUntil = q.validUntil ? formatDate(q.validUntil) : null
  const phones = [business.phone, business.phone2].filter((p): p is string => !!p?.trim())
  const accent = isDocumentAccent(business.accent)
    ? DOCUMENT_ACCENTS[business.accent]
    : DOCUMENT_ACCENTS.navy
  const issued = q.issuedAt
  return {
    kind: 'quotation',
    draft: q.draft,
    locale,
    issuedAt: {
      year: issued.getUTCFullYear(),
      month: issued.getUTCMonth() + 1,
      day: issued.getUTCDate(),
      hour: issued.getUTCHours(),
      minute: issued.getUTCMinutes(),
      second: issued.getUTCSeconds(),
    },
    labels,
    title: both('pdf.title.quotation'),
    number: q.number,
    revision: q.revision > 1 ? q.revision : null,
    date: formatDate(q.businessDate),
    validUntil,
    customerRef: q.customerRef === null ? null : breakable(q.customerRef, RUN.reference),
    currency: q.currency,
    letterhead: {
      nameEn: typedText(business.legalName, 'ltr', RUN.name),
      nameAr: typedText(business.legalNameAr, 'rtl', RUN.name),
      accent,
      logo: known(source.businessImages.logo),
      watermark: business.watermark && known(source.businessImages.logo) !== null,
      phones,
      email: business.email?.trim() ? breakable(business.email.trim(), RUN.contact) : null,
      address: typedText(
        addressOf(business.addressLine, business.city, business.emirate, locale),
        fallback,
        RUN.contact,
      ),
      trn: business.vatRegistered ? business.trn : null,
      tradeLicence: business.tradeLicenceNo,
    },
    customer: {
      name: typedText(customer.name, fallback, RUN.customer) ?? {
        text: customer.name,
        dir: fallback,
      },
      site: typedText(site, fallback, RUN.customer),
      phone: customer.phone,
      trn: customer.trn,
      address: typedText(
        addressOf(customer.addressLine, customer.city, customer.emirate, locale),
        fallback,
        RUN.customer,
      ),
    },
    opening: {
      greeting: typedText(q.greeting, fallback),
      intro: typedText(q.intro, fallback) ?? both('pdf.intro'),
      // Dirhams by their name, as the owner's letterhead says them; another currency by its code.
      amountsIn:
        q.currency === 'AED'
          ? both('pdf.amountsInAed')
          : both('pdf.amountsIn', { currency: q.currency }),
    },
    table: {
      showPictures: lines.some((line) => line.picture !== null),
      showAreas: lines.some((line) => line.area !== null),
      showDiscount: lines.some((line) => line.discount !== null),
      showVat: false,
    },
    lines,
    totals: rows,
    stages,
    validity: validUntil
      ? {
          en: fill(pick(messagesOf('en'), 'pdf.validity'), { date: validUntil.en }),
          ar: fill(pick(messagesOf('ar'), 'pdf.validity'), { date: validUntil.ar }),
        }
      : null,
    terms: typedText(q.terms, fallback, RUN.closing),
    notes: typedText(q.notes, fallback, RUN.closing),
    paymentDetails: typedText(business.footer, fallback, RUN.closing),
    signature: {
      signatory: typedText(business.signatory, fallback, RUN.name),
      signature: known(source.businessImages.signature),
      stamp: known(source.businessImages.stamp),
      acceptance: true,
    },
    images,
  }
}

// ---------------------------------------------------------------------------------------------------
// Invoices, credit notes and statements (M3 Step 8): the same letterhead and frame as a quotation
// ---------------------------------------------------------------------------------------------------

/** A line of an invoice as its PDF prints it. */
export interface PdfInvoiceLine extends PdfQuotationLine {
  /** `deduction`: a deposit invoice taken off (its amount negative). */
  readonly kind: 'item' | 'delivery' | 'deduction'
}

/** A payment an invoice received, as printed beside its totals. */
export interface PdfPayment {
  readonly date: string
  /** How it was paid, or `paidWhenMade` (a sale paid at the time, invoiced after). */
  readonly method: 'cash' | 'card' | 'bank_transfer' | 'cheque' | 'paidWhenMade' | 'paidEarlier'
  readonly reference: string | null
  readonly amount: string
}

export interface PdfInvoice {
  readonly kind: 'tax_invoice' | 'invoice'
  /** Null on a draft (a number is taken at issue). */
  readonly number: string | null
  readonly draft: boolean
  /** The issue date (a draft: today). */
  readonly issueDate: string
  /** The date of supply: printed when it is not the issue date (ER Art. 59(1)(f)). */
  readonly supplyDate: string
  readonly dueDate: string | null
  readonly lpo: string | null
  readonly quotationNumber: string | null
  readonly orderNumber: string | null
  readonly currency: string
  readonly vatRegistered: boolean
  readonly subtotal: string
  readonly discountTotal: string
  readonly adjustment: string
  readonly roundingDifference: string
  readonly netTotal: string
  readonly vatTotal: string
  readonly total: string
  readonly payable: string
  readonly vatRates: PdfQuotation['vatRates']
  readonly terms: string | null
  readonly notes: string | null
  /** Its issue time (a draft: when it was last saved): the PDF's own date. */
  readonly issuedAt: Date
  readonly lines: readonly PdfInvoiceLine[]
  /** The payments it had received when issued (a draft: so far). */
  readonly payments: readonly PdfPayment[]
}

/** The customer as a tax document prints it (its TRN only on a tax document, ER Art. 59(1)(c)). */
export interface PdfInvoiceCustomer extends PdfCustomer {
  readonly showTrn: boolean
}

function issuedAtOf(issued: Date): DocumentPdfInput['issuedAt'] {
  return {
    year: issued.getUTCFullYear(),
    month: issued.getUTCMonth() + 1,
    day: issued.getUTCDate(),
    hour: issued.getUTCHours(),
    minute: issued.getUTCMinutes(),
    second: issued.getUTCSeconds(),
  }
}

/** The letterhead of a business's document (its own names, logo, accent and contact lines, D-287). */
function letterheadOf(
  business: PdfBusiness,
  businessImages: PdfBusinessImages,
  images: Readonly<Record<string, DocumentPdfImage>>,
): DocumentPdfInput['letterhead'] {
  const fallback = business.locale === 'ar' ? 'rtl' : 'ltr'
  const known = (key: string | null) => (key !== null && key in images ? key : null)
  const accent = isDocumentAccent(business.accent)
    ? DOCUMENT_ACCENTS[business.accent]
    : DOCUMENT_ACCENTS.navy
  return {
    nameEn: typedText(business.legalName, 'ltr', RUN.name),
    nameAr: typedText(business.legalNameAr, 'rtl', RUN.name),
    accent,
    logo: known(businessImages.logo),
    watermark: business.watermark && known(businessImages.logo) !== null,
    phones: [business.phone, business.phone2].filter((p): p is string => !!p?.trim()),
    email: business.email?.trim() ? breakable(business.email.trim(), RUN.contact) : null,
    address: typedText(
      addressOf(business.addressLine, business.city, business.emirate, business.locale),
      fallback,
      RUN.contact,
    ),
    trn: business.vatRegistered ? business.trn : null,
    tradeLicence: business.tradeLicenceNo,
  }
}

function partyOf(customer: PdfCustomer, showTrn: boolean, locale: 'en' | 'ar') {
  const fallback = locale === 'ar' ? 'rtl' : 'ltr'
  return {
    name: typedText(customer.name, fallback, RUN.customer) ?? {
      text: customer.name,
      dir: fallback,
    },
    site: typedText(customer.site ?? null, fallback, RUN.customer),
    phone: customer.phone,
    trn: showTrn ? customer.trn : null,
    address: typedText(
      addressOf(customer.addressLine, customer.city, customer.emirate, locale),
      fallback,
      RUN.customer,
    ),
  }
}

/** A line's VAT rate as its column prints it: "5%", "0%", "Exempt" (in the business's language). */
function vatRateText(
  locale: 'en' | 'ar',
  category: VatCategory | null,
  rate: string | null,
): string | null {
  if (category === null) return null
  if (category === 'exempt') return pick(messagesOf(locale), 'pdf.vatCategory.exempt')
  if (category === 'zero_rated') return pick(messagesOf(locale), 'pdf.vatCategory.zeroRated')
  return formatPercent(rate ?? '0')
}

/** The VAT rows of a document's totals: one per rate, its taxable amount named. */
function vatRows(
  rates: PdfQuotation['vatRates'],
  money: (value: string) => string,
  keys: { standard: string; zeroRated: string; exempt: string },
): DocumentPdfTotalRow[] {
  return rates.map((rate) => {
    const taxable = money(rate.net)
    const label =
      rate.vatCategory === 'exempt'
        ? both(keys.exempt, { taxable })
        : rate.vatCategory === 'zero_rated'
          ? both(keys.zeroRated, { taxable })
          : both(keys.standard, { rate: formatQuantity(rate.vatRate ?? '0'), taxable })
    return { label, amount: money(rate.vat), strong: false }
  })
}

/**
 * The DocumentPdfInput of an invoice (M3 Step 8): «فاتورة ضريبية · Tax Invoice» with the 12 particulars
 * of VAT ER Art. 59(1) (the seller's names, address and TRN; the recipient's when registered; its
 * number, issue date, date of supply when different, each line's unit price, quantity, VAT rate and
 * amount, any discount, the total and the VAT in AED), or a plain «فاتورة · Invoice» that says nothing of
 * tax (no TRN, no VAT column or rows). Its payments print beside its totals with what is still due.
 */
export function buildInvoicePdfInput(source: {
  readonly business: PdfBusiness
  readonly invoice: PdfInvoice
  readonly customer: PdfInvoiceCustomer
  readonly businessImages: PdfBusinessImages
  readonly images: Readonly<Record<string, DocumentPdfImage>>
}): DocumentPdfInput {
  const { business, invoice: inv, customer } = source
  const locale = business.locale
  const fallback = locale === 'ar' ? 'rtl' : 'ltr'
  const tax = inv.kind === 'tax_invoice'
  const digits = CURRENCY_DIGITS[inv.currency] ?? 2
  // A tax document always prints its fils (whole amounts only on other documents).
  const money = (value: string) => formatAmount(value, digits, business.wholeAmounts && !tax)
  const zero = (value: string) => compareDecimal(value, '0') === 0
  labels ??= labelsOf()
  const images = source.images
  const known = (key: string | null) => (key !== null && key in images ? key : null)
  const includesVat = (line: PdfQuotationLine) =>
    inv.vatRegistered &&
    line.priceIncludesVat &&
    line.vatRate !== null &&
    compareDecimal(line.vatRate, '0') > 0
  const lines: DocumentPdfLine[] = inv.lines.map((line, i) => ({
    no: i + 1,
    area:
      line.area !== null && hasVisibleCharacter(line.area)
        ? typedText(line.area, fallback, RUN.area)
        : null,
    picture: known(line.picture),
    title: typedText(line.title, fallback, RUN.title) ?? { text: line.title, dir: fallback },
    details: typedText(line.details, fallback, RUN.details),
    note: typedText(line.note, fallback, RUN.details),
    qty: formatQuantity(line.kind === 'deduction' ? '1' : line.qty),
    unit: line.unit ? pick(messagesOf(locale), `pdf.unit.${line.unit}`) : null,
    unitPrice: money(
      line.kind === 'deduction' ? subtractDecimals('0', line.unitPrice) : line.unitPrice,
    ),
    discount: zero(line.lineDiscount) ? null : money(line.lineDiscount),
    vatRate: tax ? vatRateText(locale, line.vatCategory, line.vatRate) : null,
    amount: money(subtractDecimals(line.subtotal, line.lineDiscount)),
    includesVat: includesVat(line),
  }))

  const lineDiscounts = sumDecimals(inv.lines.map((line) => line.lineDiscount))
  const printed = printedSubtotal(
    inv.lines.map((line) => ({
      amount: subtractDecimals(line.subtotal, line.lineDiscount) as Money,
      priceIncludesVat: includesVat(line),
      vatRate: line.vatRate as Percent | null,
    })),
    {
      documentDiscount: subtractDecimals(inv.discountTotal, lineDiscounts) as Money,
      net: inv.netTotal as Money,
      adjustment: inv.adjustment as Money,
    },
    inv.currency as CurrencyCode,
  )
  const rows: DocumentPdfTotalRow[] = []
  const hasDiscount = !zero(printed.discount)
  const hasAdjustment = !zero(inv.adjustment)
  const hasDifference = !zero(inv.roundingDifference)
  if (hasDiscount || hasAdjustment) {
    rows.push({
      label: both('pdf.totals.subtotal'),
      amount: money(printed.subtotal),
      strong: false,
    })
  }
  if (hasDiscount) {
    rows.push({
      label: both('pdf.totals.discount'),
      amount: money(subtractDecimals('0', printed.discount)),
      strong: false,
    })
  }
  if (hasAdjustment) {
    rows.push({
      label: both('pdf.totals.adjustment'),
      amount: money(inv.adjustment),
      strong: false,
    })
  }
  if (tax) {
    rows.push({ label: both('pdf.totals.net'), amount: money(inv.netTotal), strong: false })
    rows.push(
      ...vatRows(inv.vatRates, money, {
        standard: 'pdf.totals.vatRate',
        zeroRated: 'pdf.totals.zeroRated',
        exempt: 'pdf.totals.exempt',
      }),
    )
  }
  const paid = sumDecimals(inv.payments.map((p) => p.amount))
  const owesAfter = !zero(paid)
  rows.push({
    label: both('pdf.totals.total'),
    amount: money(inv.total),
    strong: !hasDifference && !owesAfter,
  })
  if (hasDifference) {
    rows.push({
      label: both('pdf.totals.roundingDifference'),
      amount: money(inv.roundingDifference),
      strong: false,
    })
    rows.push({
      label: both('pdf.totals.payable'),
      amount: money(inv.payable),
      strong: !owesAfter,
    })
  }
  if (owesAfter) {
    rows.push({
      label: both('pdf.totals.paid'),
      amount: money(subtractDecimals('0', paid)),
      strong: false,
    })
    const due = subtractDecimals(inv.payable, paid)
    rows.push({
      label: both('pdf.totals.balanceDue'),
      amount: money(compareDecimal(due, '0') < 0 ? '0' : due),
      strong: true,
    })
  }

  const references: DocumentPdfReference[] = []
  if (inv.supplyDate !== inv.issueDate) {
    references.push({ label: both('pdf.supplyDate'), value: formatDate(inv.supplyDate) })
  }
  if (inv.quotationNumber) {
    references.push({ label: both('pdf.references.quotation'), value: inv.quotationNumber })
  }
  if (inv.orderNumber) {
    references.push({ label: both('pdf.references.order'), value: inv.orderNumber })
  }
  if (tax) references.push({ label: both('pdf.currency'), value: inv.currency })

  return {
    kind: inv.kind,
    draft: inv.draft,
    locale,
    issuedAt: issuedAtOf(inv.issuedAt),
    labels,
    title: both(tax ? 'pdf.title.taxInvoice' : 'pdf.title.invoice'),
    number: inv.number ?? '—',
    revision: null,
    date: formatDate(inv.issueDate),
    validUntil: null,
    dueDate: inv.dueDate ? formatDate(inv.dueDate) : null,
    customerRef: inv.lpo === null ? null : breakable(inv.lpo, RUN.reference),
    references,
    currency: inv.currency,
    letterhead: letterheadOf(business, source.businessImages, images),
    customer: partyOf(customer, customer.showTrn && tax, locale),
    opening: null,
    table: {
      showPictures: lines.some((line) => line.picture !== null),
      showAreas: lines.some((line) => line.area !== null),
      showDiscount: lines.some((line) => line.discount !== null),
      showVat: tax,
    },
    lines,
    totals: rows,
    stages: [],
    payments: inv.payments.map((p) => ({
      // What its order or sale paid before it: no day of its own (its method says so).
      date: p.method === 'paidEarlier' ? null : formatDate(p.date),
      method: both(`pdf.method.${p.method}`),
      reference: p.reference === null ? null : breakable(p.reference, RUN.reference),
      amount: money(p.amount),
    })),
    validity: null,
    terms: typedText(inv.terms, fallback, RUN.closing),
    notes: typedText(inv.notes, fallback, RUN.closing),
    paymentDetails: typedText(business.footer, fallback, RUN.closing),
    signature: {
      signatory: typedText(business.signatory, fallback, RUN.name),
      signature: known(source.businessImages.signature),
      stamp: known(source.businessImages.stamp),
      acceptance: false,
    },
    images,
  }
}

export interface PdfCreditNote {
  readonly kind: 'tax_credit_note' | 'credit_note'
  readonly number: string | null
  readonly draft: boolean
  readonly issueDate: string
  readonly invoiceNumber: string
  readonly invoiceDate: string
  readonly reason: CreditReason
  readonly reasonText: string
  /** By quantity (goods returned) or by amount (a price cut: no quantity, its rows the amount only). */
  readonly by?: 'quantity' | 'amount'
  readonly currency: string
  readonly vatRegistered: boolean
  readonly netTotal: string
  readonly vatTotal: string
  readonly total: string
  readonly vatRates: PdfQuotation['vatRates']
  /** ER Art. 60(1)(e): the invoice's value of the supply (less earlier credit notes) and after it. */
  readonly valueBefore: string
  readonly valueAfter: string
  readonly notes: string | null
  readonly issuedAt: Date
  readonly lines: readonly {
    readonly title: string
    readonly qty: string
    readonly unit: StandardUnit | null
    readonly unitPrice: string
    readonly priceIncludesVat: boolean
    readonly vatCategory: VatCategory | null
    readonly vatRate: string | null
    readonly net: string
    readonly total: string
  }[]
}

/**
 * The DocumentPdfInput of a credit note (M3 Step 8): «إشعار دائن ضريبي · Tax Credit Note» with the
 * particulars of VAT ER Art. 60(1): the seller's and the recipient's names, addresses and TRNs, its
 * issue date, the invoice's value of the supply (after the credit notes before it), the correct value,
 * the difference and its VAT in AED, the reason, and the invoice it corrects (number and date); or a
 * plain «إشعار دائن · Credit Note» that says nothing of tax.
 */
export function buildCreditNotePdfInput(source: {
  readonly business: PdfBusiness
  readonly creditNote: PdfCreditNote
  readonly customer: PdfInvoiceCustomer
  readonly businessImages: PdfBusinessImages
  readonly images: Readonly<Record<string, DocumentPdfImage>>
}): DocumentPdfInput {
  const { business, creditNote: cn, customer } = source
  const locale = business.locale
  const fallback = locale === 'ar' ? 'rtl' : 'ltr'
  const tax = cn.kind === 'tax_credit_note'
  const digits = CURRENCY_DIGITS[cn.currency] ?? 2
  const money = (value: string) => formatAmount(value, digits, business.wholeAmounts && !tax)
  labels ??= labelsOf()
  const images = source.images
  const known = (key: string | null) => (key !== null && key in images ? key : null)
  const byAmount = cn.by === 'amount'
  const lines: DocumentPdfLine[] = cn.lines.map((line, i) => {
    const includesVat =
      cn.vatRegistered &&
      line.priceIncludesVat &&
      line.vatRate !== null &&
      compareDecimal(line.vatRate, '0') > 0
    return {
      no: i + 1,
      area: null,
      picture: null,
      title: typedText(line.title, fallback, RUN.title) ?? { text: line.title, dir: fallback },
      details: null,
      note: null,
      // By amount (a price cut) it takes back no quantity: no quantity, unit or unit price.
      qty: byAmount ? '—' : formatQuantity(line.qty),
      unit: byAmount || !line.unit ? null : pick(messagesOf(locale), `pdf.unit.${line.unit}`),
      unitPrice: byAmount ? '—' : money(line.unitPrice),
      discount: null,
      vatRate: tax ? vatRateText(locale, line.vatCategory, line.vatRate) : null,
      amount: money(includesVat ? line.total : line.net),
      includesVat,
    }
  })
  const rows: DocumentPdfTotalRow[] = [
    { label: both('pdf.credit.valueBefore'), amount: money(cn.valueBefore), strong: false },
    { label: both('pdf.credit.valueAfter'), amount: money(cn.valueAfter), strong: false },
    { label: both('pdf.credit.difference'), amount: money(cn.netTotal), strong: false },
  ]
  if (tax) {
    rows.push(
      ...vatRows(cn.vatRates, money, {
        standard: 'pdf.credit.vatOnDifference',
        zeroRated: 'pdf.credit.zeroRatedDifference',
        exempt: 'pdf.credit.exemptDifference',
      }),
    )
  }
  rows.push({ label: both('pdf.credit.total'), amount: money(cn.total), strong: true })
  const references: DocumentPdfReference[] = [
    { label: both('pdf.references.invoiceNo'), value: cn.invoiceNumber },
    { label: both('pdf.references.invoiceDate'), value: formatDate(cn.invoiceDate) },
  ]
  if (tax) references.push({ label: both('pdf.currency'), value: cn.currency })
  return {
    kind: cn.kind,
    draft: cn.draft,
    locale,
    issuedAt: issuedAtOf(cn.issuedAt),
    labels,
    title: both(tax ? 'pdf.title.taxCreditNote' : 'pdf.title.creditNote'),
    number: cn.number ?? '—',
    revision: null,
    date: formatDate(cn.issueDate),
    validUntil: null,
    dueDate: null,
    customerRef: null,
    references,
    currency: cn.currency,
    letterhead: letterheadOf(business, source.businessImages, images),
    customer: partyOf(customer, customer.showTrn && tax, locale),
    opening: null,
    table: { showPictures: false, showAreas: false, showDiscount: false, showVat: tax },
    lines,
    totals: rows,
    stages: [],
    payments: [],
    reason: {
      kind: both(`pdf.reasons.${cn.reason}`),
      text: typedText(cn.reasonText, fallback, RUN.closing) ?? {
        text: cn.reasonText,
        dir: fallback,
      },
    },
    validity: null,
    terms: null,
    notes: typedText(cn.notes, fallback, RUN.closing),
    paymentDetails: null,
    signature: {
      signatory: typedText(business.signatory, fallback, RUN.name),
      signature: known(source.businessImages.signature),
      stamp: known(source.businessImages.stamp),
      acceptance: false,
    },
    images,
  }
}

/** A statement entry as the API built it. */
export interface PdfStatementEntry {
  readonly date: string
  readonly kind: 'invoice' | 'credit_note' | 'order' | 'sale' | 'refund' | 'payment' | 'money_back'
  readonly number: string | null
  readonly reference: string | null
  /** A sale paid at the time, invoiced after (its payment has no record of its own). */
  readonly paidWhenMade?: boolean
  /** A sale's (or a refund's) first items. */
  readonly itemNames?: readonly string[]
  /** How a payment or money given back was paid. */
  readonly method?: 'cash' | 'card' | 'bank_transfer' | 'cheque' | null
  /** What of an invoice its order or sale charged already, of a credit note its order owes again. */
  readonly owedThrough?: { readonly amount: string; readonly orderNumber: string | null } | null
  readonly charge: string
  readonly credit: string
  readonly owed: string
}

export interface PdfStatement {
  readonly from: string
  readonly to: string
  readonly issuedOn: string
  readonly currency: string
  readonly opening: string
  readonly invoiced: string
  readonly credited: string
  readonly paid: string
  readonly closing: string
  readonly entries: readonly PdfStatementEntry[]
  /** When it was made (the PDF's own date). */
  readonly issuedAt: Date
}

/** A statement entry's document in both languages: "Invoice INV-0001", "Payment – INV-0001". */
function entryDocument(entry: PdfStatementEntry): Bilingual {
  if (entry.paidWhenMade) return both('pdf.statement.paidWhenMade')
  if (entry.kind === 'payment' || entry.kind === 'money_back') {
    return entry.reference
      ? both(`pdf.statement.${entry.kind}On`, { reference: entry.reference })
      : both(`pdf.statement.${entry.kind}`)
  }
  if (entry.kind === 'sale' || entry.kind === 'refund') return both(`pdf.statement.${entry.kind}`)
  return both(`pdf.statement.${entry.kind}`, { number: entry.number ?? '' })
}

/**
 * What a statement entry was, under its document: a sale's first items, how a payment was paid, what of
 * an invoice was owed already through its order or sale (of a credit note, what its order owes again).
 */
function entryDetail(
  entry: PdfStatementEntry,
  locale: 'en' | 'ar',
  money: (value: string) => string,
): DocumentPdfStatementEntry['detail'] {
  const through = entry.owedThrough
  if (through && (entry.kind === 'invoice' || entry.kind === 'credit_note')) {
    const amount = money(through.amount)
    if (entry.kind === 'credit_note') {
      return both('pdf.statement.stillOwedOrder', { order: through.orderNumber ?? '', amount })
    }
    return through.orderNumber === null
      ? both('pdf.statement.owedThroughSale', { amount })
      : both('pdf.statement.owedThroughOrder', { order: through.orderNumber, amount })
  }
  const names = (entry.itemNames ?? []).filter((n) => n.trim() !== '')
  if ((entry.kind === 'sale' || entry.kind === 'refund') && names.length > 0) {
    return typedText(names.join(locale === 'ar' ? '، ' : ', '), locale === 'ar' ? 'rtl' : 'ltr')
  }
  if ((entry.kind === 'payment' || entry.kind === 'money_back') && entry.method) {
    return both(`pdf.method.${entry.method}`)
  }
  return null
}

/**
 * The DocumentPdfInput of a customer's statement for a period (M3 Step 8, Q27): «كشف حساب · Statement
 * of Account» on the letterhead, owed at the start, each document and payment of the period with what is
 * owed after it, and the period's sums and what is owed at the end.
 */
export function buildStatementPdfInput(source: {
  readonly business: PdfBusiness
  readonly statement: PdfStatement
  readonly customer: PdfCustomer
  readonly businessImages: PdfBusinessImages
  readonly images: Readonly<Record<string, DocumentPdfImage>>
}): DocumentPdfInput {
  const { business, statement: st, customer } = source
  const locale = business.locale
  const digits = CURRENCY_DIGITS[st.currency] ?? 2
  const money = (value: string) => formatAmount(value, digits, false)
  const zero = (value: string) => compareDecimal(value, '0') === 0
  labels ??= labelsOf()
  const from = formatDate(st.from)
  const to = formatDate(st.to)
  return {
    kind: 'statement',
    draft: false,
    locale,
    issuedAt: issuedAtOf(st.issuedAt),
    labels,
    title: both('pdf.title.statement'),
    number: '',
    revision: null,
    date: formatDate(st.issuedOn),
    validUntil: null,
    dueDate: null,
    customerRef: null,
    references: [
      {
        label: both('pdf.period'),
        value: {
          en: fill(pick(messagesOf('en'), 'pdf.periodValue'), { from: from.en, to: to.en }),
          ar: fill(pick(messagesOf('ar'), 'pdf.periodValue'), { from: from.ar, to: to.ar }),
        },
      },
      { label: both('pdf.currency'), value: st.currency },
    ],
    currency: st.currency,
    letterhead: letterheadOf(business, source.businessImages, source.images),
    customer: partyOf(customer, false, locale),
    opening: null,
    table: { showPictures: false, showAreas: false, showDiscount: false, showVat: false },
    lines: [],
    totals: [
      { label: both('pdf.statement.opening'), amount: money(st.opening), strong: false },
      { label: both('pdf.statement.invoiced'), amount: money(st.invoiced), strong: false },
      {
        label: both('pdf.statement.credited'),
        amount: money(zero(st.credited) ? '0' : subtractDecimals('0', st.credited)),
        strong: false,
      },
      {
        label: both('pdf.statement.paid'),
        amount: money(zero(st.paid) ? '0' : subtractDecimals('0', st.paid)),
        strong: false,
      },
      compareDecimal(st.closing, '0') < 0
        ? {
            label: both('pdf.statement.closingAhead'),
            amount: money(subtractDecimals('0', st.closing)),
            strong: true,
          }
        : { label: both('pdf.statement.closing'), amount: money(st.closing), strong: true },
    ],
    stages: [],
    payments: [],
    statement: {
      opening: money(st.opening),
      entries: st.entries.map((entry) => ({
        date: formatDate(entry.date),
        document: entryDocument(entry),
        charge: zero(entry.charge) ? null : money(entry.charge),
        credit: zero(entry.credit) ? null : money(entry.credit),
        // Below zero: paid ahead, printed as what was paid beyond.
        owed: money(
          compareDecimal(entry.owed, '0') < 0 ? subtractDecimals('0', entry.owed) : entry.owed,
        ),
        ahead: compareDecimal(entry.owed, '0') < 0,
        detail: entryDetail(entry, locale, money),
      })),
    },
    validity: null,
    terms: null,
    notes: null,
    paymentDetails: typedText(business.footer, locale === 'ar' ? 'rtl' : 'ltr', RUN.closing),
    signature: { signatory: null, signature: null, stamp: null, acceptance: false },
    images: source.images,
  }
}
