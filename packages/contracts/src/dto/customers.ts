import { CUSTOMER_KINDS, customerMayHaveLicence, EMIRATES } from '@bizcost/domain'
import { z } from 'zod'
import {
  CUSTOMER_ADDRESS_MAX_LENGTH,
  CUSTOMER_CITY_MAX_LENGTH,
  CUSTOMER_LICENCE_MAX_LENGTH,
  CUSTOMER_NAME_MAX_LENGTH,
  CUSTOMER_PAGE_SIZE,
  CUSTOMER_PAGE_SIZE_MAX,
  CUSTOMER_PICK_MAX,
} from '../customers'
import { zUuid } from '../primitives'
import { nameInput } from './catalog'
import { notesInput } from './purchases'
import { emailInput, optionalLine, phoneInput, trnInput } from './suppliers'

// Customers (ROADMAP.md M3 Step 5; docs/DATA_MODEL.md §6; D-112, D-113, D-123, D-133; the owner's
// answer Q2 = A of D-218): one list of the business's customers, apart from suppliers, shaped like
// them. Names may repeat ("Did you mean Ahmed · 050…?": `customer.similar`). A customer has a kind
// (a person, a business or a government body), a phone, an email, a TRN, an address with its emirate
// (the screens ask it only with Invoices on) and, for a business or government customer, its trade
// licence number (e-invoicing later). Never an Emirates ID or a passport number. Archived, never
// deleted.
//
// Personal data: `customer.list` and `customer.get` need `customers.items.view`. A member who may name
// a customer on an order or a sale without that key picks them through `customer.pick` and
// `customer.similar`, which give them the name and the phone's last 4 digits only (`phone` null), and
// search by name only. Nothing here is a redaction category: who sees what is a permission.

const isoTimestamp = z.iso.datetime({ offset: true })

export const customerKindDto = z.enum(CUSTOMER_KINDS)
export const emirateDto = z.enum(EMIRATES)

/** ISO 3166-1 alpha-2, any case (stored in capitals); AE when left out. */
const countryInput = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, { message: 'a two-letter country code' })
  .default('AE')

const customerFields = {
  name: nameInput(CUSTOMER_NAME_MAX_LENGTH),
  kind: customerKindDto.default('individual'),
  phone: phoneInput,
  email: emailInput,
  trn: trnInput,
  /** A business or government customer's trade licence number (VALIDATION for a person). */
  tradeLicenceNo: optionalLine(CUSTOMER_LICENCE_MAX_LENGTH),
  addressLine: optionalLine(CUSTOMER_ADDRESS_MAX_LENGTH),
  city: optionalLine(CUSTOMER_CITY_MAX_LENGTH),
  /** One of the seven, only for an address in the UAE (VALIDATION otherwise). */
  emirate: emirateDto.nullish().transform((value) => value ?? null),
  country: countryInput,
  notes: notesInput,
}

interface CustomerShape {
  kind: (typeof CUSTOMER_KINDS)[number]
  tradeLicenceNo: string | null
  emirate: string | null
  country: string
}

const fitsKind = (c: CustomerShape) => c.tradeLicenceNo === null || customerMayHaveLicence(c.kind)
const fitsCountry = (c: CustomerShape) => c.emirate === null || c.country === 'AE'
const kindMessage = { message: 'a trade licence goes with a business or government customer' }
const countryMessage = { message: 'an emirate goes with an address in the UAE (AE)' }

/** `customer.create`: `id` is a client UUIDv7, so a retry with the same payload returns it. */
export const createCustomerInput = z
  .object({ id: zUuid, ...customerFields })
  .refine(fitsKind, kindMessage)
  .refine(fitsCountry, countryMessage)
export type CreateCustomerInput = z.input<typeof createCustomerInput>

