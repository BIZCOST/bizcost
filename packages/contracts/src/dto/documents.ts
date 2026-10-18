import {
  DOCUMENT_ACCENT_KEYS,
  DOCUMENT_NUMBER_PADDING_MAX,
  DOCUMENT_SERIES,
  EMIRATES,
  QUOTATION_VALID_DAYS_MAX,
} from '@bizcost/domain'
import { z } from 'zod'
import {
  BUSINESS_ADDRESS_MAX_LENGTH,
  BUSINESS_CITY_MAX_LENGTH,
  BUSINESS_LICENCE_AUTHORITY_MAX_LENGTH,
  BUSINESS_LICENCE_MAX_LENGTH,
  DOCUMENT_FIRST_NUMBER_MAX,
  DOCUMENT_FOOTER_MAX_LENGTH,
  DOCUMENT_IMAGE_CONTENT_TYPES,
  DOCUMENT_IMAGE_KINDS,
  DOCUMENT_PREFIX_MAX_LENGTH,
  DOCUMENT_SIGNATORY_MAX_LENGTH,
  QUOTATION_TERMS_MAX_LENGTH,
} from '../documents'
import { CONTROL_CHARACTER } from '../text'
import { emailInput, optionalLine, phoneInput } from './suppliers'

// Settings → Documents (ROADMAP.md M3 Step 7; the owner's answer Q25 and his document requests of
// 2026-10-16): each series' prefix, zero padding and first number (settable only until the series'
// first document: SERIES_STARTED), the footer printed under the totals (bank details), the default terms
// and validity of a new quotation, and the letterhead built from the business's own details: its accent
// colour, the logo's watermark, whole amounts without ".00", the signatory and their signature and
// stamp (images uploaded through signed URLs and checked like the logo). Served only while Quotations or
// Invoices is (MODULE_DISABLED otherwise); `settings.documents.manage` (Owner and Admin).
//
// The business's contact lines (phones, email, address, trade licence) are part of its profile
// (`business.updateProfile`'s `letterhead`), shown there only while Quotations or Invoices is served.

export const documentSeriesDto = z.enum(DOCUMENT_SERIES)
export const documentAccentDto = z.enum(DOCUMENT_ACCENT_KEYS as [string, ...string[]])
export const documentImageKindDto = z.enum(DOCUMENT_IMAGE_KINDS)

/** A prefix as typed ("Q-", "INV/2026-"): up to 20 characters, no control character; '' is none. */
const prefixInput = z
  .string()
  .max(DOCUMENT_PREFIX_MAX_LENGTH)
  .refine((value) => !CONTROL_CHARACTER.test(value), { message: 'control character' })

/** A multi-line text (line breaks kept, no other control character); '' means none. */
const MULTILINE_CONTROL = /(?!\n)\p{Cc}/u
function multilineInput(max: number) {
  return z
    .string()
    .overwrite((value) => value.replace(/\r\n?/g, '\n'))
    .trim()
    .max(max)
    .refine((value) => !MULTILINE_CONTROL.test(value), { message: 'control character' })
    .nullish()
    .transform((value) => (value ? value : null))
}

export const documentSeriesSettingDto = z.object({
  series: documentSeriesDto,
  prefix: z.string(),
  padding: z.int().min(0).max(DOCUMENT_NUMBER_PADDING_MAX),
  /** The series' first number. */
  firstNo: z.int().positive(),
  /** The number the next document takes. */
  nextNo: z.int().positive(),
  /** A document already took a number: the first number no longer changes. */
  started: z.boolean(),
  /** The next number as it will print ("Q-0001"). */
  example: z.string(),
})
export type DocumentSeriesSettingDto = z.infer<typeof documentSeriesSettingDto>

/** `document.settings` (settings.documents.manage). */
export const documentSettingsDto = z.object({
  series: z.array(documentSeriesSettingDto),
  /** Printed under the totals of every document (bank details); null: none. */
  footer: z.string().nullable(),
  /** The terms a new quotation starts with; null: none. */
  quotationTerms: z.string().nullable(),
  /** A new quotation is valid for this many days from its date. */
  quotationValidDays: z.int().positive(),
  accent: documentAccentDto,
  /** The logo, large and light, behind the content of every page (only with a logo). */
  watermark: z.boolean(),
  /** Amounts without fils print without ".00" (off: always 2 decimals, as tax documents). */
  wholeAmounts: z.boolean(),
  /** Who signs the business's documents; null: no name printed. */
  signatory: z.string().nullable(),
  /** Signed download URLs of the signature and the stamp images; null without one. */
  signatureUrl: z.string().nullable(),
  stampUrl: z.string().nullable(),
  /**
   * The letterhead's address line exactly as the documents print it (from the business profile: its
   * address, area or city and emirate), with its direction; null without one.
   */
  letterheadAddress: z.object({ text: z.string(), dir: z.enum(['ltr', 'rtl']) }).nullable(),
  /** The business's version (send it back with updateSettings). */
  version: z.int().positive(),
})
export type DocumentSettingsDto = z.infer<typeof documentSettingsDto>

