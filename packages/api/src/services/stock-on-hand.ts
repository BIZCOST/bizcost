import type {
  stockCardInput,
  StockCardDto,
  StockCardEntryDto,
  stockListInput,
  StockListDto,
  StockMaterialDto,
  stockUntrackedInput,
  StockUntrackedDto,
} from '@bizcost/contracts'
import type { Tx } from '@bizcost/db'
import {
  can,
  canAccessLocation,
  costOfQty,
  costRatio,
  STANDARD_UNITS,
  sumDecimals,
  type Dimension,
  type StandardUnit,
} from '@bizcost/domain'
import { sql, type SQL } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { containsPattern, decodeCursor, encodeCursor } from './catalog'
import { isoOf, uuidArray } from './stock'

// Stock on hand and the stock card (ROADMAP.md M4 Step 2; D-339, D-340). Module `inventory` with
// keeps_stock, inventory.stock.view (the router checks them). Only materials whose stock is tracked
// (from their first count, materials.stock_tracked_from) show: before it a material's book is its
// purchases alone, which says nothing about what is on the shelf (D-115, D-219). On hand per branch is
// the balance (stock_balances, D-114 rule 5); value and average are the material's one cost row
// (material_costs, D-006). A member limited to some branches sees only theirs (D-234): their branches'
// quantities, values (each branch's quantity × the average) and movements.
//
// Sensitive: values and averages are `cost` (the redact middleware removes them without the costs
// switch); nothing here filters or sorts by them (D-209).

type ListInput = z.output<typeof stockListInput>
type UntrackedInput = z.output<typeof stockUntrackedInput>
type CardInput = z.output<typeof stockCardInput>

// ---------------------------------------------------------------------------------------------------
// Shared by stock and counts
// ---------------------------------------------------------------------------------------------------

/** The caller manages counts (inventory.counts.manage): starts, reviews, finalizes, reverses. */
export function managesCounts(ctx: BusinessCtx): boolean {
  return can(ctx.access.effective, 'inventory.counts.manage')
}

/** The caller sees stock (inventory.stock.view, or managing counts, which needs it). */
export function seesStock(ctx: BusinessCtx): boolean {
  return can(ctx.access.effective, 'inventory.stock.view') || managesCounts(ctx)
}

/** The caller fills counts (inventory.counts.enter, or managing them). */
export function entersCounts(ctx: BusinessCtx): boolean {
  return can(ctx.access.effective, 'inventory.counts.enter') || managesCounts(ctx)
}

/** A branch the caller works in (FORBIDDEN otherwise, D-234). */
export function assertBranch(ctx: BusinessCtx, locationId: string): void {
  if (!canAccessLocation(ctx.access.locationScope, locationId)) {
    throw new AppError('forbidden', { message: 'not one of your branches' })
  }
}

/** What covers every branch (a first count) is for a member who works in every branch. */
export function assertEveryBranch(ctx: BusinessCtx): void {
  if (!ctx.access.locationScope.all) {
    throw new AppError('forbidden', { message: 'not one of your branches' })
  }
}

/**
 * A branch a list is filtered by: one the caller works in (FORBIDDEN otherwise), and a location of
 * this business (NOT_FOUND otherwise; a removed one still holds its history).
 */
export async function assertBranchOf(tx: Tx, ctx: BusinessCtx, locationId: string): Promise<void> {
  assertBranch(ctx, locationId)
  const [row] = (await tx.execute(sql`
    select l.id from app.locations l
     where l.business_id = ${ctx.businessId} and l.id = ${locationId}
  `)) as unknown as { id: string }[]
  if (!row) throw new AppError('not_found')
}

/** `column` (a location id) is one of the caller's branches; nothing when they work in every one. */
export function inScope(ctx: BusinessCtx, column: SQL): SQL {
  const scope = ctx.access.locationScope
  return scope.all ? sql`true` : sql`${column} = any(${uuidArray([...scope.ids])})`
}

