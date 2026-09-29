import type {
  catalogIdInput,
  CostCategoryDto,
  costCategoryListInput,
  CostCategoryListDto,
  createCostCategoryInput,
  updateCostCategoryInput,
} from '@bizcost/contracts'
import { costCategories, createIdempotent, type Tx } from '@bizcost/db'
import { newId, STARTER_COST_CATEGORIES, type Locale } from '@bizcost/domain'
import { createI18n, type I18nKey } from '@bizcost/i18n'
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

// The categories that expenses and running costs share (ROADMAP.md M2 Step 5; D-116, D-167). Every
// business starts with the owner's list (rent, electricity, …, other), named in its language when it
// is set up; then they are plain data. The catalog's shape: one name per business compared the way
// people read it (app.name_key, archived ones included; NAME_TAKEN), lists by name with a cursor,
// idempotent creates, versioned renames, archive and unarchive, never a delete. The routers let a
// member who may see expenses or running costs list them, and one who may enter expenses or change
// running costs add, rename or archive them (each with its module on).

type ListInput = z.output<typeof costCategoryListInput>
type IdInput = z.output<typeof catalogIdInput>
type CreateInput = z.output<typeof createCostCategoryInput>
type UpdateInput = z.output<typeof updateCostCategoryInput>

/** The unique index on (business_id, app.name_key(name)) of live categories. */
const NAME_KEY = 'cost_categories_name_key'

const columns = {
  id: costCategories.id,
  name: costCategories.name,
  archivedAt: costCategories.archivedAt,
  version: costCategories.version,
}

type Row = { id: string; name: string; archivedAt: Date | null; version: number }

function toDto(row: Row): CostCategoryDto {
  return {
    id: row.id,
    name: row.name,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
  }
}

/**
 * The starter categories of a new business, named in its language (Smart Setup; D-113: then plain
 * data). The expenses_security migration gave businesses that existed before the same names.
 */
export async function seedCostCategories(
  tx: Tx,
  businessId: string,
  locale: Locale,
): Promise<void> {
  const i18n = createI18n({ locale, namespaces: ['setup'] })
  await tx.insert(costCategories).values(
    STARTER_COST_CATEGORIES.map((key) => ({
      id: newId(),
      businessId,
      name: i18n.t(`setup.cost_categories.${key}` as I18nKey),
    })),
  )
}

async function find(tx: Tx, businessId: string, id: string) {
  const [row] = await tx
    .select(columns)
    .from(costCategories)
    .where(
      and(
        eq(costCategories.businessId, businessId),
        eq(costCategories.id, id),
        isNull(costCategories.deletedAt),
      ),
    )
  return row
}

async function load(tx: Tx, businessId: string, id: string): Promise<CostCategoryDto> {
  const row = await find(tx, businessId, id)
  if (!row) throw new AppError('not_found')
  return toDto(row)
}

/**
 * The category an expense or a running cost names: a category of the business (NOT_FOUND
 * otherwise), locked FOR SHARE until the save commits. An archived one only when the record already
 * has it (`current`): a new choice must be an active category (VALIDATION).
 */
export async function assertCategory(
  tx: Tx,
  businessId: string,
  categoryId: string,
  current: string | null = null,
): Promise<{ id: string; name: string }> {
  const [row] = (await tx.execute(sql`
    select c.id, c.name, c.archived_at from app.cost_categories c
     where c.business_id = ${businessId} and c.id = ${categoryId} and c.deleted_at is null
       for share
  `)) as unknown as { id: string; name: string; archived_at: Date | string | null }[]
  if (!row) throw new AppError('not_found')
  if (row.archived_at !== null && row.id !== current) {
    throw new AppError('validation', { message: 'categoryId: archived' })
  }
  return { id: row.id, name: row.name }
}

/** A filter names a category of this business (NOT_FOUND otherwise), archived ones too. */
export async function assertCategoryExists(tx: Tx, businessId: string, categoryId: string) {
  const [row] = (await tx.execute(sql`
    select c.id from app.cost_categories c
     where c.business_id = ${businessId} and c.id = ${categoryId} and c.deleted_at is null
  `)) as unknown as { id: string }[]
  if (!row) throw new AppError('not_found')
}