/** `customer.update`: the whole record, `version` as read (CONFLICT when it changed). */
export const updateCustomerInput = z
  .object({ id: zUuid, version: z.int().positive(), ...customerFields })
  .refine(fitsKind, kindMessage)
  .refine(fitsCountry, countryMessage)
export type UpdateCustomerInput = z.input<typeof updateCustomerInput>

export const customerDto = z.object({
  id: zUuid,
  name: z.string(),
  kind: customerKindDto,
  phone: z.string().nullable(),
  email: z.string().nullable(),
  /** 15 digits. */
  trn: z.string().nullable(),
  tradeLicenceNo: z.string().nullable(),
  addressLine: z.string().nullable(),
  city: z.string().nullable(),
  emirate: emirateDto.nullable(),
  country: z.string(),
  notes: z.string().nullable(),
  /** When it was archived (hidden from pickers); null while active. */
  archivedAt: isoTimestamp.nullable(),
  version: z.int().positive(),
})
export type CustomerDto = z.infer<typeof customerDto>

/**
 * `customer.list` (customers.items.view): by name (names may repeat: then by id), with a cursor. The
 * search finds part of the name, or of the phone number (digits of either kind).
 */
export const customerListInput = z
  .object({
    search: z.string().trim().max(100).optional(),
    status: z.enum(['active', 'archived', 'all']).default('active'),
    cursor: z.string().min(1).max(500).optional(),
    limit: z.int().min(1).max(CUSTOMER_PAGE_SIZE_MAX).default(CUSTOMER_PAGE_SIZE),
  })
  .prefault({})
export type CustomerListInput = z.input<typeof customerListInput>

export const customerListDto = z.object({
  items: z.array(customerDto),
  nextCursor: z.string().nullable(),
})
export type CustomerListDto = z.infer<typeof customerListDto>

/**
 * A customer as a picker shows them: the name and, to tell two of the same name apart, the phone's
 * last 4 digits ("Ahmed · …4567"). `phone` (the whole number) only for a member with
 * customers.items.view; null otherwise.
 */
export const customerPickItemDto = z.object({
  id: zUuid,
  name: z.string(),
  kind: customerKindDto,
  phone: z.string().nullable(),
  phoneLast4: z.string().nullable(),
  archived: z.boolean(),
})
export type CustomerPickItemDto = z.infer<typeof customerPickItemDto>

/**
 * `customer.pick` (any key that names a customer: customers.items.view or .manage, entering orders
 * or sales, recording customer payments): active customers by name. The search finds part of the name
 * (and of the phone, for a member with customers.items.view). `ids`: customers a form names already
 * (archived ones too), listed first.
 */
export const customerPickInput = z
  .object({
    search: z.string().trim().max(100).optional(),
    ids: z.array(zUuid).max(CUSTOMER_PICK_MAX).default([]),
    limit: z.int().min(1).max(CUSTOMER_PICK_MAX).default(CUSTOMER_PICK_MAX),
  })
  .prefault({})
export type CustomerPickInput = z.input<typeof customerPickInput>

export const customerPickDto = z.object({ items: z.array(customerPickItemDto) })
export type CustomerPickDto = z.infer<typeof customerPickDto>

/**
 * `customer.similar` ("Did you mean Ahmed · 050…?", Q2): the customers whose name is the same name
 * (compared as people read it: app.name_key) and those whose names look alike, before a new one is
 * added. `excludeId`: the customer being edited.
 */
export const customerSimilarInput = z.object({
  name: nameInput(CUSTOMER_NAME_MAX_LENGTH),
  excludeId: zUuid.optional(),
})
export type CustomerSimilarInput = z.input<typeof customerSimilarInput>

export const customerSimilarDto = z.object({
  /** Customers with the same name (archived ones too), by name. */
  same: z.array(customerPickItemDto),
  /** Up to 3 whose names look alike, the closest first. */
  similar: z.array(customerPickItemDto),
})
export type CustomerSimilarDto = z.infer<typeof customerSimilarDto>
