import type {
  catalogIdInput,
  createCustomerInput,
  CustomerDto,
  customerListInput,
  CustomerListDto,
  CustomerPickDto,
  customerPickInput,
  CustomerPickItemDto,
  CustomerSimilarDto,
  customerSimilarInput,
  updateCustomerInput,
} from '@bizcost/contracts'
import { createIdempotent, customers, type Tx } from '@bizcost/db'
import {
  can,
  matchNames,
  nameKey,
  normalizeDigits,
  phoneLast4,
  type CustomerKind,
  type Emirate,
} from '@bizcost/domain'
import { sql, type SQL } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { containsPattern, decodeCursor, encodeCursor, requestHashOf } from './catalog'
import { isoOf, uuidArray } from './stock'

// Customers (ROADMAP.md M3 Step 5; DATA_MODEL.md §6; D-112, D-113, D-123, D-133; the owner's answer
// Q2 = A of D-218): one record per customer, apart from suppliers, reused by orders, sales and
// payments. Module `customers`. The shape of suppliers' (lists by name with a cursor, idempotent
// creates, versioned whole updates, archive and unarchive, never a delete), but a name may repeat:
// "Did you mean" lists the customers of the same name (app.name_key) and those alike, never refuses.
//
// Personal data (Q2, Q10): customer.list and customer.get need customers.items.view (the router).
// A member who names a customer without it (the Employee's order picker) gets only the name and the
// phone's last 4 digits (customer.pick, customer.similar), and searches by name only: no answer they
// get depends on the phone (D-209). A member who adds a customer without it gets back what they typed.

type ListInput = z.output<typeof customerListInput>
type IdInput = z.output<typeof catalogIdInput>
type CreateInput = z.output<typeof createCustomerInput>
type UpdateInput = z.output<typeof updateCustomerInput>
type PickInput = z.output<typeof customerPickInput>
type SimilarInput = z.output<typeof customerSimilarInput>

/** The caller sees customers' details (the whole phone, email, TRN, address, notes). */
export function seesCustomers(ctx: BusinessCtx): boolean {
  return can(ctx.access.effective, 'customers.items.view')
}

interface CustomerRecord extends Record<string, unknown> {
  id: string
  name: string
  kind: CustomerKind
  phone: string | null
  email: string | null
  trn: string | null
  trade_licence_no: string | null
  address_line: string | null
  city: string | null
  emirate: Emirate | null
  country: string
  notes: string | null
  archived_at: Date | string | null
  version: number
  sort_key: string
}

const COLUMNS = sql`c.id, c.name, c.kind, c.phone, c.email, c.trn, c.trade_licence_no, c.address_line,
  c.city, c.emirate, trim(c.country) as country, c.notes, c.archived_at, c.version,
  lower(c.name) as sort_key`

function toDto(row: CustomerRecord): CustomerDto {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    phone: row.phone,
    email: row.email,
    trn: row.trn,
    tradeLicenceNo: row.trade_licence_no,
    addressLine: row.address_line,
    city: row.city,
    emirate: row.emirate,
    country: row.country,
    notes: row.notes,
    archivedAt: isoOf(row.archived_at),
    version: row.version,
  }
}

/** A customer as a picker shows them: the whole phone only for a member who sees customers. */
export function pickItemOf(
  row: { id: string; name: string; kind: CustomerKind; phone: string | null; archived: boolean },
  sees: boolean,
): CustomerPickItemDto {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    phone: sees ? row.phone : null,
    phoneLast4: phoneLast4(row.phone),
    archived: row.archived,
  }
}

async function findCustomer(tx: Tx, businessId: string, id: string) {
  const [row] = (await tx.execute(sql`
    select ${COLUMNS} from app.customers c
     where c.business_id = ${businessId} and c.id = ${id} and c.deleted_at is null
  `)) as unknown as CustomerRecord[]
  return row
}