interface MaterialRecord extends Record<string, unknown> {
  id: string
  name: string
  dimension: Dimension
  unit: StandardUnit
  archived: boolean
  units: {
    id: string
    kind: 'pack' | 'cross'
    name: string | null
    unit: StandardUnit | null
    qty: string
    of_unit: StandardUnit | null
    of_pack_id: string | null
  }[]
}

/** The materials of the business among `ids` as stock answers carry them, by id. */
export async function stockMaterialsOf(
  tx: Tx,
  businessId: string,
  ids: readonly string[],
): Promise<Map<string, StockMaterialDto>> {
  const unique = [...new Set(ids)]
  const found = new Map<string, StockMaterialDto>()
  if (unique.length === 0) return found
  const records = (await tx.execute(sql`
    select m.id, m.name, m.dimension, m.unit, m.archived_at is not null as archived,
           coalesce((
             select jsonb_agg(jsonb_build_object(
                      'id', u.id, 'kind', u.kind, 'name', u.name, 'unit', u.unit,
                      'qty', trim_scale(u.qty)::text, 'of_unit', u.of_unit,
                      'of_pack_id', u.of_pack_id) order by u.created_at, u.id)
               from app.material_units u
              where u.business_id = m.business_id and u.material_id = m.id and u.deleted_at is null
           ), '[]'::jsonb) as units
      from app.materials m
     where m.business_id = ${businessId} and m.id = any(${uuidArray(unique)})
       and m.deleted_at is null
  `)) as unknown as MaterialRecord[]
  for (const r of records) {
    found.set(r.id, {
      id: r.id,
      name: r.name,
      dimension: r.dimension,
      unit: r.unit,
      packs: r.units
        .filter((u) => u.kind === 'pack')
        .map((u) => ({
          id: u.id,
          name: u.name ?? '',
          qty: u.qty,
          ofUnit: u.of_unit,
          ofPackId: u.of_pack_id,
        })),
      crossFactors: r.units
        .filter((u) => u.kind === 'cross')
        .map((u) => ({ id: u.id, unit: u.unit ?? 'g', qty: u.qty, ofUnit: u.of_unit ?? 'g' })),
      archived: r.archived,
    })
  }
  return found
}

/** One base unit's average said per one of the material's unit (null without an average). */
export function perUnitOf(avgCost: string | null, unit: StandardUnit): string | null {
  return avgCost === null ? null : costRatio([avgCost, STANDARD_UNITS[unit].factor], ['1'])
}

// ---------------------------------------------------------------------------------------------------
// stock.list
// ---------------------------------------------------------------------------------------------------

interface ItemRecord extends Record<string, unknown> {
  id: string
  sort_key: string
  unit: StandardUnit
  tracked_from: string
  qty: string | null
  value: string | null
  avg_cost: string | null
}

interface BranchRecord extends Record<string, unknown> {
  material_id: string
  location_id: string
  location_name: string
  qty: string
  last_counted_on: string | null
}

/**
 * `stock.list`: the tracked materials by name (a search in their names), each with on hand in every
 * branch the caller works in (or the one asked for), the last finalized count there, and with the
 * costs switch what it is worth and its average; and the live branches the caller works in.
 */