/** `costCategory.list`: a page by name (case ignored). */
export async function listCostCategories(
  ctx: BusinessCtx,
  input: ListInput,
): Promise<CostCategoryListDto> {
  const conditions: SQL[] = [
    eq(costCategories.businessId, ctx.businessId),
    isNull(costCategories.deletedAt),
  ]
  if (input.status === 'active') conditions.push(isNull(costCategories.archivedAt))
  if (input.status === 'archived') conditions.push(isNotNull(costCategories.archivedAt))
  if (input.search) conditions.push(ilike(costCategories.name, containsPattern(input.search)))
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor)
    conditions.push(
      sql`(lower(${costCategories.name}), ${costCategories.id}) > (${cursor.key}, ${cursor.id}::uuid)`,
    )
  }
  return ctx.tx(async (tx) => {
    const rows = await tx
      .select({ ...columns, sortKey: sql<string>`lower(${costCategories.name})` })
      .from(costCategories)
      .where(and(...conditions))
      .orderBy(sql`lower(${costCategories.name})`, asc(costCategories.id))
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

/**
 * The live category with the same name as `name` as people read it (app.name_key), for NAME_TAKEN
 * to name it: the caller may see every category.
 */
async function sameNamed(ctx: BusinessCtx, name: string): Promise<string[]> {
  const rows = (await ctx.tx((tx) =>
    tx.execute(sql`
      select c.name from app.cost_categories c
       where c.business_id = ${ctx.businessId} and c.deleted_at is null
         and app.name_key(c.name) = app.name_key(${name})
       limit 1
    `),
  )) as unknown as { name: string }[]
  return rows.map((row) => row.name)
}

async function withName<T>(ctx: BusinessCtx, name: string, write: () => Promise<T>): Promise<T> {
  try {
    return await withUniqueName(NAME_KEY, write)
  } catch (error) {
    if (error instanceof AppError && error.appCode === 'name_taken') {
      throw new AppError('name_taken', { cause: error, names: await sameNamed(ctx, name) })
    }
    throw error
  }
}

/**
 * `costCategory.create`: idempotent on the client's id (the same payload again returns it; an id used
 * otherwise is CONFLICT). NAME_TAKEN (naming the category that has it) when the business already has
 * one with that name as people read it, archived ones included.
 */
export function createCostCategory(ctx: BusinessCtx, input: CreateInput): Promise<CostCategoryDto> {
  const values = { name: input.name }
  return withName(ctx, input.name, () =>
    ctx.tx(async (tx) => {
      const { row } = await createIdempotent(tx, costCategories, {
        id: input.id,
        businessId: ctx.businessId,
        ...values,
        requestHash: requestHashOf(values),
      })
      if (row.deletedAt !== null)
        throw new AppError('conflict', { message: 'category was removed' })
      return load(tx, ctx.businessId, row.id)
    }),
  )
}

/** `costCategory.update`: a new name, `version` as read (CONFLICT when it changed since). */
export function updateCostCategory(ctx: BusinessCtx, input: UpdateInput): Promise<CostCategoryDto> {
  return withName(ctx, input.name, () =>
    ctx.tx(async (tx) => {
      const [row] = await tx
        .update(costCategories)
        .set({ name: input.name })
        .where(
          and(
            eq(costCategories.businessId, ctx.businessId),
            eq(costCategories.id, input.id),
            isNull(costCategories.deletedAt),
            eq(costCategories.version, input.version),
          ),
        )
        .returning({ id: costCategories.id })
      if (!row) {
        if (await find(tx, ctx.businessId, input.id)) throw new AppError('conflict')
        throw new AppError('not_found')
      }
      return load(tx, ctx.businessId, input.id)
    }),
  )
}

function setArchived(ctx: BusinessCtx, input: IdInput, archived: boolean) {
  return ctx.tx(async (tx) => {
    await tx
      .update(costCategories)
      .set({ archivedAt: archived ? sql`now()` : null })
      .where(
        and(
          eq(costCategories.businessId, ctx.businessId),
          eq(costCategories.id, input.id),
          isNull(costCategories.deletedAt),
          archived ? isNull(costCategories.archivedAt) : isNotNull(costCategories.archivedAt),
        ),
      )
    return load(tx, ctx.businessId, input.id)
  })
}

/**
 * `costCategory.archive`: hidden from pickers from now on; the expenses and running costs that have
 * it keep it (never deleted).
 */
export function archiveCostCategory(ctx: BusinessCtx, input: IdInput): Promise<CostCategoryDto> {
  return setArchived(ctx, input, true)
}

/** `costCategory.unarchive`: back in the pickers. */
export function unarchiveCostCategory(ctx: BusinessCtx, input: IdInput): Promise<CostCategoryDto> {
  return setArchived(ctx, input, false)
}
