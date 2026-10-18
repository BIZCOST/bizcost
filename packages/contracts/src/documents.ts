// Limits of Quotations, the document settings and the PDFs (M3 Step 7), shared by the API
// (dto/quotations.ts, dto/documents.ts) and the app forms. No Zod here, so a client that needs only the
// numbers does not bundle the API schemas. The database CHECKs hold the same lengths (packages/db
// schema/quotations.ts, schema/businesses.ts).

/** Most lines on one quotation (a fit-out's bill of quantities runs to a few hundred). */
export const QUOTATION_LINES_MAX = 300

/** Longest title of a quotation line (a product's name is copied into it, editable). */
export const QUOTATION_LINE_TITLE_MAX_LENGTH = 200

/** Longest details of a line (materials, finishes, fittings; line breaks kept). */
export const QUOTATION_LINE_DETAILS_MAX_LENGTH = 2000

/** Longest highlighted note of a line (printed in red). */
export const QUOTATION_LINE_NOTE_MAX_LENGTH = 500

/**
 * Longest name of an area or room ("MAJLIS", "Dining room"): the PDF writes it up the side of its
 * lines, smaller and on two lines when it is long, so 40 characters still fit a short area (D-299).
 */
export const QUOTATION_AREA_MAX_LENGTH = 40

/** Longest customer reference (their enquiry or LPO number), and project or site. */
export const QUOTATION_CUSTOMER_REF_MAX_LENGTH = 100
export const QUOTATION_SITE_MAX_LENGTH = 200

/** Longest greeting ("Dear Eng. Hamdan,"), typed in place of the default one. */
export const QUOTATION_GREETING_MAX_LENGTH = 200

/** Longest opening sentence, terms and notes of a quotation. */
export const QUOTATION_INTRO_MAX_LENGTH = 1000
export const QUOTATION_TERMS_MAX_LENGTH = 4000
export const QUOTATION_NOTES_MAX_LENGTH = 1000

/** Longest label and "when" of a payment stage ("1st payment", "Upon signing"). */
export const PAYMENT_STAGE_LABEL_MAX_LENGTH = 100
export const PAYMENT_STAGE_DUE_MAX_LENGTH = 100

/** Longest note with an acceptance, and reason with a decline. */
export const QUOTATION_ANSWER_NOTE_MAX_LENGTH = 500

/** Quotations per page of `quotation.list`, and the most a client may ask for. */
export const QUOTATION_PAGE_SIZE = 50
export const QUOTATION_PAGE_SIZE_MAX = 100

/** Events `quotation.history` lists at most (the newest first). */
export const QUOTATION_HISTORY_MAX = 200

/** The pictures a quotation line may have: one, printed in the PDF's picture column. */
export const QUOTATION_LINE_PICTURES_MAX = 1

/**
 * Every line picture's frame (D-299: «الصور اللي يحطها تتضبط تلقائي بنفس المقاس»): the PDF prints
 * each one 20 × 15 mm, filling the frame (a centred crop, never stretched, never with bands), and the
 * browser saves each one at exactly this size, framed the same way unless the owner moves or zooms it
 * ("Adjust picture"), so every screen shows what the PDF prints.
 */
export const QUOTATION_PICTURE_WIDTH = 800
export const QUOTATION_PICTURE_HEIGHT = 600

// ---------------------------------------------------------------------------------------------------
// Settings → Documents
// ---------------------------------------------------------------------------------------------------

/** Longest prefix of a document number ("Q-", "INV-"), as document_counters holds it. */
export const DOCUMENT_PREFIX_MAX_LENGTH = 20

/** The highest first number a series may start from. */
export const DOCUMENT_FIRST_NUMBER_MAX = 999_999_999

/** Longest footer (bank details) and default quotation terms. */
export const DOCUMENT_FOOTER_MAX_LENGTH = 1000

/** Longest signatory name. */
export const DOCUMENT_SIGNATORY_MAX_LENGTH = 100

/** The business's contact lines: phones, email (as a customer's), address, trade licence. */
export const BUSINESS_PHONE_MAX_LENGTH = 30
export const BUSINESS_EMAIL_MAX_LENGTH = 254
export const BUSINESS_ADDRESS_MAX_LENGTH = 200
export const BUSINESS_CITY_MAX_LENGTH = 100
export const BUSINESS_LICENCE_MAX_LENGTH = 50
export const BUSINESS_LICENCE_AUTHORITY_MAX_LENGTH = 100

/** Largest signature or stamp image, in bytes (as a logo). */
export const DOCUMENT_IMAGE_MAX_BYTES = 2 * 1024 * 1024

/** Image types a signature or stamp may have (as a logo; never SVG). */
export const DOCUMENT_IMAGE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type DocumentImageContentType = (typeof DOCUMENT_IMAGE_CONTENT_TYPES)[number]

/** What a document image is: the signatory's signature, or the business's stamp. */
export const DOCUMENT_IMAGE_KINDS = ['signature', 'stamp'] as const
export type DocumentImageKind = (typeof DOCUMENT_IMAGE_KINDS)[number]

/** A signed URL of a signature, stamp or line picture lasts this many seconds (as a logo's). */
export const DOCUMENT_IMAGE_URL_TTL_SECONDS = 600