export async function listStock(ctx: BusinessCtx, input: ListInput): Promise<StockListDto> {
  const conditions: SQL[] = [
    sql`m.business_id = ${ctx.businessId}`,
    sql`m.deleted_at is null`,
    sql`m.stock_tracked_from is not null`,
  ]
  if (input.search) conditions.push(sql`m.name ilike ${containsPattern(input.search)}`)
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor)
    conditions.push(sql`(lower(m.name), m.id) > (${cursor.key}, ${cursor.id}::uuid)`)
  }
  const branchFilter =
    input.locationId !== undefined ? sql`l.id = ${input.locationId}` : inScope(ctx, sql`l.id`)
  return ctx.tx(async (tx) => {
    if (input.locationId !== undefined) await assertBranchOf(tx, ctx, input.locationId)
    const rows = (await tx.execute(sql`
      select m.id, lower(m.name) as sort_key, m.unit, m.stock_tracked_from::text as tracked_from,
             trim_scale(c.qty)::text as qty, trim_scale(c.value)::text as value,
             trim_scale(c.avg_cost)::text as avg_cost
        from app.materials m
        left join app.material_costs c on c.business_id = m.business_id and c.material_id = m.id
       where ${sql.join(conditions, sql` and `)}
       order by lower(m.name), m.id
       limit ${input.limit + 1}
    `)) as unknown as ItemRecord[]
    const page = rows.slice(0, input.limit)
    const ids = page.map((r) => r.id)
    const materials = await stockMaterialsOf(tx, ctx.businessId, ids)
    // Every branch listed, live ones and removed ones still holding stock, with the last count there.
    const branches = ids.length
      ? ((await tx.execute(sql`
          select m.id as material_id, l.id as location_id, l.name as location_name,
                 trim_scale(coalesce(b.qty, 0))::text as qty,
                 (select max(c.business_date)::text
                    from app.stock_count_lines cl
                    join app.stock_counts c on c.business_id = cl.business_id and c.id = cl.count_id
                   where cl.business_id = m.business_id and cl.material_id = m.id
                     and cl.location_id = l.id and cl.deleted_at is null
                     and c.status = 'posted' and c.deleted_at is null) as last_counted_on
            from app.materials m
            join app.locations l on l.business_id = m.business_id
            left join app.stock_balances b
              on b.business_id = m.business_id and b.material_id = m.id and b.location_id = l.id
           where m.business_id = ${ctx.businessId} and m.id = any(${uuidArray(ids)})
             and ${branchFilter}
             and (l.deleted_at is null or coalesce(b.qty, 0) <> 0)
           order by lower(l.name), l.id
        `)) as unknown as BranchRecord[])
      : []
    // The live branches the caller works in, for the screen's branch filter (a member without the
    // branches setting cannot list them otherwise).
    const live = (await tx.execute(sql`
      select l.id, l.name from app.locations l
       where l.business_id = ${ctx.businessId} and l.deleted_at is null
         and ${inScope(ctx, sql`l.id`)}
       order by lower(l.name), l.id
    `)) as unknown as { id: string; name: string }[]
    const everyBranch = ctx.access.locationScope.all && input.locationId === undefined
    const last = page.at(-1)
    return {
      data: {
        branches: live.map((l) => ({ id: l.id, name: l.name })),
        items: page.map((r) => {
          const avg = r.avg_cost
          const mine = branches
            .filter((b) => b.material_id === r.id)
            .map((b) => ({
              locationId: b.location_id,
              locationName: b.location_name,
              onHand: b.qty,
              value: valueOf(b.qty, avg),
              lastCountedOn: b.last_counted_on,
            }))
          const values = mine.map((b) => b.value)
          return {
            material: materials.get(r.id)!,
            trackedFrom: r.tracked_from,
            onHand: sumDecimals(mine.map((b) => b.onHand)),
            avgPerUnit: perUnitOf(avg, r.unit),
            value: everyBranch
              ? (r.value ?? '0')
              : values.some((v) => v === null)
                ? null
                : sumDecimals(values.map((v) => v ?? '0')),
            branches: mine,
          }
        }),
        nextCursor:
          rows.length > input.limit && last
            ? encodeCursor({ key: last.sort_key, id: last.id })
            : null,
      },
      meta: { redacted: [] },
    }
  })
}

/** A branch's stock worth: on hand × the average, rounded once to 12 decimals (null: no average). */
function valueOf(qty: string, avgCost: string | null): string | null {
  if (avgCost === null) return null
  const negative = qty.startsWith('-')
  const value = costOfQty(negative ? qty.slice(1) : qty, { value: avgCost, qty: '1' })
  if (value === null) return null
  return negative && value !== '0' ? `-${value}` : value
}

