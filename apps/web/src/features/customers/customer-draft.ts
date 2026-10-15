import {
  CUSTOMER_LICENCE_MAX_LENGTH,
  CUSTOMER_NAME_MAX_LENGTH,
  DOCUMENT_NOTES_MAX_LENGTH,
  hasVisibleCharacter,
  CUSTOMER_EMAIL_MAX_LENGTH,
  CUSTOMER_PHONE_MAX_LENGTH,
  type CreateCustomerInput,
  type CustomerDto,
} from '@bizcost/contracts'
import {
  customerMayHaveLicence,
  normalizeDigits,
  parseTrn,
  type CustomerKind,
} from '@bizcost/domain'
import type { FieldError } from '../catalog/numbers'
import { formName } from '../catalog/material-draft'

// The customer form (M3 Step 5; Q2, D-263): a name in any language (names may repeat: "Did you mean"
// shows the others first), whether it is a person, a business or a government body, and optional
// contact details: a phone, an email, the TRN and, for a business or a government customer, its trade
// licence number. Never an Emirates ID or a passport number. The address is asked only with Invoices
// on (Release B): until then a stored one is kept as it is. Checked as the API checks them
// (dto/customers.ts).

export interface CustomerDraft {
  readonly name: string
  readonly kind: CustomerKind
  readonly phone: string
  readonly email: string
  readonly trn: string
  readonly tradeLicenceNo: string
  readonly notes: string
}

export interface CustomerErrors {
  name?: FieldError
  phone?: FieldError
  email?: FieldError
  trn?: FieldError
  tradeLicenceNo?: FieldError
  notes?: FieldError
}

/** customer.create's fields (without the id); customer.update adds the id and the version. */
export type CustomerFields = Omit<CreateCustomerInput, 'id'>

const PHONE = /^[+\d\s()-]*\d[+\d\s()-]*$/
/** An email as a person types it: something@something.something, no spaces. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The form's first state: a new customer (named `name`, from a picker), or one as stored. */
export function customerDraft(customer?: CustomerDto, name = ''): CustomerDraft {
  return {
    name: customer?.name ?? name,
    kind: customer?.kind ?? 'individual',
    phone: customer?.phone ?? '',
    email: customer?.email ?? '',
    trn: customer?.trn ?? '',
    tradeLicenceNo: customer?.tradeLicenceNo ?? '',
    notes: customer?.notes ?? '',
  }
}

/**
 * Every problem of the form, and the fields to send when there is none. `stored`: the customer being
 * edited, whose address (asked only with Invoices on) is sent back as it is.
 */
export function checkCustomer(
  draft: CustomerDraft,
  stored?: CustomerDto,
): { errors: CustomerErrors; fields: CustomerFields | null } {
  const errors: CustomerErrors = {}
  const name = formName(draft.name)
  if (!hasVisibleCharacter(name)) errors.name = { key: 'catalog.form.nameRequired' }
  else if (name.length > CUSTOMER_NAME_MAX_LENGTH) {
    errors.name = { key: 'catalog.form.nameTooLong', values: { count: CUSTOMER_NAME_MAX_LENGTH } }
  }
  const phone = normalizeDigits(draft.phone).trim()
  if (phone && (phone.length > CUSTOMER_PHONE_MAX_LENGTH || !PHONE.test(phone))) {
    errors.phone = { key: 'orders.customers.form.phoneInvalid' }
  }
  const email = draft.email.trim()
  if (email && (email.length > CUSTOMER_EMAIL_MAX_LENGTH || !EMAIL.test(email))) {
    errors.email = { key: 'orders.customers.form.emailInvalid' }
  }
  const trnText = draft.trn.trim()
  const trn = trnText ? parseTrn(trnText) : null
  if (trn && !trn.ok) errors.trn = { key: 'orders.customers.form.trnInvalid' }
  // A trade licence only for a business or a government body (B15); a person's is never kept.
  const licence = customerMayHaveLicence(draft.kind) ? draft.tradeLicenceNo.trim() : ''
  if (licence.length > CUSTOMER_LICENCE_MAX_LENGTH) {
    errors.tradeLicenceNo = {
      key: 'orders.tooLong',
      values: { count: CUSTOMER_LICENCE_MAX_LENGTH },
    }
  }
  const notes = draft.notes.trim()
  if (notes.length > DOCUMENT_NOTES_MAX_LENGTH) {
    errors.notes = { key: 'orders.tooLong', values: { count: DOCUMENT_NOTES_MAX_LENGTH } }
  }
  if (Object.values(errors).some(Boolean)) return { errors, fields: null }
  return {
    errors,
    fields: {
      name,
      kind: draft.kind,
      phone: phone || null,
      email: email || null,
      trn: trn?.ok ? trn.value : null,
      tradeLicenceNo: licence || null,
      addressLine: stored?.addressLine ?? null,
      city: stored?.city ?? null,
      emirate: stored?.emirate ?? null,
      country: stored?.country ?? 'AE',
      notes: notes || null,
    },
  }
}
