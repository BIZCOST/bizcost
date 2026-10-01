import type {
  createRunningCostInput,
  removeRunningCostInput,
  RunningCostDto,
  runningCostIdInput,
  runningCostListInput,
  RunningCostListDto,
  RunningCostResultDto,
  RunningCostStateDto,
  OkDto,
  updateRunningCostInput,
} from '@bizcost/contracts'
import { createIdempotent, runningCosts, type Tx } from '@bizcost/db'
import {
  fitsCurrency,
  isCurrencyCode,
  monthlyAmount,
  monthlyTotal,
  runningCostActiveOn,
  type RunningCostFrequency,
} from '@bizcost/domain'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { containsPattern, decodeCursor, encodeCursor, requestHashOf } from './catalog'
import { assertCategory, assertCategoryExists } from './cost-categories'
import { isoOf } from './stock'

// Running costs (ROADMAP.md M2 Step 5; D-116, D-169): "What do you pay to run your business?" A
// regular amount per period (weekly, monthly, quarterly or yearly) in a category shared with
// expenses, from a day and until a day (or still paid). Its monthly amount is worked out on read
// (monthlyAmount in @bizcost/domain: never rounded to the currency, D-107); product costs count them
// in each month's costs, for the days they ran (costPool, D-202). Never posted and never part of
// stock. Module `running_costs`: running_costs.items.view to read, .manage to add, change or remove
// one (the router checks them). Amounts are `cost` (D-165). A running cost entered by mistake is
// removed (soft-deleted, audited); one that stopped gets its last day.

type ListInput = z.output<typeof runningCostListInput>
type IdInput = z.output<typeof runningCostIdInput>
type CreateInput = z.output<typeof createRunningCostInput>
type UpdateInput = z.output<typeof updateRunningCostInput>
type RemoveInput = z.output<typeof removeRunningCostInput>

const invalid = (message: string) => new AppError('validation', { message })

interface Row extends Record<string, unknown> {
  id: string
  name: string
  category_id: string
  category_name: string
  amount: string
  frequency: RunningCostFrequency
  starts_on: string
  ends_on: string | null
  notes: string | null
  created_at: Date | string
  version: number
}

const selectColumns = sql`
  r.id, r.name, r.category_id, c.name as category_name, trim_scale(r.amount)::text as amount,
  r.frequency, r.starts_on::text as starts_on, r.ends_on::text as ends_on, r.notes, r.created_at,
  r.version`

function stateOf(row: Pick<Row, 'starts_on' | 'ends_on'>, today: string): RunningCostStateDto {
  if (row.starts_on > today) return 'upcoming'
  return runningCostActiveOn({ startsOn: row.starts_on, endsOn: row.ends_on }, today)
    ? 'active'
    : 'ended'
}

function toDto(row: Row, today: string): RunningCostDto {
  return {
    id: row.id,
    name: row.name,
    categoryId: row.category_id,
    categoryName: row.category_name,
    amount: row.amount,
    frequency: row.frequency,
    monthlyAmount: monthlyAmount(row.amount, row.frequency),
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    state: stateOf(row, today),
    notes: row.notes,
    createdAt: isoOf(row.created_at),
    version: row.version,
  }
}

/** Today in the business's time zone, and its currency. */
async function businessDay(tx: Tx, businessId: string) {
  const [row] = (await tx.execute(sql`
    select (now() at time zone b.timezone)::date::text as today, trim(b.currency) as currency
      from app.businesses b
     where b.id = ${businessId} and b.deleted_at is null
  `)) as unknown as { today: string; currency: string }[]
  if (!row) throw new AppError('forbidden')
  return row
}

async function readRunningCost(tx: Tx, businessId: string, id: string): Promise<RunningCostDto> {
  const { today } = await businessDay(tx, businessId)
  const [row] = (await tx.execute(sql`
    select ${selectColumns}
      from app.running_costs r
      join app.cost_categories c on c.business_id = r.business_id and c.id = r.category_id
     where r.business_id = ${businessId} and r.id = ${id} and r.deleted_at is null
  `)) as unknown as Row[]
  if (!row) throw new AppError('not_found')
  return toDto(row, today)
}

function result(data: RunningCostDto): RunningCostResultDto {
  return { data, meta: { redacted: [] } }
}

/** `runningCost.get`. */
export function getRunningCost(ctx: BusinessCtx, input: IdInput): Promise<RunningCostResultDto> {
  return ctx.tx(async (tx) => result(await readRunningCost(tx, ctx.businessId, input.id)))
}

/**
 * `runningCost.list`: a page by name (case ignored), filtered by state as of today, category or a
 * search in its name or its category's; with the monthly total of every running cost active today
 * (whatever the filters: what Step 6 shares over product costs).
 */
