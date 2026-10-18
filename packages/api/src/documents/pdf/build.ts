import { hasVisibleCharacter } from '@bizcost/contracts'
import {
  compareDecimal,
  DOCUMENT_ACCENTS,
  isDocumentAccent,
  printedSubtotal,
  subtractDecimals,
  sumDecimals,
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
  DocumentPdfStage,
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
  const parts = [line, city, emirate ? pick(messagesOf(language), `emirates.${emirate}`) : null]
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
