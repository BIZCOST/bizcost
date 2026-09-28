import { normalizeDigits, parseTrn } from '@bizcost/domain'
import { z } from 'zod'
import { CATALOG_NAME_MAX_LENGTH } from '../catalog'
import { zUuid } from '../primitives'
import {
  DOCUMENT_NOTES_MAX_LENGTH,
  SUPPLIER_EMAIL_MAX_LENGTH,
  SUPPLIER_PHONE_MAX_LENGTH,
} from '../purchasing'
import { CONTROL_CHARACTER } from '../text'
import { nameInput } from './catalog'

// Suppliers (ROADMAP.md M2 Step 3; docs/DATA_MODEL.md §6, D-112, D-113): one record per supplier,
// separate from customers, one name in any language, optional contact details. Archived, never
// deleted (D-123). Lists, `get`, `archive` and `unarchive` take the catalog's list and id inputs
// (catalogListInput, catalogIdInput). Nothing here is sensitive.

const isoTimestamp = z.iso.datetime({ offset: true })

/** Optional one-line text: trimmed, '' or absent means none (null), no control characters. */
function optionalLine(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .refine((value) => !CONTROL_CHARACTER.test(value), { message: 'control character' })
    .nullish()
    .transform((value) => (value ? value : null))
}

/** A phone number as people write it: digits (either kind), spaces, +, -, ( and ). */
const phoneInput = z
  .string()
  .trim()
  .overwrite(normalizeDigits)
  .max(SUPPLIER_PHONE_MAX_LENGTH)
  .regex(/^(?:[+\d\s()-]*\d[+\d\s()-]*)?$/, { message: 'not a phone number' })
  .nullish()
  .transform((value) => (value ? value : null))

const emailInput = z
  .string()
  .trim()
  .max(SUPPLIER_EMAIL_MAX_LENGTH)
  .refine((value) => value === '' || z.email().safeParse(value).success, {
    message: 'not an email',
  })
  .nullish()
  .transform((value) => (value ? value : null))

/** A TRN typed with spaces, dashes or Arabic digits; stored as its 15 digits (parseTrn). */
const trnInput = z
  .string()
  .trim()
  .max(40)
  .nullish()
  .transform((value, ctx) => {
    if (!value) return null
    const parsed = parseTrn(value)
    if (!parsed.ok) {
      ctx.addIssue({ code: 'custom', message: `trn: ${parsed.error}` })
      return z.NEVER
    }
    return parsed.value
  })

/** Several lines are fine. */
const notesInput = z
  .string()
  .trim()
  .max(DOCUMENT_NOTES_MAX_LENGTH)
  .nullish()
  .transform((value) => (value ? value : null))

const supplierFields = {
  name: nameInput(CATALOG_NAME_MAX_LENGTH),
  phone: phoneInput,
  email: emailInput,
  trn: trnInput,
  notes: notesInput,
}

/** `supplier.create`: `id` is a client UUIDv7, so a retry with the same payload returns it. */
export const createSupplierInput = z.object({ id: zUuid, ...supplierFields })
export type CreateSupplierInput = z.input<typeof createSupplierInput>

/** `supplier.update`: the whole record, `version` as read (CONFLICT when it changed). */
export const updateSupplierInput = z.object({
  id: zUuid,
  version: z.int().positive(),
  ...supplierFields,
})
export type UpdateSupplierInput = z.input<typeof updateSupplierInput>

export const supplierDto = z.object({
  id: zUuid,
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  /** 15 digits. */
  trn: z.string().nullable(),
  notes: z.string().nullable(),
  /** When it was archived (hidden from pickers); null while active. */
  archivedAt: isoTimestamp.nullable(),
  version: z.int().positive(),
})
export type SupplierDto = z.infer<typeof supplierDto>

/** `supplier.list`: by name (case ignored); `nextCursor` null on the last page. */
export const supplierListDto = z.object({
  items: z.array(supplierDto),
  nextCursor: z.string().nullable(),
})
export type SupplierListDto = z.infer<typeof supplierListDto>

export { optionalLine }
