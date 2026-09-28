import type {
  catalogIdInput,
  catalogListInput,
  createSupplierInput,
  SupplierDto,
  SupplierListDto,
  updateSupplierInput,
} from '@bizcost/contracts'
import { createIdempotent, suppliers, type Tx } from '@bizcost/db'
import { and, asc, eq, ilike, isNotNull, isNull, sql, type SQL } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import {
  containsPattern,
  decodeCursor,
  encodeCursor,
  requestHashOf,
  withUniqueName,
} from './catalog'

// Suppliers (ROADMAP.md M2 Step 3; DATA_MODEL.md §6, D-112, D-113, D-123): one record per supplier,
// separate from customers, reused by purchases, returns and credit notes. Module `suppliers`,
// suppliers.items.view to read and suppliers.items.manage to write (the router checks both). The same
// shape as the catalog: one name per business (case ignored, archived ones included), lists by name
// with a cursor, idempotent creates, versioned updates of the whole record, archive and unarchive,
// never a delete.

type ListInput = z.output<typeof catalogListInput>
type IdInput = z.output<typeof catalogIdInput>
type CreateInput = z.output<typeof createSupplierInput>
type UpdateInput = z.output<typeof updateSupplierInput>

/** The unique index on (business_id, lower(name)) of live suppliers. */
const NAME_KEY = 'suppliers_name_key'

const supplierColumns = {
  id: suppliers.id,
  name: suppliers.name,
  phone: suppliers.phone,
  email: suppliers.email,
  trn: suppliers.trn,
  notes: suppliers.notes,
  archivedAt: suppliers.archivedAt,
  version: suppliers.version,
}

type SupplierRow = {
  id: string
  name: string
  phone: string | null
  email: string | null
  trn: string | null
  notes: string | null
  archivedAt: Date | null
  version: number
}

function toDto(row: SupplierRow): SupplierDto {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    trn: row.trn,
    notes: row.notes,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
  }
}

async function findSupplier(tx: Tx, businessId: string, id: string) {
  const [row] = await tx
    .select(supplierColumns)
    .from(suppliers)
    .where(
      and(eq(suppliers.businessId, businessId), eq(suppliers.id, id), isNull(suppliers.deletedAt)),
    )
  return row
}

async function loadSupplier(tx: Tx, businessId: string, id: string): Promise<SupplierDto> {
  const row = await findSupplier(tx, businessId, id)
  if (!row) throw new AppError('not_found')
  return toDto(row)
}

/** `supplier.list`: a page by name (case ignored). */
export async function listSuppliers(ctx: BusinessCtx, input: ListInput): Promise<SupplierListDto> {
  const conditions: SQL[] = [eq(suppliers.businessId, ctx.businessId), isNull(suppliers.deletedAt)]
  if (input.status === 'active') conditions.push(isNull(suppliers.archivedAt))
  if (input.status === 'archived') conditions.push(isNotNull(suppliers.archivedAt))
  if (input.search) conditions.push(ilike(suppliers.name, containsPattern(input.search)))
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor)
    conditions.push(
      sql`(lower(${suppliers.name}), ${suppliers.id}) > (${cursor.key}, ${cursor.id}::uuid)`,
    )
  }
  return ctx.tx(async (tx) => {
    const rows = await tx
      .select({ ...supplierColumns, sortKey: sql<string>`lower(${suppliers.name})` })
      .from(suppliers)
      .where(and(...conditions))
      .orderBy(sql`lower(${suppliers.name})`, asc(suppliers.id))
      .limit(input.limit + 1)
    const page = rows.slice(0, input.limit)
    const last = page.at(-1)
    return {
      items: page.map(toDto),
      nextCursor:
        rows.length > input.limit && last ? encodeCursor({ key: last.sortKey, id: last.id }) : null,
    }
  })
}

/** `supplier.get`: NOT_FOUND unless it is a supplier of this business. */
export function getSupplier(ctx: BusinessCtx, input: IdInput): Promise<SupplierDto> {
  return ctx.tx((tx) => loadSupplier(tx, ctx.businessId, input.id))
}

/**
 * `supplier.create`: idempotent on the client's id (the same payload again returns the supplier; an
 * id used by another create or another business is CONFLICT). NAME_TAKEN when the business already
 * has a supplier with that name (archived ones included).
 */
export async function createSupplier(ctx: BusinessCtx, input: CreateInput): Promise<SupplierDto> {
  const values = {
    name: input.name,
    phone: input.phone,
    email: input.email,
    trn: input.trn,
    notes: input.notes,
  }
  return withUniqueName(NAME_KEY, () =>
    ctx.tx(async (tx) => {
      const { row } = await createIdempotent(tx, suppliers, {
        id: input.id,
        businessId: ctx.businessId,
        ...values,
        requestHash: requestHashOf(values),
      })
      if (row.deletedAt !== null)
        throw new AppError('conflict', { message: 'supplier was removed' })
      return loadSupplier(tx, ctx.businessId, row.id)
    }),
  )
}

/** `supplier.update`: the whole record, `version` as read (CONFLICT when it changed since). */
export async function updateSupplier(ctx: BusinessCtx, input: UpdateInput): Promise<SupplierDto> {
  return withUniqueName(NAME_KEY, () =>
    ctx.tx(async (tx) => {
      const [row] = await tx
        .update(suppliers)
        .set({
          name: input.name,
          phone: input.phone,
          email: input.email,
          trn: input.trn,
          notes: input.notes,
        })
        .where(
          and(
            eq(suppliers.businessId, ctx.businessId),
            eq(suppliers.id, input.id),
            isNull(suppliers.deletedAt),
            eq(suppliers.version, input.version),
          ),
        )
        .returning({ id: suppliers.id })
      if (!row) {
        if (await findSupplier(tx, ctx.businessId, input.id)) throw new AppError('conflict')
        throw new AppError('not_found')
      }
      return loadSupplier(tx, ctx.businessId, input.id)
    }),
  )
}

async function setArchived(
  ctx: BusinessCtx,
  input: IdInput,
  archived: boolean,
): Promise<SupplierDto> {
  return ctx.tx(async (tx) => {
    await tx
      .update(suppliers)
      .set({ archivedAt: archived ? sql`now()` : null })
      .where(
        and(
          eq(suppliers.businessId, ctx.businessId),
          eq(suppliers.id, input.id),
          isNull(suppliers.deletedAt),
          archived ? isNull(suppliers.archivedAt) : isNotNull(suppliers.archivedAt),
        ),
      )
    return loadSupplier(tx, ctx.businessId, input.id)
  })
}

/** `supplier.archive`: hidden from pickers from now on; its purchases keep it (never deleted). */
export function archiveSupplier(ctx: BusinessCtx, input: IdInput): Promise<SupplierDto> {
  return setArchived(ctx, input, true)
}

/** `supplier.unarchive`: back in the pickers. */
export function unarchiveSupplier(ctx: BusinessCtx, input: IdInput): Promise<SupplierDto> {
  return setArchived(ctx, input, false)
}