async function loadCustomer(tx: Tx, businessId: string, id: string): Promise<CustomerDto> {
  const row = await findCustomer(tx, businessId, id)
  if (!row) throw new AppError('not_found')
  return toDto(row)
}

/** The digits of a search, when it has at least 3 (a phone search): Arabic-Indic read as 0–9. */
function phoneDigits(search: string): string | null {
  const digits = normalizeDigits(search).replace(/\D/g, '')
  return digits.length >= 3 ? digits : null
}

/** A phone's digits in SQL (for a search by part of the number, however it was typed). */
const PHONE_DIGITS = sql`regexp_replace(translate(coalesce(c.phone, ''),
  '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^0-9]', '', 'g')`

/**
 * `customer.list` (customers.items.view): a page by name (case ignored; names may repeat, then by id).
 * The search finds part of the name, or part of the phone number.
 */
export function listCustomers(ctx: BusinessCtx, input: ListInput): Promise<CustomerListDto> {
  const parts: SQL[] = [sql`c.business_id = ${ctx.businessId}`, sql`c.deleted_at is null`]
  if (input.status === 'active') parts.push(sql`c.archived_at is null`)
  if (input.status === 'archived') parts.push(sql`c.archived_at is not null`)
  if (input.search) {
    const digits = phoneDigits(input.search)
    const byName = sql`c.name ilike ${containsPattern(input.search)}`
    parts.push(
      digits ? sql`(${byName} or ${PHONE_DIGITS} like ${`%${digits}%`})` : sql`(${byName})`,
    )
  }
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor)
    parts.push(sql`(lower(c.name), c.id) > (${cursor.key}, ${cursor.id}::uuid)`)
  }
  return ctx.tx(async (tx) => {
    const rows = (await tx.execute(sql`
      select ${COLUMNS} from app.customers c
       where ${sql.join(parts, sql` and `)}
       order by lower(c.name), c.id
       limit ${input.limit + 1}
    `)) as unknown as CustomerRecord[]
    const page = rows.slice(0, input.limit)
    const last = page.at(-1)
    return {
      items: page.map(toDto),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ key: last.sort_key, id: last.id })
          : null,
    }
  })
}

/** `customer.get` (customers.items.view): NOT_FOUND unless it is a customer of this business. */
export function getCustomer(ctx: BusinessCtx, input: IdInput): Promise<CustomerDto> {
  return ctx.tx((tx) => loadCustomer(tx, ctx.businessId, input.id))
}

function valuesOf(input: Omit<CreateInput, 'id'>) {
  return {
    name: input.name,
    kind: input.kind,
    phone: input.phone,
    email: input.email,
    trn: input.trn,
    tradeLicenceNo: input.tradeLicenceNo,
    addressLine: input.addressLine,
    city: input.city,
    emirate: input.emirate,
    country: input.country,
    notes: input.notes,
  }
}

/** A customer as the caller typed them when adding them (a new record: version 1, not archived). */
function typedCustomer(id: string, values: ReturnType<typeof valuesOf>): CustomerDto {
  return {
    id,
    name: values.name,
    kind: values.kind,
    phone: values.phone,
    email: values.email,
    trn: values.trn,
    tradeLicenceNo: values.tradeLicenceNo,
    addressLine: values.addressLine,
    city: values.city,
    emirate: values.emirate,
    country: values.country,
    notes: values.notes,
    archivedAt: null,
    version: 1,
  }
}

/**
 * `customer.create` (customers.items.manage): idempotent on the client's id (the same payload again
 * returns it; an id used by another create or another business is CONFLICT). A name the business
 * already has is fine (Q2): `customer.similar` says so first. A member who sees customers gets the
 * customer as it is; one without customers.items.view gets back only what they typed, also when
 * they send the same create again after someone completed the customer's details (D-273).
 */
