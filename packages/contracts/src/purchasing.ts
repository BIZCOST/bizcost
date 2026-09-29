// Limits of Suppliers, Purchases, supplier returns and credit notes, and attachments (M2 Step 3),
// shared by the API (dto/suppliers.ts, dto/purchases.ts, dto/attachments.ts) and the app forms. No
// Zod here, so a client that needs only the numbers does not bundle the API schemas. The database
// CHECKs hold the same lengths (packages/db schema/suppliers.ts, purchasing.ts, files.ts).

/** Longest supplier phone number, as typed. */
export const SUPPLIER_PHONE_MAX_LENGTH = 30

/** Longest supplier email. */
export const SUPPLIER_EMAIL_MAX_LENGTH = 254

/** Longest notes of a supplier, a purchase, a return or a credit note. */
export const DOCUMENT_NOTES_MAX_LENGTH = 1000

/** Longest note of a payment of what is owed on a purchase. */
export const PAYMENT_NOTE_MAX_LENGTH = 500

/** Longest reference (the supplier's invoice, return note or credit note number). */
export const DOCUMENT_REFERENCE_MAX_LENGTH = 100

/** Longest text of a purchase line (a delivery's description; a material line copies its name). */
export const PURCHASE_LINE_DESCRIPTION_MAX_LENGTH = 200

/** Most lines on one purchase, return or credit note. */
export const DOCUMENT_LINES_MAX = 100

/** Rows per page of a document list: the default, and the most a client may ask for. */
export const DOCUMENT_PAGE_SIZE = 50
export const DOCUMENT_PAGE_SIZE_MAX = 100

/**
 * Amounts owed (`payable.list`): suppliers or members per page, and the purchases listed for each (the
 * oldest first; the rest are counted, and show up as the older ones are paid).
 */
export const PAYABLE_PAGE_SIZE = 25
export const PAYABLE_INVOICES_MAX = 50

/** Materials one `material.costs` call may ask for (a page of the materials list). */
export const MATERIAL_COSTS_MAX = 100

/** What an attachment may be: a photo of a receipt, or a PDF (the bucket's allowed_mime_types). */
export const ATTACHMENT_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
] as const
export type AttachmentContentType = (typeof ATTACHMENT_CONTENT_TYPES)[number]

/** Largest attachment (the bucket's file_size_limit), in bytes. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024

/** Longest file name kept for an attachment. */
export const ATTACHMENT_FILE_NAME_MAX_LENGTH = 200

/** Most files attached to one record. */
export const ATTACHMENTS_PER_RECORD_MAX = 20

/** A signed attachment URL works for this many seconds (a URL stays valid after access ends). */
export const ATTACHMENT_URL_TTL_SECONDS = 600