export function listRunningCosts(ctx: BusinessCtx, input: ListInput): Promise<RunningCostListDto> {
  return ctx.tx(async (tx) => {
    const { today, currency } = await businessDay(tx, ctx.businessId)
    const conditions = [sql`r.business_id = ${ctx.businessId}`, sql`r.deleted_at is null`]
    // Counted from its start up to the day before it stopped (runningCostActiveOn, D-176).
    const active = sql`r.starts_on <= ${today}::date and (r.ends_on is null or r.ends_on > ${today}::date)`
    if (input.state === 'active') conditions.push(active)
    if (input.state === 'upcoming') conditions.push(sql`r.starts_on > ${today}::date`)
    if (input.state === 'ended') conditions.push(sql`r.ends_on <= ${today}::date`)
    if (input.categoryId) {
      await assertCategoryExists(tx, ctx.businessId, input.categoryId)
      conditions.push(sql`r.category_id = ${input.categoryId}`)
    }
    if (input.search) {
      const pattern = containsPattern(input.search)
      conditions.push(sql`(r.name ilike ${pattern} or c.name ilike ${pattern})`)
    }
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor)
      conditions.push(sql`(lower(r.name), r.id) > (${cursor.key}, ${cursor.id}::uuid)`)
    }
    const rows = (await tx.execute(sql`
      select ${selectColumns}, lower(r.name) as sort_key
        from app.running_costs r
        join app.cost_categories c on c.business_id = r.business_id and c.id = r.category_id
       where ${sql.join(conditions, sql` and `)}
       order by lower(r.name), r.id
       limit ${input.limit + 1}
    `)) as unknown as (Row & { sort_key: string })[]
    const counted = (await tx.execute(sql`
      select trim_scale(r.amount)::text as amount, r.frequency
        from app.running_costs r
       where r.business_id = ${ctx.businessId} and r.deleted_at is null and ${active}
    `)) as unknown as { amount: string; frequency: RunningCostFrequency }[]
    const page = rows.slice(0, input.limit)
    const last = page.at(-1)
    return {
      data: {
        items: page.map((row) => toDto(row, today)),
        nextCursor:
          rows.length > input.limit && last
            ? encodeCursor({ key: last.sort_key, id: last.id })
            : null,
        currency,
        today,
        monthlyTotal: monthlyTotal(counted),
      },
      meta: { redacted: [] },
    }
  })
}

/** Checks what a running cost names and says (VALIDATION, NOT_FOUND); returns its columns. */
async function prepare(
  tx: Tx,
  ctx: BusinessCtx,
  input: Omit<CreateInput, 'id'>,
  currentCategoryId: string | null,
) {
  const { currency } = await businessDay(tx, ctx.businessId)
  if (!isCurrencyCode(currency)) throw invalid(`currency: ${currency} is not supported`)
  if (!fitsCurrency(input.amount, currency)) {
    throw invalid('amount: more decimals than the currency has')
  }
  await assertCategory(tx, ctx.businessId, input.categoryId, currentCategoryId)
  return {
    name: input.name,
    categoryId: input.categoryId,
    amount: input.amount,
    frequency: input.frequency,
    startsOn: input.startsOn,
    endsOn: input.endsOn,
    notes: input.notes,
  }
}

/**
 * `runningCost.create`: idempotent on the client's id (the same payload again returns it; an id used
 * otherwise is CONFLICT). The category must be an active category of the business (NOT_FOUND,
 * VALIDATION for an archived one); the amount at most the currency's decimals (VALIDATION).
 */
export function createRunningCost(
  ctx: BusinessCtx,
  input: CreateInput,
): Promise<RunningCostResultDto> {
  const { id, ...fields } = input
  return ctx.tx(async (tx) => {
    const values = await prepare(tx, ctx, fields, null)
    const { row } = await createIdempotent(tx, runningCosts, {
      id,
      businessId: ctx.businessId,
      ...values,
      requestHash: requestHashOf(fields),
    })
    if (row.deletedAt !== null) {
      throw new AppError('conflict', { message: 'running cost was removed' })
    }
    return result(await readRunningCost(tx, ctx.businessId, id))
  })
}

/**
 * `runningCost.update`: the whole record, `version` as read (CONFLICT when it changed since). Its
 * category may stay archived; a new one must be active.
 */
export function updateRunningCost(
  ctx: BusinessCtx,
  input: UpdateInput,
): Promise<RunningCostResultDto> {
  const { id, version, ...fields } = input
  return ctx.tx(async (tx) => {
    const [current] = (await tx.execute(sql`
      select r.category_id, r.version from app.running_costs r
       where r.business_id = ${ctx.businessId} and r.id = ${id} and r.deleted_at is null
         for update
    `)) as unknown as { category_id: string; version: number }[]
    if (!current) throw new AppError('not_found')
    if (current.version !== version) throw new AppError('conflict')
    const values = await prepare(tx, ctx, fields, current.category_id)
    await tx
      .update(runningCosts)
      .set(values)
      .where(and(eq(runningCosts.businessId, ctx.businessId), eq(runningCosts.id, id)))
    return result(await readRunningCost(tx, ctx.businessId, id))
  })
}

/**
 * `runningCost.remove`: one entered by mistake is taken out (soft-deleted, audited), `version` as
 * read. One that stopped is given its last day instead (update).
 */
export function removeRunningCost(ctx: BusinessCtx, input: RemoveInput): Promise<OkDto> {
  return ctx.tx(async (tx) => {
    const [row] = await tx
      .update(runningCosts)
      .set({ deletedAt: sql`now()` })
      .where(
        and(
          eq(runningCosts.businessId, ctx.businessId),
          eq(runningCosts.id, input.id),
          isNull(runningCosts.deletedAt),
          eq(runningCosts.version, input.version),
        ),
      )
      .returning({ id: runningCosts.id })
    if (!row) {
      const [live] = (await tx.execute(sql`
        select r.id from app.running_costs r
         where r.business_id = ${ctx.businessId} and r.id = ${input.id} and r.deleted_at is null
      `)) as unknown as { id: string }[]
      throw new AppError(live ? 'conflict' : 'not_found')
    }
    return { ok: true as const }
  })
}