export function createCustomer(ctx: BusinessCtx, input: CreateInput): Promise<CustomerDto> {
  const { id, ...fields } = input
  const values = valuesOf(fields)
  return ctx.tx(async (tx) => {
    const { row } = await createIdempotent(tx, customers, {
      id,
      businessId: ctx.businessId,
      ...values,
      requestHash: requestHashOf(values),
    })
    if (row.deletedAt !== null) throw new AppError('conflict', { message: 'customer was removed' })
    if (!seesCustomers(ctx)) return typedCustomer(row.id, values)
    return loadCustomer(tx, ctx.businessId, row.id)
  })
}

/**
 * `customer.update` (customers.items.view and .manage): the whole record, `version` as read (CONFLICT
 * when it changed since).
 */
export function updateCustomer(ctx: BusinessCtx, input: UpdateInput): Promise<CustomerDto> {
  const { id, version, ...fields } = input
  const values = valuesOf(fields)
  return ctx.tx(async (tx) => {
    const updated = (await tx.execute(sql`
      update app.customers c
         set name = ${values.name}, kind = ${values.kind}, phone = ${values.phone},
             email = ${values.email}, trn = ${values.trn},
             trade_licence_no = ${values.tradeLicenceNo}, address_line = ${values.addressLine},
             city = ${values.city}, emirate = ${values.emirate}, country = ${values.country},
             notes = ${values.notes}
       where c.business_id = ${ctx.businessId} and c.id = ${id} and c.deleted_at is null
         and c.version = ${version}
      returning c.id
    `)) as unknown as { id: string }[]
    if (updated.length === 0) {
      if (await findCustomer(tx, ctx.businessId, id)) throw new AppError('conflict')
      throw new AppError('not_found')
    }
    return loadCustomer(tx, ctx.businessId, id)
  })
}

function setArchived(ctx: BusinessCtx, input: IdInput, archived: boolean): Promise<CustomerDto> {
  return ctx.tx(async (tx) => {
    await tx.execute(sql`
      update app.customers c
         set archived_at = ${archived ? sql`now()` : sql`null`}
       where c.business_id = ${ctx.businessId} and c.id = ${input.id} and c.deleted_at is null
         and ${archived ? sql`c.archived_at is null` : sql`c.archived_at is not null`}
    `)
    return loadCustomer(tx, ctx.businessId, input.id)
  })
}

/** `customer.archive`: hidden from pickers; its orders, sales and payments keep it. */
export function archiveCustomer(ctx: BusinessCtx, input: IdInput): Promise<CustomerDto> {
  return setArchived(ctx, input, true)
}

/** `customer.unarchive`: back in the pickers. */
export function unarchiveCustomer(ctx: BusinessCtx, input: IdInput): Promise<CustomerDto> {
  return setArchived(ctx, input, false)
}

interface PickRecord extends Record<string, unknown> {
  id: string
  name: string
  kind: CustomerKind
  phone: string | null
  archived: boolean
}

/**
 * `customer.pick`: the active customers by name for a picker (and `ids`, those a form names already,
 * archived ones too, first). The search finds part of the name; part of the phone only for a member
 * who sees customers. A member without customers.items.view gets the name and the phone's last 4
 * digits only.
 */
export function pickCustomers(ctx: BusinessCtx, input: PickInput): Promise<CustomerPickDto> {
  const sees = seesCustomers(ctx)
  const filters: SQL[] = [
    sql`c.business_id = ${ctx.businessId}`,
    sql`c.deleted_at is null`,
    sql`c.archived_at is null`,
  ]
  if (input.search) {
    const digits = sees ? phoneDigits(input.search) : null
    const byName = sql`c.name ilike ${containsPattern(input.search)}`
    filters.push(
      digits ? sql`(${byName} or ${PHONE_DIGITS} like ${`%${digits}%`})` : sql`(${byName})`,
    )
  }
  return ctx.tx(async (tx) => {
    const named =
      input.ids.length === 0
        ? []
        : ((await tx.execute(sql`
            select c.id, c.name, c.kind, c.phone, c.archived_at is not null as archived
              from app.customers c
             where c.business_id = ${ctx.businessId} and c.deleted_at is null
               and c.id = any(${uuidArray(input.ids)})
             order by lower(c.name), c.id
          `)) as unknown as PickRecord[])
    const rows = (await tx.execute(sql`
      select c.id, c.name, c.kind, c.phone, false as archived
        from app.customers c
       where ${sql.join(filters, sql` and `)}
       order by lower(c.name), c.id
       limit ${input.limit}
    `)) as unknown as PickRecord[]
    // Every id named is a customer of this business (NOT_FOUND otherwise).
    if (named.length !== new Set(input.ids).size) throw new AppError('not_found')
    const seen = new Set(named.map((r) => r.id))
    return {
      items: [...named, ...rows.filter((r) => !seen.has(r.id))]
        .slice(0, Math.max(input.limit, named.length))
        .map((r) => pickItemOf(r, sees)),
    }
  })
}