// ---------------------------------------------------------------------------------------------------
// stock.untracked
// ---------------------------------------------------------------------------------------------------

interface UntrackedRecord extends Record<string, unknown> {
  id: string
  sort_key: string
  opening_draft_id: string | null
}

/**
 * `stock.untracked` (counts.manage): live materials (not archived) whose stock is not tracked yet, by
 * name, to start tracking them with a first count; each says the draft first count it is already on.
 */
export async function listUntracked(
  ctx: BusinessCtx,
  input: UntrackedInput,
): Promise<StockUntrackedDto> {
  const conditions: SQL[] = [
    sql`m.business_id = ${ctx.businessId}`,
    sql`m.deleted_at is null`,
    sql`m.archived_at is null`,
    sql`m.stock_tracked_from is null`,
  ]
  if (input.search) conditions.push(sql`m.name ilike ${containsPattern(input.search)}`)
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor)
    conditions.push(sql`(lower(m.name), m.id) > (${cursor.key}, ${cursor.id}::uuid)`)
  }
  return ctx.tx(async (tx) => {
    const rows = (await tx.execute(sql`
      select m.id, lower(m.name) as sort_key,
             (select c.id from app.stock_counts c
               where c.business_id = m.business_id and c.kind = 'opening' and c.status = 'draft'
                 and c.deleted_at is null
                 and exists (select 1 from app.stock_count_lines l
                              where l.business_id = c.business_id and l.count_id = c.id
                                and l.material_id = m.id and l.deleted_at is null)
               order by c.created_at desc, c.id desc
               limit 1) as opening_draft_id
        from app.materials m
       where ${sql.join(conditions, sql` and `)}
       order by lower(m.name), m.id
       limit ${input.limit + 1}
    `)) as unknown as UntrackedRecord[]
    const page = rows.slice(0, input.limit)
    const materials = await stockMaterialsOf(
      tx,
      ctx.businessId,
      page.map((r) => r.id),
    )
    const last = page.at(-1)
    return {
      items: page.map((r) => ({
        material: materials.get(r.id)!,
        openingDraftId: r.opening_draft_id,
      })),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ key: last.sort_key, id: last.id })
          : null,
    }
  })
}

// ---------------------------------------------------------------------------------------------------
// stock.card
// ---------------------------------------------------------------------------------------------------

interface CardRecord extends Record<string, unknown> {
  id: string
  business_date: string
  seq: string
  location_id: string
  location_name: string
  kind: StockCardEntryDto['kind']
  reverses_kind: StockCardEntryDto['kind'] | null
  qty: string
  running_qty: string
  counted_qty: string | null
  value_change: string
  unit_cost: string | null
  purchase_id: string | null
  return_id: string | null
  count_id: string | null
  created_at: Date | string
}

/** A stock card page starts after this movement: its business day and posting order. */
function cardCursor(value: string): { day: string; seq: string } {
  const cursor = decodeCursor(value)
  const [day, seq] = cursor.key.split('/')
  if (!day || !seq || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{1,18}$/.test(seq)) {
    throw new AppError('validation', { message: 'invalid cursor' })
  }
  return { day, seq }
}

/**
 * `stock.card`: a tracked material's movements in the caller's branches (or the one asked for),
 * newest business day first, each with what is on hand after it (by business day, every movement
 * counted) and, with the costs switch, what it moved the stock's value by. Movements dated before its
 * first count are counted in the running quantity but not listed. STOCK_NOT_TRACKED for a material
 * whose stock is not tracked; NOT_FOUND for one that is not a material of this business.
 */
