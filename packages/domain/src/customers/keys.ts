import { normalizeDigits } from '../numbers/digits'

// Customers (M3 Step 5; the owner's answer Q2 = A of D-218): one list of the business's customers,
// apart from suppliers (D-112). Names may repeat ("Did you mean Ahmed · 050…?"); a customer has a
// kind, a phone, an email, a TRN, an address with its emirate (asked only with Invoices on) and, for a
// business or a government customer, its trade licence (for e-invoicing later). Never an Emirates ID
// or a passport number. The database CHECK constraints list the same values.

/** `customers.kind`: a person, a business, or a government body (a tax invoice's buyer kind). */
export const CUSTOMER_KINDS = ['individual', 'business', 'government'] as const
export type CustomerKind = (typeof CUSTOMER_KINDS)[number]

/** Kinds that may have a trade licence number (B15, for e-invoicing later). */
export const LICENSED_CUSTOMER_KINDS = [
  'business',
  'government',
] as const satisfies readonly CustomerKind[]

export function customerMayHaveLicence(kind: CustomerKind): boolean {
  return (LICENSED_CUSTOMER_KINDS as readonly string[]).includes(kind)
}

/** The seven emirates (`customers.emirate`, only for an address in the UAE). */
export const EMIRATES = [
  'abu_dhabi',
  'dubai',
  'sharjah',
  'ajman',
  'umm_al_quwain',
  'ras_al_khaimah',
  'fujairah',
] as const
export type Emirate = (typeof EMIRATES)[number]

/** A customer's country unless the address says another (ISO 3166-1 alpha-2). */
export const DEFAULT_CUSTOMER_COUNTRY = 'AE'

/**
 * The last 4 digits of a phone number as typed (Arabic-Indic digits read as digits), or null when it
 * has fewer than 4: what a member who may not see customers is shown to tell two "Ahmed"s apart
 * (Q2: "Ahmed · …4567"), never the whole number.
 */
export function phoneLast4(phone: string | null): string | null {
  if (phone === null) return null
  const digits = normalizeDigits(phone).replace(/\D/g, '')
  return digits.length < 4 ? null : digits.slice(-4)
}