/**
 * `customer.similar` ("Did you mean Ahmed · 050…?", Q2): the customers whose name is the same name
 * (app.name_key, archived ones too), then up to 3 whose names look alike (matchNames over those that
 * share the start of the name), excluding `excludeId`.
 */
export function similarCustomers(
  ctx: BusinessCtx,
  input: SimilarInput,
): Promise<CustomerSimilarDto> {
  const sees = seesCustomers(ctx)
  const key = nameKey(input.name)
  const exclude = input.excludeId ? sql`and c.id <> ${input.excludeId}` : sql``
  // The first letters of the name, as the database folds them, to bring the likely ones.
  const prefix = Array.from(key).slice(0, 2).join('')
  return ctx.tx(async (tx) => {
    if (input.excludeId) {
      const [own] = (await tx.execute(sql`
        select c.id from app.customers c
         where c.business_id = ${ctx.businessId} and c.id = ${input.excludeId}
           and c.deleted_at is null
      `)) as unknown as { id: string }[]
      if (!own) throw new AppError('not_found')
    }
    const same = (await tx.execute(sql`
      select c.id, c.name, c.kind, c.phone, c.archived_at is not null as archived
        from app.customers c
       where c.business_id = ${ctx.businessId} and c.deleted_at is null
         and app.name_key(c.name) = app.name_key(${input.name}) ${exclude}
       order by lower(c.name), c.id
       limit 20
    `)) as unknown as PickRecord[]
    const candidates =
      prefix === ''
        ? []
        : ((await tx.execute(sql`
            select c.id, c.name, c.kind, c.phone, c.archived_at is not null as archived
              from app.customers c
             where c.business_id = ${ctx.businessId} and c.deleted_at is null
               and c.archived_at is null ${exclude}
               and app.name_key(c.name) <> app.name_key(${input.name})
               and (app.name_key(c.name) like ${`${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`}
                 or app.name_key(c.name) like ${containsPattern(key)}
                 or app.name_key(${input.name}) like '%' || app.name_key(c.name) || '%')
             order by lower(c.name), c.id
             limit 200
          `)) as unknown as PickRecord[])
    const { similar } = matchNames(input.name, candidates, (r) => r.name)
    return {
      same: same.map((r) => pickItemOf(r, sees)),
      similar: similar.map((r) => pickItemOf(r, sees)),
    }
  })
}

/**
 * A customer named on an order, a sale or a payment: a live customer of the business (NOT_FOUND
 * otherwise); an archived one only when the record already names them (`current`; VALIDATION).
 */
export async function resolveCustomer(
  tx: Tx,
  businessId: string,
  customerId: string | null,
  current: string | null,
): Promise<string | null> {
  if (customerId === null) return null
  const [row] = (await tx.execute(sql`
    select c.id, c.archived_at is not null as archived from app.customers c
     where c.business_id = ${businessId} and c.id = ${customerId} and c.deleted_at is null
  `)) as unknown as { id: string; archived: boolean }[]
  if (!row) throw new AppError('not_found')
  if (row.archived && row.id !== current) {
    throw new AppError('validation', { message: 'customerId: archived' })
  }
  return row.id
}