export async function stockCard(ctx: BusinessCtx, input: CardInput): Promise<StockCardDto> {
  const where =
    input.locationId !== undefined
      ? sql`m.location_id = ${input.locationId}`
      : inScope(ctx, sql`m.location_id`)
  const after = input.cursor ? cardCursor(input.cursor) : null
  return ctx.tx(async (tx) => {
    if (input.locationId !== undefined) await assertBranchOf(tx, ctx, input.locationId)
    const [material] = (await tx.execute(sql`
      select m.id, m.stock_tracked_from::text as tracked_from
        from app.materials m
       where m.business_id = ${ctx.businessId} and m.id = ${input.materialId}
         and m.deleted_at is null
    `)) as unknown as { id: string; tracked_from: string | null }[]
    if (!material) throw new AppError('not_found')
    if (material.tracked_from === null) throw new AppError('stock_not_tracked')
    const rows = (await tx.execute(sql`
      with card as (
        select m.id, m.business_date, m.seq, m.location_id, m.kind, m.qty, m.value, m.adjustment,
               m.unit_cost, m.purchase_line_id, m.return_line_id, m.count_line_id, m.reverses_id,
               m.created_at,
               sum(m.qty) over (order by m.business_date, m.seq) as running_qty
          from app.stock_movements m
         where m.business_id = ${ctx.businessId} and m.material_id = ${input.materialId}
           and ${where}
      )
      select k.id, k.business_date::text as business_date, k.seq::text as seq, k.location_id,
             l.name as location_name, k.kind, r.kind as reverses_kind,
             trim_scale(k.qty)::text as qty, trim_scale(k.running_qty)::text as running_qty,
             trim_scale(cl.counted_base_qty)::text as counted_qty,
             trim_scale(k.value - k.adjustment)::text as value_change,
             trim_scale(k.unit_cost)::text as unit_cost,
             coalesce(pl.purchase_id, pr.purchase_id) as purchase_id, rl.return_id, cl.count_id,
             k.created_at
        from card k
        join app.locations l on l.business_id = ${ctx.businessId} and l.id = k.location_id
        left join app.stock_movements r on r.business_id = ${ctx.businessId} and r.id = k.reverses_id
        left join app.purchase_lines pl
          on pl.business_id = ${ctx.businessId} and pl.id = k.purchase_line_id
        left join app.purchase_return_lines rl
          on rl.business_id = ${ctx.businessId} and rl.id = k.return_line_id
        left join app.purchase_returns pr
          on pr.business_id = ${ctx.businessId} and pr.id = rl.return_id
        left join app.stock_count_lines cl
          on cl.business_id = ${ctx.businessId} and cl.id = k.count_line_id
       where k.business_date >= ${material.tracked_from}::date
         ${after ? sql`and (k.business_date, k.seq) < (${after.day}::date, ${after.seq}::bigint)` : sql``}
       order by k.business_date desc, k.seq desc
       limit ${input.limit + 1}
    `)) as unknown as CardRecord[]
    const [total] = (await tx.execute(sql`
      select trim_scale(coalesce(sum(m.qty), 0))::text as qty
        from app.stock_movements m
       where m.business_id = ${ctx.businessId} and m.material_id = ${input.materialId}
         and ${where}
    `)) as unknown as { qty: string }[]
    const materials = await stockMaterialsOf(tx, ctx.businessId, [input.materialId])
    const page = rows.slice(0, input.limit)
    const last = page.at(-1)
    return {
      data: {
        material: materials.get(input.materialId)!,
        trackedFrom: material.tracked_from,
        onHand: total?.qty ?? '0',
        entries: page.map((r) => ({
          id: r.id,
          businessDate: r.business_date,
          locationId: r.location_id,
          locationName: r.location_name,
          kind: r.kind,
          reversesKind: r.reverses_kind,
          qty: r.qty,
          runningQty: r.running_qty,
          countedQty: r.counted_qty,
          valueChange: r.value_change,
          unitCost: r.unit_cost,
          purchaseId: r.purchase_id,
          returnId: r.return_id,
          countId: r.count_id,
          createdAt: isoOf(r.created_at),
        })),
        nextCursor:
          rows.length > input.limit && last
            ? encodeCursor({ key: `${last.business_date}/${last.seq}`, id: last.id })
            : null,
      },
      meta: { redacted: [] },
    }
  })
}