/**
 * `document.updateSettings` (settings.documents.manage): the whole form, `version` as read. Each
 * series named changes its prefix and padding; `firstNo` only before its first document
 * (SERIES_STARTED after), and never below 1.
 */
export const updateDocumentSettingsInput = z.object({
  version: z.int().positive(),
  series: z
    .array(
      z.object({
        series: documentSeriesDto,
        prefix: prefixInput,
        padding: z.int().min(0).max(DOCUMENT_NUMBER_PADDING_MAX),
        firstNo: z.int().min(1).max(DOCUMENT_FIRST_NUMBER_MAX).optional(),
      }),
    )
    .max(DOCUMENT_SERIES.length)
    .refine((items) => new Set(items.map((item) => item.series)).size === items.length, {
      message: 'one entry per series',
    })
    .default([]),
  footer: multilineInput(DOCUMENT_FOOTER_MAX_LENGTH),
  quotationTerms: multilineInput(QUOTATION_TERMS_MAX_LENGTH),
  quotationValidDays: z.int().min(1).max(QUOTATION_VALID_DAYS_MAX),
  accent: documentAccentDto,
  watermark: z.boolean(),
  wholeAmounts: z.boolean(),
  signatory: optionalLine(DOCUMENT_SIGNATORY_MAX_LENGTH),
})
export type UpdateDocumentSettingsInput = z.input<typeof updateDocumentSettingsInput>

/** `document.imageUploadUrl`: the kind and type of the image to upload (PNG, JPEG or WebP). */
export const documentImageUploadUrlInput = z.object({
  kind: documentImageKindDto,
  contentType: z.enum(DOCUMENT_IMAGE_CONTENT_TYPES),
})
export type DocumentImageUploadUrlInput = z.input<typeof documentImageUploadUrlInput>

/** A signed upload URL for one new image (as the logo's), then `document.setImage` with `path`. */
export const documentImageUploadUrlDto = z.object({
  path: z.string(),
  uploadUrl: z.string(),
  token: z.string(),
  maxBytes: z.int().positive(),
})
export type DocumentImageUploadUrlDto = z.infer<typeof documentImageUploadUrlDto>

/** `document.setImage`: the uploaded object's path, from imageUploadUrl. */
export const setDocumentImageInput = z.object({
  kind: documentImageKindDto,
  path: z.string().min(1).max(200),
})
export type SetDocumentImageInput = z.input<typeof setDocumentImageInput>

/** `document.removeImage`. */
export const removeDocumentImageInput = z.object({ kind: documentImageKindDto })
export type RemoveDocumentImageInput = z.input<typeof removeDocumentImageInput>

// ---------------------------------------------------------------------------------------------------
// The business's contact lines (Settings → Business profile, with Quotations or Invoices served)
// ---------------------------------------------------------------------------------------------------

/**
 * What the letterhead's footer and a tax invoice's seller block print: phones, email, address with
 * its emirate (only in the UAE), the trade licence and who issued it. Each '' or null is none.
 */
export const businessLetterheadInput = z.object({
  phone: phoneInput,
  phone2: phoneInput,
  email: emailInput,
  addressLine: optionalLine(BUSINESS_ADDRESS_MAX_LENGTH),
  city: optionalLine(BUSINESS_CITY_MAX_LENGTH),
  emirate: z
    .enum(EMIRATES)
    .nullish()
    .transform((value) => value ?? null),
  tradeLicenceNo: optionalLine(BUSINESS_LICENCE_MAX_LENGTH),
  tradeLicenceAuthority: optionalLine(BUSINESS_LICENCE_AUTHORITY_MAX_LENGTH),
})
export type BusinessLetterheadInput = z.input<typeof businessLetterheadInput>

export const businessLetterheadDto = z.object({
  phone: z.string().nullable(),
  phone2: z.string().nullable(),
  email: z.string().nullable(),
  addressLine: z.string().nullable(),
  city: z.string().nullable(),
  emirate: z.enum(EMIRATES).nullable(),
  tradeLicenceNo: z.string().nullable(),
  tradeLicenceAuthority: z.string().nullable(),
})
export type BusinessLetterheadDto = z.infer<typeof businessLetterheadDto>
