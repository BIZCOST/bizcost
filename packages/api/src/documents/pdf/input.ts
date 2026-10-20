// What a document PDF is made from (M3 Step 7; D-224; the owner's document requests of 2026-10-16):
// one typed input for every document kind (a quotation now; a tax invoice, a plain invoice and the
// credit notes in Step 8), built on the server from the document's frozen values and the business's
// own details, then given to the Typst template as JSON (`/data.json`), never as markup. Every value
// is ready to print: amounts and quantities already formatted (Latin digits, grouped, the document's
// decimals), dates written out, labels bilingual from the `documents` i18n namespace. Pictures are
// named by an image key; their bytes are read by the server from the business's own Storage objects
// and mapped next to the data under /img/ (never a path or URL from user input).
//
// Text as typed (names, titles, details, notes, terms) carries its first strong direction (`dir`),
// so the template sets each in its own direction: a first-strong isolate (D-224). Numbers, TRNs,
// references and amounts print in left-to-right isolates.

/** A label in both languages (the PDF prints both, Q23). */
export interface Bilingual {
  readonly en: string
  readonly ar: string
}

/** Text as a person typed it, with the direction of its first strong character. */
export interface TypedText {
  readonly text: string
  readonly dir: 'ltr' | 'rtl'
}

/** The document kinds of the template: its title, and which blocks it prints. */
export const DOCUMENT_PDF_KINDS = [
  'quotation',
  'tax_invoice',
  'invoice',
  'tax_credit_note',
  'credit_note',
  'statement',
] as const
export type DocumentPdfKind = (typeof DOCUMENT_PDF_KINDS)[number]

/** An image the server mapped for the template (PNG, JPEG or WebP; its size checked). */
export interface DocumentPdfImage {
  /** Where the template reads it: /img/<key>.<ext>, set by the server only. */
  readonly path: string
  readonly format: 'png' | 'jpg' | 'webp'
  readonly width: number
  readonly height: number
}

export interface DocumentPdfLetterhead {
  /** The business's English and Arabic names (legal names, else its display name); one may be null. */
  readonly nameEn: TypedText | null
  readonly nameAr: TypedText | null
  /** The accent colour (#RRGGBB, one of DOCUMENT_ACCENTS). */
  readonly accent: string
  /** The logo's image key; null: the names alone carry the header. */
  readonly logo: string | null
  /** The logo, large and light, behind the content (only with a logo). */
  readonly watermark: boolean
  /** The footer's contact lines (each null when not given). */
  readonly phones: readonly string[]
  readonly email: string | null
  readonly address: TypedText | null
  /** The seller's TRN (VAT-registered only) and trade licence. */
  readonly trn: string | null
  readonly tradeLicence: string | null
}

export interface DocumentPdfParty {
  readonly name: TypedText
  /** The project or site (after the name in the greeting). */
  readonly site: TypedText | null
  readonly phone: string | null
  readonly trn: string | null
  readonly address: TypedText | null
}

/** One line of the table. */
export interface DocumentPdfLine {
  /** 1, 2, 3… */
  readonly no: number
  /** Groups consecutive lines (written vertically in one cell); null: none. */
  readonly area: TypedText | null
  /** The picture's image key; null: none. */
  readonly picture: string | null
  readonly title: TypedText
  /** Line breaks kept. */
  readonly details: TypedText | null
  /** Printed in red. */
  readonly note: TypedText | null
  /** "12.5", with its unit ("m²"). */
  readonly qty: string
  readonly unit: string | null
  readonly unitPrice: string
  /** Its own discount as an amount ("150.00"); null: none. */
  readonly discount: string | null
  /** Its VAT rate ("5%", "0%", "Exempt"); null when the document shows no VAT per line. */
  readonly vatRate: string | null
  /** Its amount after its own discount, as its price was typed (with VAT when `includesVat`). */
  readonly amount: string
  /** Its price was typed with VAT: its row says "incl. VAT" (the totals are before VAT, D-296). */
  readonly includesVat?: boolean
}

export interface DocumentPdfTotalRow {
  readonly label: Bilingual
  readonly amount: string
  /** The total and the amount to pay are set apart. */
  readonly strong: boolean
}

/** One of Step 8's own references in the details box (the invoice a credit note corrects, its date). */
export interface DocumentPdfReference {
  readonly label: Bilingual
  /** A number or code (printed left to right), or a date in both languages. */
  readonly value: string | Bilingual
}

