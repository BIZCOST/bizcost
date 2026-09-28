import {
  CATALOG_NAME_MAX_LENGTH,
  DOCUMENT_NOTES_MAX_LENGTH,
  hasVisibleCharacter,
  SUPPLIER_EMAIL_MAX_LENGTH,
  SUPPLIER_PHONE_MAX_LENGTH,
  type CreateSupplierInput,
  type SupplierDto,
} from '@bizcost/contracts'
import { normalizeDigits, parseTrn } from '@bizcost/domain'
import type { FieldError } from '../catalog/numbers'
import { formName } from '../catalog/material-draft'

// The supplier form (M2 Step 3; D-112, D-113, D-133): one name in any language, and optional contact
// details. Checked as the API checks them (dto/suppliers.ts), so a save is refused only for a name
// that is already used.

export interface SupplierDraft {
  readonly name: string
  readonly phone: string
  readonly email: string
  readonly trn: string
  readonly notes: string
}

export interface SupplierErrors {
  name?: FieldError
  phone?: FieldError
  email?: FieldError
  trn?: FieldError
  notes?: FieldError
}

/** supplier.create's fields (without the id); supplier.update adds the id and the version. */
export type SupplierFields = Omit<CreateSupplierInput, 'id'>

const PHONE = /^[+\d\s()-]*\d[+\d\s()-]*$/
/** An email as a person types it: something@something.something, no spaces. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function supplierDraft(supplier?: SupplierDto): SupplierDraft {
  return {
    name: supplier?.name ?? '',
    phone: supplier?.phone ?? '',
    email: supplier?.email ?? '',
    trn: supplier?.trn ?? '',
    notes: supplier?.notes ?? '',
  }
}

/** Every problem of the form, and the fields to send when there is none. */
export function checkSupplier(draft: SupplierDraft): {
  errors: SupplierErrors
  fields: SupplierFields | null
} {
  const errors: SupplierErrors = {}
  const name = formName(draft.name)
  if (!hasVisibleCharacter(name)) errors.name = { key: 'catalog.form.nameRequired' }
  else if (name.length > CATALOG_NAME_MAX_LENGTH) {
    errors.name = { key: 'catalog.form.nameTooLong', values: { count: CATALOG_NAME_MAX_LENGTH } }
  }
  const phone = normalizeDigits(draft.phone).trim()
  if (phone && (phone.length > SUPPLIER_PHONE_MAX_LENGTH || !PHONE.test(phone))) {
    errors.phone = { key: 'purchasing.suppliers.phoneInvalid' }
  }
  const email = draft.email.trim()
  if (email && (email.length > SUPPLIER_EMAIL_MAX_LENGTH || !EMAIL.test(email))) {
    errors.email = { key: 'purchasing.suppliers.emailInvalid' }
  }
  const trnText = draft.trn.trim()
  const trn = trnText ? parseTrn(trnText) : null
  if (trn && !trn.ok) errors.trn = { key: 'purchasing.suppliers.trnInvalid' }
  const notes = draft.notes.trim()
  if (notes.length > DOCUMENT_NOTES_MAX_LENGTH) {
    errors.notes = {
      key: 'purchasing.tooLong',
      values: { count: DOCUMENT_NOTES_MAX_LENGTH },
    }
  }
  if (Object.values(errors).some(Boolean)) return { errors, fields: null }
  return {
    errors,
    fields: {
      name,
      phone: phone || null,
      email: email || null,
      trn: trn?.ok ? trn.value : null,
      notes: notes || null,
    },
  }
}