/** A payment an invoice has received (Step 8), beside its totals. */
export interface DocumentPdfPayment {
  /** Null for what its order or sale paid before it (several days, said by its method). */
  readonly date: Bilingual | null
  readonly method: TypedText | Bilingual
  readonly reference: string | null
  readonly amount: string
}

/** One entry of a customer's statement (M3 Step 8, Q27): a document or a payment on its day. */
export interface DocumentPdfStatementEntry {
  readonly date: Bilingual
  /** "Invoice INV-0001", "Payment – INV-0001" (both languages). */
  readonly document: Bilingual
  /** What it adds to what is owed, or null. */
  readonly charge: string | null
  /** What it takes off, or null. */
  readonly credit: string | null
  /** What is owed after it (its amount when paid ahead: `ahead`). */
  readonly owed: string
  /** Paid ahead after it (owed below zero): `owed` is what was paid beyond. */
  readonly ahead?: boolean
  /** What it was, under its document: a sale's first items, how a payment was paid. */
  readonly detail?: TypedText | Bilingual | null
}

/** A customer's statement for a period (M3 Step 8, Q27): its rows, after "owed at the start". */
export interface DocumentPdfStatement {
  readonly opening: string
  readonly entries: readonly DocumentPdfStatementEntry[]
}

export interface DocumentPdfStage {
  readonly label: TypedText | Bilingual
  readonly due: TypedText
  /** "50%". */
  readonly percent: string
  readonly amount: string
}

export interface DocumentPdfInput {
  readonly kind: DocumentPdfKind
  /** A draft prints "Draft" across every page. */
  readonly draft: boolean
  /** The business's language: the layout's direction, which label comes first, the units. */
  readonly locale: 'en' | 'ar'
  /** The PDF's metadata date (the document's own frozen timestamp: a re-render is byte-identical). */
  readonly issuedAt: {
    year: number
    month: number
    day: number
    hour: number
    minute: number
    second: number
  }
  /** Every label the template prints, bilingual (the `documents.pdf` messages, filled in). */
  readonly labels: Readonly<Record<string, Bilingual>>
  readonly title: Bilingual
  readonly number: string
  /** A quotation's revision when it is the second or later; null otherwise. */
  readonly revision: number | null
  readonly date: Bilingual
  readonly validUntil: Bilingual | null
  /** An invoice's due date (Step 8); a quotation has none. */
  readonly dueDate?: Bilingual | null
  readonly customerRef: string | null
  /** Step 8's own references in the details box (the original invoice of a credit note…). */
  readonly references?: readonly DocumentPdfReference[]
  readonly currency: string
  readonly letterhead: DocumentPdfLetterhead
  readonly customer: DocumentPdfParty
  /**
   * "Dear …," and the sentences after it (a quotation); null: none (an invoice dates its details box
   * instead).
   */
  readonly opening: {
    /**
     * As typed on the document; null: the business's language's default («السادة / <name>،», "Dear
     * <name>,"), the customer's name and the project each in its own isolate (the template's).
     */
    readonly greeting: TypedText | null
    /** As typed (one language), or the default sentence of each language. */
    readonly intro: TypedText | Bilingual
    readonly amountsIn: Bilingual
  } | null
  readonly table: {
    readonly showPictures: boolean
    readonly showAreas: boolean
    readonly showDiscount: boolean
    readonly showVat: boolean
  }
  readonly lines: readonly DocumentPdfLine[]
  readonly totals: readonly DocumentPdfTotalRow[]
  readonly stages: readonly DocumentPdfStage[]
  /** The payments an invoice has received (Step 8), beside its totals. */
  readonly payments?: readonly DocumentPdfPayment[]
  /**
   * A credit note's reason (ER Art. 60(1)(f)): its kind in both languages and the explanation as typed
   * (Step 8), beside its totals.
   */
  readonly reason?: { readonly kind: Bilingual; readonly text: TypedText } | null
  /** A customer's statement (Step 8): its entries in place of the lines. */
  readonly statement?: DocumentPdfStatement | null
  /** "This quotation is valid until …"; null without a validity. */
  readonly validity: Bilingual | null
  readonly terms: TypedText | null
  readonly notes: TypedText | null
  /** The business's footer: bank details (Settings → Documents). */
  readonly paymentDetails: TypedText | null
  readonly signature: {
    readonly signatory: TypedText | null
    readonly signature: string | null
    readonly stamp: string | null
    /** A quotation leaves room for the customer's acceptance. */
    readonly acceptance: boolean
  }
  /** The images the keys above name. */
  readonly images: Readonly<Record<string, DocumentPdfImage>>
}
