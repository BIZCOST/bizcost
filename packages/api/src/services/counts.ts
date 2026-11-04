import {
  STOCK_COUNT_LINES_MAX,
  type addCountLinesInput,
  type CountDto,
  type countIdInput,
  type CountLineDto,
  type CountLineResultDto,
  type countLineVersionInput,
  type countListInput,
  type CountListDto,
  type CountPartDto,
  type CountResultDto,
  type CountReviewDto,
  type countVersionInput,
  type OkDto,
  type saveCountLineInput,
  type startCountInput,
} from '@bizcost/contracts'
import {
  createIdempotent,
  materials as materialsTable,
  stockCountLines,
  stockCounts,
  stockMovements,
  type NewStockMovement,
  type StoredCountPart,
  type Tx,
} from '@bizcost/db'
import {
  compareDecimal,
  costRatio,
  countDifference,
  countedBaseQty,
  EMPTY_WAC_STATE,
  newId,
  openingOf,
  openingRows,
  STANDARD_UNITS,
  subtractDecimals,
  sumDecimals,
  wacCount,
  wacOpen,
  type CostAmount,
  type CountedPart,
  type DocumentStatus,
  type Quantity,
  type StandardUnit,
  type StockCountKind,
  type UnitCost,
  type WacState,
} from '@bizcost/domain'
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { decodeCursor, encodeCursor, requestHashOf } from './catalog'
import { averageBasisOf, costRecordsOf, type CostRecord } from './material-costs'
import { loadMaterials } from './purchase-materials'
import { draftContext, resolveLocation } from './purchases'
import {
  assertBranch,
  assertBranchOf,
  assertEveryBranch,
  entersCounts,
  inScope,
  managesCounts,
  seesStock,
  stockMaterialsOf,
} from './stock-on-hand'
import {
  assertPostable,
  isoOf,
  jsonRecords,
  lockBalances,
  lockCostRows,
  lockPostingBusiness,
  materialLedger,
  moveBalance,
  negate,
  replayWithNew,
  reversalDateOf,
  toWacMovements,
  uuidArray,
  writeProjections,
  type CostRow,
} from './stock'

// Stock counts (ROADMAP.md M4 Step 2; DATA_MODEL.md §6; D-339 Q2, Q3, Q5, Q6; D-340, D-341). Module
// `inventory` with keeps_stock (the router checks them). Who does what (the plan's Q16 table):
//   - inventory.counts.manage starts counts (a first count of materials not tracked yet, in every
//     active branch on one day; or a count of one branch's tracked materials), adds and takes out
//     lines, asks for a line to be counted again, reviews (expected against counted), finalizes,
//     discards and reverses them;
//   - inventory.counts.enter (and .manage) fills a draft's lines, one by one, each with its own
//     version (several people fill one count); blind: without .manage a line never carries what the
//     book expected, nor any difference or value (absent, not null);
//   - inventory.stock.view sees finalized counts with what was counted (differences only with
//     .manage, their values only with the costs switch too).
// A member limited to some branches (D-234) sees and fills only lines in their branches, and a count
// of another branch, or a first count with no line in theirs, is NOT_FOUND to them; what covers every
// branch (starting, changing, finalizing, discarding or reversing a first count) needs every branch.
//
// Every change of a draft's lines (saved, counted again, added, taken off) takes the count row FOR
// UPDATE first (lock 1, as finalizing does) and moves its `version` on: two counters saving different
// lines wait for each other there, each checks only its own line's version, and a finalize names the
// version `count.review` returned, so a line changed since the manager looked is CONFLICT.
//
// A count is the stock at the END of its business day (Q5). Finalizing posts under the ledger's lock
// order (stock.ts, D-110, D-135): the count FOR UPDATE, the business FOR SHARE (not after today, not
// into closed books), its materials (FOR NO KEY UPDATE for a first count: it sets their
// stock_tracked_from), their cost rows, their balances; every check that depends on other counts runs
// after the cost rows are locked, so counts of the same materials are finalized one after another.
//   - A first count (`opening`): each material's stock BECOMES what was counted in every branch
//     together at that day's 90-day purchase average (openingOf, wacOpen; Q3: costs don't jump; no
//     price yet: no value). One `opening` row per branch line sets the branch to what was counted
//     (qty = counted − the balance before); the value is split over the lines by what they counted and
//     the book value it replaces goes on the first line (openingRows), so the rows read back as one
//     opening (toWacMovements). Refused when an entry of one of its materials is dated after its day:
//     it would come before the count in the ledger, and the count would drop it (COUNT_OUT_OF_ORDER);
//     and while a removed branch holds stock of one of its materials (BRANCH_HAS_STOCK): its lines
//     cover live branches only, so that stock would stay in the balances and not in the cost row.
//   - A later count (`count`): each line's book is the balance less what is dated after the count's
//     day; a non-zero difference (counted − book) posts one `count` row at the average (wacCount: a
//     loss as an issue, a gain at the average, the average never moves, D-340).
// The day-order refusals (COUNT_OUT_OF_ORDER, BRANCH_HAS_STOCK) are checked when a count starts (its
// day never changes) and again when it is finalized, under the locks.
// Reversing takes it back "as if never posted" (replayWithNew), dated its own day or the first open
// day, only while no later finalized count of its lines stands (a first count: of its materials
// anywhere), and a first count's reversal stops tracking its materials. A first count is reversed
// only while nothing has taken stock of its materials out since (STOCK_USED_SINCE: today a supplier
// return that stands), and a purchase or return posted before it is not reversed while it stands
// (STOCK_COUNTED, stock.ts): its rows are relative per branch, its opening absolute in the cost
// engine, so either would part the cost row from the balances.

type StartInput = z.output<typeof startCountInput>
type IdInput = z.output<typeof countIdInput>
type VersionInput = z.output<typeof countVersionInput>
type ListInput = z.output<typeof countListInput>
type SaveLineInput = z.output<typeof saveCountLineInput>
type LineVersionInput = z.output<typeof countLineVersionInput>
type AddLinesInput = z.output<typeof addCountLinesInput>

const invalid = (message: string) => new AppError('validation', { message })

const addDecimal = (a: string, b: string) => sumDecimals([a, b])

/** A member's name in the business now (`user`: an auth user id column). */
const memberName = (user: SQL) => sql`(
  select bm.display_name from app.business_members bm
   where bm.business_id = c.business_id and bm.user_id = ${user} and bm.kind = 'account'
   order by (bm.status = 'active') desc, bm.created_at desc
   limit 1)`

function result<T>(data: T): { data: T; meta: { redacted: string[] } } {
  return { data, meta: { redacted: [] } }
}

// ---------------------------------------------------------------------------------------------------
// Who sees what
// ---------------------------------------------------------------------------------------------------

/**
 * The counts the caller may see (alias `c`): drafts to whoever fills or manages counts, finalized and
 * reversed ones to whoever sees stock; a count of a branch only in the caller's branches, a first
 * count only with a line there.
 */
function visibleTo(ctx: BusinessCtx): SQL[] {
  const statuses: DocumentStatus[] = []
  if (entersCounts(ctx)) statuses.push('draft')
  if (seesStock(ctx)) statuses.push('posted', 'reversed')
  const parts: SQL[] = [
    statuses.length === 0
      ? sql`false`
      : sql`c.status in (${sql.join(
          statuses.map((s) => sql`${s}`),
          sql`, `,
        )})`,
  ]
  if (!ctx.access.locationScope.all) {
    parts.push(sql`(
      (c.kind = 'count' and ${inScope(ctx, sql`c.location_id`)})
      or (c.kind = 'opening' and exists (
            select 1 from app.stock_count_lines sl
             where sl.business_id = c.business_id and sl.count_id = c.id and sl.deleted_at is null
               and ${inScope(ctx, sql`sl.location_id`)})))`)
  }
  return parts
}

// ---------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------

interface HeadRecord extends Record<string, unknown> {
  id: string
  kind: StockCountKind
  status: DocumentStatus
  location_id: string | null
  location_name: string | null
  business_date: string
  note: string | null
  created_by_name: string | null
  posted_by_name: string | null
  created_at: Date | string
  posted_at: Date | string | null
  reversed_at: Date | string | null
  reversal_date: string | null
  version: number
}

interface LineRecord extends Record<string, unknown> {
  id: string
  location_id: string
  location_name: string
  material_id: string
  parts: StoredCountPart[] | null
  counted_qty: string | null
  counted_by_name: string | null
  counted_at: Date | string | null
  counted_by_me: boolean
  book_qty: string | null
  difference_qty: string | null
  difference_value: string | null
  unit_cost: string | null
  version: number
}

const lineColumns = sql`
  l.id, l.location_id, loc.name as location_name, l.material_id, l.parts,
  trim_scale(l.counted_base_qty)::text as counted_qty,
  ${memberName(sql`l.counted_by`)} as counted_by_name, l.counted_at,
  coalesce(l.counted_by = app.current_user_id(), false) as counted_by_me,
  trim_scale(l.book_base_qty)::text as book_qty,
  trim_scale(l.difference_qty)::text as difference_qty,
  trim_scale(l.difference_value)::text as difference_value,
  trim_scale(l.unit_cost)::text as unit_cost, l.version`

/** The parts of counted lines as the API returns them, with the names of their packs. */
async function partsOf(
  tx: Tx,
  businessId: string,
  lines: readonly LineRecord[],
): Promise<(line: LineRecord) => CountPartDto[] | null> {
  const packIds = [
    ...new Set(
      lines.flatMap((l) => (l.parts ?? []).flatMap((p) => ('pack_id' in p ? [p.pack_id] : []))),
    ),
  ]
  const names = new Map<string, string>()
  if (packIds.length > 0) {
    const rows = (await tx.execute(sql`
      select u.id, u.name from app.material_units u
       where u.business_id = ${businessId} and u.id = any(${uuidArray(packIds)})
    `)) as unknown as { id: string; name: string | null }[]
    for (const row of rows) names.set(row.id, row.name ?? '')
  }
  return (line) =>
    line.parts === null
      ? null
      : line.parts.map((p) =>
          'pack_id' in p
            ? { qty: p.qty, unit: null, packId: p.pack_id, packName: names.get(p.pack_id) ?? null }
            : { qty: p.qty, unit: p.unit as StandardUnit, packId: null, packName: null },
        )
}

/**
 * A line as the caller may see it: what the book expected, the difference and its value only for a
 * member who manages counts, once the count is posted (absent otherwise: blind counting, Q6); who
 * counted it only with a team (D-192).
 */
function lineDto(
  ctx: BusinessCtx,
  status: DocumentStatus,
  line: LineRecord,
  parts: (line: LineRecord) => CountPartDto[] | null,
): CountLineDto {
  const dto: CountLineDto = {
    id: line.id,
    locationId: line.location_id,
    locationName: line.location_name,
    materialId: line.material_id,
    parts: parts(line),
    countedQty: line.counted_qty,
    countedByName: ctx.access.capabilities.has_team ? line.counted_by_name : null,
    countedAt: isoOf(line.counted_at),
    countedByMe: line.counted_by_me,
    version: line.version,
  }
  if (status !== 'draft' && managesCounts(ctx) && line.book_qty !== null) {
    dto.bookQty = line.book_qty
    dto.differenceQty = line.difference_qty ?? '0'
    dto.differenceValue = line.difference_value ?? '0'
    dto.unitCost = line.unit_cost
  }
  return dto
}

async function readHead(tx: Tx, businessId: string, id: string): Promise<HeadRecord | undefined> {
  const [head] = (await tx.execute(sql`
    select c.id, c.kind, c.status, c.location_id, loc.name as location_name,
           c.business_date::text as business_date, c.note,
           ${memberName(sql`c.created_by`)} as created_by_name,
           ${memberName(sql`c.posted_by`)} as posted_by_name,
           c.created_at, c.posted_at, c.reversed_at, c.reversal_date::text as reversal_date,
           c.version
      from app.stock_counts c
      left join app.locations loc on loc.business_id = c.business_id and loc.id = c.location_id
     where c.business_id = ${businessId} and c.id = ${id} and c.deleted_at is null
  `)) as unknown as HeadRecord[]
  return head
}

/** The count as the caller may see it (NOT_FOUND otherwise; see visibleTo). */
export async function readCount(tx: Tx, ctx: BusinessCtx, id: string): Promise<CountDto> {
  const head = await readHead(tx, ctx.businessId, id)
  if (!head || !mayRead(ctx, head)) throw new AppError('not_found')
  const lines = (await tx.execute(sql`
    select ${lineColumns}
      from app.stock_count_lines l
      join app.stock_counts c on c.business_id = l.business_id and c.id = l.count_id
      join app.materials m on m.business_id = l.business_id and m.id = l.material_id
      join app.locations loc on loc.business_id = l.business_id and loc.id = l.location_id
     where l.business_id = ${ctx.businessId} and l.count_id = ${id} and l.deleted_at is null
       and ${inScope(ctx, sql`l.location_id`)}
     order by lower(m.name), m.id, lower(loc.name), loc.id
  `)) as unknown as LineRecord[]
  assertOpeningInScope(ctx, head, lines.length)
  const parts = await partsOf(tx, ctx.businessId, lines)
  const materials = await stockMaterialsOf(
    tx,
    ctx.businessId,
    lines.map((l) => l.material_id),
  )
  const team = ctx.access.capabilities.has_team
  return {
    id: head.id,
    kind: head.kind,
    status: head.status,
    locationId: head.location_id,
    locationName: head.location_name,
    businessDate: head.business_date,
    note: head.note,
    lineCount: lines.length,
    countedCount: lines.filter((l) => l.counted_qty !== null).length,
    materials: [...new Set(lines.map((l) => l.material_id))].map((m) => materials.get(m)!),
    lines: lines.map((l) => lineDto(ctx, head.status, l, parts)),
    createdByName: team ? head.created_by_name : null,
    postedByName: team ? head.posted_by_name : null,
    createdAt: isoOf(head.created_at),
    postedAt: isoOf(head.posted_at),
    reversedAt: isoOf(head.reversed_at),
    reversalDate: head.reversal_date,
    version: head.version,
  }
}

/** Whether the caller may read this count (its status and branch; a first count: any branch). */
function mayRead(
  ctx: BusinessCtx,
  head: Pick<HeadRecord, 'status' | 'kind' | 'location_id'>,
): boolean {
  if (head.status === 'draft' ? !entersCounts(ctx) : !seesStock(ctx)) return false
  if (head.kind === 'count' && head.location_id !== null) {
    try {
      assertBranch(ctx, head.location_id)
    } catch {
      return false
    }
  }
  return true
}

/**
 * A first count is read by a member limited to some branches only with a line in one of theirs, as
 * `count.list` lists it (visibleTo): NOT_FOUND otherwise. `linesInScope`: its live lines there.
 */
function assertOpeningInScope(
  ctx: BusinessCtx,
  head: Pick<HeadRecord, 'kind'>,
  linesInScope: number,
): void {
  if (head.kind === 'opening' && !ctx.access.locationScope.all && linesInScope === 0) {
    throw new AppError('not_found')
  }
}

/** `count.get`. */
export function getCount(ctx: BusinessCtx, input: IdInput): Promise<CountResultDto> {
  return ctx.tx(async (tx) => result(await readCount(tx, ctx, input.id)))
}

interface ListRecord extends Record<string, unknown> {
  id: string
  kind: StockCountKind
  status: DocumentStatus
  location_id: string | null
  location_name: string | null
  business_date: string
  note: string | null
  line_count: number
  counted_count: number
  created_at: Date | string
  version: number
}

/** `count.list`: newest business day first, the counts the caller may see. */
export async function listCounts(ctx: BusinessCtx, input: ListInput): Promise<CountListDto> {
  const conditions: SQL[] = [
    sql`c.business_id = ${ctx.businessId}`,
    sql`c.deleted_at is null`,
    ...visibleTo(ctx),
  ]
  if (input.status !== 'all') conditions.push(sql`c.status = ${input.status}`)
  if (input.kind !== undefined) conditions.push(sql`c.kind = ${input.kind}`)
  if (input.locationId !== undefined) {
    conditions.push(sql`(c.location_id = ${input.locationId} or (c.kind = 'opening' and exists (
      select 1 from app.stock_count_lines fl
       where fl.business_id = c.business_id and fl.count_id = c.id and fl.deleted_at is null
         and fl.location_id = ${input.locationId})))`)
  }
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cursor.key)) throw invalid('invalid cursor')
    conditions.push(sql`(c.business_date, c.id) < (${cursor.key}::date, ${cursor.id}::uuid)`)
  }
  return ctx.tx(async (tx) => {
    if (input.locationId !== undefined) await assertBranchOf(tx, ctx, input.locationId)
    const rows = (await tx.execute(sql`
      select c.id, c.kind, c.status, c.location_id, loc.name as location_name,
             c.business_date::text as business_date, c.note, c.created_at, c.version,
             (select count(*)::int from app.stock_count_lines l
               where l.business_id = c.business_id and l.count_id = c.id and l.deleted_at is null
                 and ${inScope(ctx, sql`l.location_id`)}) as line_count,
             (select count(*)::int from app.stock_count_lines l
               where l.business_id = c.business_id and l.count_id = c.id and l.deleted_at is null
                 and l.counted_base_qty is not null
                 and ${inScope(ctx, sql`l.location_id`)}) as counted_count
        from app.stock_counts c
        left join app.locations loc on loc.business_id = c.business_id and loc.id = c.location_id
       where ${sql.join(conditions, sql` and `)}
       order by c.business_date desc, c.id desc
       limit ${input.limit + 1}
    `)) as unknown as ListRecord[]
    const page = rows.slice(0, input.limit)
    const last = page.at(-1)
    return {
      items: page.map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        locationId: r.location_id,
        locationName: r.location_name,
        businessDate: r.business_date,
        note: r.note,
        lineCount: r.line_count,
        countedCount: r.counted_count,
        createdAt: isoOf(r.created_at),
        version: r.version,
      })),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ key: last.business_date, id: last.id })
          : null,
    }
  })
}

// ---------------------------------------------------------------------------------------------------
// Starting a count, and its lines
// ---------------------------------------------------------------------------------------------------

interface MaterialState extends Record<string, unknown> {
  id: string
  name: string
  archived: boolean
  tracked_from: string | null
}

/** The live materials of the business among `ids`, with whether their stock is tracked. */
async function materialStates(
  tx: Tx,
  businessId: string,
  ids: readonly string[],
): Promise<Map<string, MaterialState>> {
  if (ids.length === 0) return new Map()
  const rows = (await tx.execute(sql`
    select m.id, m.name, m.archived_at is not null as archived,
           m.stock_tracked_from::text as tracked_from
      from app.materials m
     where m.business_id = ${businessId} and m.id = any(${uuidArray(ids)})
       and m.deleted_at is null
  `)) as unknown as MaterialState[]
  return new Map(rows.map((r) => [r.id, r] as const))
}

/** The business's live locations (its branches; a single-location business: its default one). */
async function activeBranches(tx: Tx, businessId: string): Promise<string[]> {
  const rows = (await tx.execute(sql`
    select l.id from app.locations l
     where l.business_id = ${businessId} and l.deleted_at is null
     order by l.id
  `)) as unknown as { id: string }[]
  return rows.map((r) => r.id)
}

/**
 * The materials a first count may take: live, not archived, not tracked yet (NOT_FOUND for one that
 * is not a material of this business, VALIDATION for an archived one, STOCK_TRACKED for one whose
 * stock is tracked already).
 */
async function untrackedMaterials(
  tx: Tx,
  businessId: string,
  ids: readonly string[],
): Promise<void> {
  const states = await materialStates(tx, businessId, ids)
  if (ids.some((id) => !states.has(id))) throw new AppError('not_found')
  if ([...states.values()].some((m) => m.archived)) throw invalid('materialIds: archived')
  const tracked = [...states.values()].filter((m) => m.tracked_from !== null)
  if (tracked.length > 0) throw new AppError('stock_tracked', { names: tracked.map((m) => m.name) })
}

/** As untrackedMaterials, for a later count: only materials whose stock is tracked. */
async function trackedMaterials(tx: Tx, businessId: string, ids: readonly string[]): Promise<void> {
  const states = await materialStates(tx, businessId, ids)
  if (ids.some((id) => !states.has(id))) throw new AppError('not_found')
  if ([...states.values()].some((m) => m.archived)) throw invalid('materialIds: archived')
  const untracked = [...states.values()].filter((m) => m.tracked_from === null)
  if (untracked.length > 0) {
    throw new AppError('stock_not_tracked', { names: untracked.map((m) => m.name) })
  }
}

/** Every tracked material that is live and not archived, by name. */
async function everyTracked(tx: Tx, businessId: string): Promise<string[]> {
  const rows = (await tx.execute(sql`
    select m.id from app.materials m
     where m.business_id = ${businessId} and m.deleted_at is null and m.archived_at is null
       and m.stock_tracked_from is not null
     order by lower(m.name), m.id
     limit ${STOCK_COUNT_LINES_MAX + 1}
  `)) as unknown as { id: string }[]
  return rows.map((r) => r.id)
}

function assertLineCount(count: number) {
  if (count > STOCK_COUNT_LINES_MAX) {
    throw invalid(`lines: at most ${STOCK_COUNT_LINES_MAX} on one count`)
  }
}

// ---------------------------------------------------------------------------------------------------
// Day order (checked when a count starts, and again under the locks when it is finalized)
// ---------------------------------------------------------------------------------------------------

/**
 * A first count sets its materials' stock as of the end of its day: an entry of one of them dated
 * after that day would come before it in the ledger and be dropped (COUNT_OUT_OF_ORDER).
 */
async function assertNoEntryAfter(
  tx: Tx,
  businessId: string,
  materialIds: readonly string[],
  day: string,
): Promise<void> {
  if (materialIds.length === 0) return
  const [later] = (await tx.execute(sql`
    select 1 as found from app.stock_movements m
     where m.business_id = ${businessId} and m.material_id = any(${uuidArray(materialIds)})
       and m.business_date > ${day}::date
     limit 1
  `)) as unknown as { found: number }[]
  if (later) throw new AppError('count_out_of_order')
}

/**
 * A later count of a branch goes after its materials' first count and after the last finalized
 * count of each of its lines (COUNT_OUT_OF_ORDER, D-345); `exceptId`: the count being finalized.
 */
async function assertCountDayFree(
  tx: Tx,
  businessId: string,
  locationId: string,
  materialIds: readonly string[],
  day: string,
  exceptId: string | null,
): Promise<void> {
  if (materialIds.length === 0) return
  const ids = uuidArray(materialIds)
  const [taken] = (await tx.execute(sql`
    select 1 as found
     where exists (
             select 1 from app.materials m
              where m.business_id = ${businessId} and m.id = any(${ids})
                and m.stock_tracked_from >= ${day}::date)
        or exists (
             select 1
               from app.stock_count_lines l
               join app.stock_counts c on c.business_id = l.business_id and c.id = l.count_id
              where l.business_id = ${businessId} and l.deleted_at is null
                and l.location_id = ${locationId} and l.material_id = any(${ids})
                and c.deleted_at is null and c.status = 'posted'
                and c.business_date >= ${day}::date
                ${exceptId === null ? sql`` : sql`and c.id <> ${exceptId}`})
  `)) as unknown as { found: number }[]
  if (taken) throw new AppError('count_out_of_order')
}

/**
 * A first count's lines cover the live branches only: while a removed branch still holds stock of
 * one of its materials, that stock would stay in the branch's balance and not in the stock the count
 * sets (BRANCH_HAS_STOCK, naming the branches and the materials; Step 4, Q12, clears them).
 */
async function assertNoRemovedBranchStock(
  tx: Tx,
  businessId: string,
  materialIds: readonly string[],
): Promise<void> {
  if (materialIds.length === 0) return
  const rows = (await tx.execute(sql`
    select l.name as branch, m.name as material
      from app.stock_balances b
      join app.locations l on l.business_id = b.business_id and l.id = b.location_id
      join app.materials m on m.business_id = b.business_id and m.id = b.material_id
     where b.business_id = ${businessId} and b.material_id = any(${uuidArray(materialIds)})
       and l.deleted_at is not null and b.qty <> 0
     order by lower(l.name), l.id, lower(m.name), m.id
  `)) as unknown as { branch: string; material: string }[]
  if (rows.length > 0) {
    throw new AppError('branch_has_stock', {
      names: [...new Set(rows.map((r) => r.branch))],
      materials: [...new Set(rows.map((r) => r.material))].sort((a, b) =>
        a.toLowerCase().localeCompare(b.toLowerCase()),
      ),
    })
  }
}

/**
 * `count.start` (counts.manage): a draft, idempotent on the client's id: the same payload again (by
 * the same member) returns the count as it is now, whatever happened to it since, before anything
 * is checked again (D-031); an id used by another create or another business is CONFLICT. A first
 * count takes every active branch for each material (and needs a member who works in every branch); a
 * count takes one branch (the default one when none is given; another needs multi_location) and
 * tracked materials, or all of them. Its day is checked now (COUNT_OUT_OF_ORDER, BRANCH_HAS_STOCK; it
 * never changes) and again when it is finalized.
 */
export async function startCount(ctx: BusinessCtx, input: StartInput): Promise<CountResultDto> {
  const { id, ...fields } = input
  const requestHash = requestHashOf(fields)
  return ctx.tx(async (tx) => {
    const [retried] = (await tx.execute(sql`
      select c.deleted_at is not null as discarded
        from app.stock_counts c
       where c.business_id = ${ctx.businessId} and c.id = ${id}
         and c.created_by = app.current_user_id() and c.request_hash = ${requestHash}
    `)) as unknown as { discarded: boolean }[]
    if (retried) {
      if (retried.discarded) throw new AppError('conflict', { message: 'count was discarded' })
      return result(await readCount(tx, ctx, id))
    }
    let locationId: string | null = null
    let pairs: { locationId: string; materialId: string }[]
    if (fields.kind === 'opening') {
      assertEveryBranch(ctx)
      await untrackedMaterials(tx, ctx.businessId, fields.materialIds)
      await assertNoEntryAfter(tx, ctx.businessId, fields.materialIds, fields.businessDate)
      await assertNoRemovedBranchStock(tx, ctx.businessId, fields.materialIds)
      const branches = await activeBranches(tx, ctx.businessId)
      pairs = fields.materialIds.flatMap((materialId) =>
        branches.map((branch) => ({ locationId: branch, materialId })),
      )
    } else {
      const { defaultLocationId } = await draftContext(tx, ctx.businessId)
      locationId = await resolveLocation(tx, ctx, fields.locationId, defaultLocationId)
      assertBranch(ctx, locationId)
      let ids: string[]
      if (fields.materialIds === 'all') {
        ids = await everyTracked(tx, ctx.businessId)
        if (ids.length === 0) throw new AppError('stock_not_tracked')
      } else {
        ids = fields.materialIds
        await trackedMaterials(tx, ctx.businessId, ids)
      }
      await assertCountDayFree(tx, ctx.businessId, locationId, ids, fields.businessDate, null)
      const branch = locationId
      pairs = ids.map((materialId) => ({ locationId: branch, materialId }))
    }
    assertLineCount(pairs.length)
    const { row, created } = await createIdempotent(tx, stockCounts, {
      id,
      businessId: ctx.businessId,
      kind: fields.kind,
      locationId,
      businessDate: fields.businessDate,
      note: fields.note,
      requestHash,
    })
    if (row.deletedAt !== null) throw new AppError('conflict', { message: 'count was discarded' })
    if (created && pairs.length > 0) {
      await tx
        .insert(stockCountLines)
        .values(pairs.map((p) => ({ id: newId(), businessId: ctx.businessId, countId: id, ...p })))
    }
    return result(await readCount(tx, ctx, id))
  })
}

interface LockedHead extends Record<string, unknown> {
  id: string
  kind: StockCountKind
  status: DocumentStatus
  location_id: string | null
  business_date: string
  version: number
}

/**
 * The count row locked FOR UPDATE (lock 1 of every change: a line saved, cleared, added or taken
 * off, finalizing, discarding, reversing); NOT_FOUND when not live or not the caller's to see.
 */
async function lockCount(tx: Tx, ctx: BusinessCtx, id: string): Promise<LockedHead> {
  const [row] = (await tx.execute(sql`
    select c.id, c.kind, c.status, c.location_id, c.business_date::text as business_date, c.version
      from app.stock_counts c
     where c.business_id = ${ctx.businessId} and c.id = ${id} and c.deleted_at is null
       for update
  `)) as unknown as LockedHead[]
  if (!row || !mayRead(ctx, row)) throw new AppError('not_found')
  return row
}

/**
 * A line of the draft changed: its `version` moves on (touch_row adds one), so a finalize sent with
 * the version read before (`count.review`) is CONFLICT. Under lock 1, taken by the caller.
 */
async function touchCount(tx: Tx, ctx: BusinessCtx, id: string): Promise<void> {
  await tx
    .update(stockCounts)
    .set({ updatedAt: sql`now()` })
    .where(and(eq(stockCounts.businessId, ctx.businessId), eq(stockCounts.id, id)))
}

/** What a manager changes covers its branch, or every branch for a first count. */
function assertCovers(ctx: BusinessCtx, head: LockedHead) {
  if (head.kind === 'opening') assertEveryBranch(ctx)
  else if (head.location_id !== null) assertBranch(ctx, head.location_id)
}

/** A draft that may still change (DOCUMENT_POSTED once posted). */
function assertDraft(head: LockedHead) {
  if (head.status !== 'draft') throw new AppError('document_posted')
}

interface LockedLine extends Record<string, unknown> {
  id: string
  location_id: string
  material_id: string
  version: number
}

/** A line of the count, locked FOR UPDATE, in one of the caller's branches (NOT_FOUND otherwise). */
async function lockLine(
  tx: Tx,
  ctx: BusinessCtx,
  countId: string,
  lineId: string,
): Promise<LockedLine> {
  const [line] = (await tx.execute(sql`
    select l.id, l.location_id, l.material_id, l.version
      from app.stock_count_lines l
     where l.business_id = ${ctx.businessId} and l.count_id = ${countId} and l.id = ${lineId}
       and l.deleted_at is null
       for update
  `)) as unknown as LockedLine[]
  if (!line) throw new AppError('not_found')
  try {
    assertBranch(ctx, line.location_id)
  } catch {
    throw new AppError('not_found')
  }
  return line
}

/** The line as the caller may see it, after a change. */
async function readLine(tx: Tx, ctx: BusinessCtx, head: LockedHead, lineId: string) {
  const [line] = (await tx.execute(sql`
    select ${lineColumns}
      from app.stock_count_lines l
      join app.stock_counts c on c.business_id = l.business_id and c.id = l.count_id
      join app.locations loc on loc.business_id = l.business_id and loc.id = l.location_id
     where l.business_id = ${ctx.businessId} and l.id = ${lineId}
  `)) as unknown as LineRecord[]
  if (!line) throw new AppError('not_found')
  const parts = await partsOf(tx, ctx.businessId, [line])
  return lineDto(ctx, head.status, line, parts)
}

/**
 * `count.saveLine` (counts.enter or counts.manage): what was counted on a line of a draft, in any of
 * its material's units or packs, one part or several; its `version` as read (CONFLICT for another:
 * someone else saved it since). Records who counted it and when. The material is locked FOR SHARE
 * first (its units cannot change under the save, D-145). VALIDATION for a unit that is not the
 * material's (a pack of another material or one removed) or a total stock cannot hold.
 */
export async function saveCountLine(
  ctx: BusinessCtx,
  input: SaveLineInput,
): Promise<CountLineResultDto> {
  return ctx.tx(async (tx) => {
    const head = await lockCount(tx, ctx, input.countId)
    assertDraft(head)
    const line = await lockLine(tx, ctx, head.id, input.lineId)
    if (line.version !== input.version) throw new AppError('conflict')
    await tx.execute(sql`
      select m.id from app.materials m
       where m.business_id = ${ctx.businessId} and m.id = ${line.material_id}
         for share
    `)
    const material = (await loadMaterials(tx, ctx.businessId, [line.material_id])).get(
      line.material_id,
    )
    if (!material) throw invalid('material: removed')
    const parts: CountedPart[] = []
    const stored: StoredCountPart[] = []
    for (const part of input.parts) {
      if (part.packId != null) {
        if (!material.packNames.has(part.packId))
          throw invalid('parts: not a pack of this material')
        parts.push({ qty: part.qty as Quantity, unit: { pack: part.packId } })
        stored.push({ qty: part.qty, pack_id: part.packId })
      } else {
        parts.push({ qty: part.qty as Quantity, unit: part.unit! })
        stored.push({ qty: part.qty, unit: part.unit! })
      }
    }
    let counted: Quantity
    try {
      counted = countedBaseQty(parts, material.units)
    } catch (error) {
      throw invalid(`parts: ${error instanceof Error ? error.message : 'cannot convert'}`)
    }
    await tx
      .update(stockCountLines)
      .set({
        parts: stored,
        countedBaseQty: counted,
        countedBy: sql`app.current_user_id()`,
        countedAt: sql`now()`,
      })
      .where(and(eq(stockCountLines.businessId, ctx.businessId), eq(stockCountLines.id, line.id)))
    await touchCount(tx, ctx, head.id)
    return result(await readLine(tx, ctx, head, line.id))
  })
}

/** `count.clearLine` (counts.manage): "count it again": the line is not counted any more. */
export async function clearCountLine(
  ctx: BusinessCtx,
  input: LineVersionInput,
): Promise<CountLineResultDto> {
  return ctx.tx(async (tx) => {
    const head = await lockCount(tx, ctx, input.countId)
    assertDraft(head)
    const line = await lockLine(tx, ctx, head.id, input.lineId)
    if (line.version !== input.version) throw new AppError('conflict')
    await tx
      .update(stockCountLines)
      .set({ parts: null, countedBaseQty: null, countedBy: null, countedAt: null })
      .where(and(eq(stockCountLines.businessId, ctx.businessId), eq(stockCountLines.id, line.id)))
    await touchCount(tx, ctx, head.id)
    return result(await readLine(tx, ctx, head, line.id))
  })
}

/**
 * `count.addLines` (counts.manage, a draft): materials added to the count. A first count: materials
 * not tracked yet, in every active branch; one already on it gets exactly the lines it misses (a
 * branch added since it was started: `count.review`'s missingLines), once. A count: tracked
 * materials, in its branch; one already on it is skipped. At most STOCK_COUNT_LINES_MAX lines.
 */
export async function addCountLines(
  ctx: BusinessCtx,
  input: AddLinesInput,
): Promise<CountResultDto> {
  return ctx.tx(async (tx) => {
    const head = await lockCount(tx, ctx, input.countId)
    assertCovers(ctx, head)
    assertDraft(head)
    let pairs: { locationId: string; materialId: string }[]
    if (head.kind === 'opening') {
      await untrackedMaterials(tx, ctx.businessId, input.materialIds)
      const branches = await activeBranches(tx, ctx.businessId)
      pairs = input.materialIds.flatMap((materialId) =>
        branches.map((branch) => ({ locationId: branch, materialId })),
      )
    } else {
      await trackedMaterials(tx, ctx.businessId, input.materialIds)
      const branch = head.location_id!
      pairs = input.materialIds.map((materialId) => ({ locationId: branch, materialId }))
    }
    const existing = (await tx.execute(sql`
      select l.location_id, l.material_id from app.stock_count_lines l
       where l.business_id = ${ctx.businessId} and l.count_id = ${head.id} and l.deleted_at is null
    `)) as unknown as { location_id: string; material_id: string }[]
    const have = new Set(existing.map((e) => `${e.location_id}:${e.material_id}`))
    const added = pairs.filter((p) => !have.has(`${p.locationId}:${p.materialId}`))
    assertLineCount(existing.length + added.length)
    if (added.length > 0) {
      await tx
        .insert(stockCountLines)
        .values(
          added.map((p) => ({ id: newId(), businessId: ctx.businessId, countId: head.id, ...p })),
        )
      await touchCount(tx, ctx, head.id)
    }
    return result(await readCount(tx, ctx, head.id))
  })
}

/** `count.removeLine` (counts.manage, a draft): the line is taken off (soft-deleted). */
export async function removeCountLine(
  ctx: BusinessCtx,
  input: LineVersionInput,
): Promise<CountResultDto> {
  return ctx.tx(async (tx) => {
    const head = await lockCount(tx, ctx, input.countId)
    assertCovers(ctx, head)
    assertDraft(head)
    const line = await lockLine(tx, ctx, head.id, input.lineId)
    if (line.version !== input.version) throw new AppError('conflict')
    await tx
      .update(stockCountLines)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(stockCountLines.businessId, ctx.businessId), eq(stockCountLines.id, line.id)))
    await touchCount(tx, ctx, head.id)
    return result(await readCount(tx, ctx, head.id))
  })
}

/** `count.discard` (counts.manage): a draft is taken out with its lines; never a posted one. */
export async function discardCount(ctx: BusinessCtx, input: VersionInput): Promise<OkDto> {
  return ctx.tx(async (tx) => {
    const head = await lockCount(tx, ctx, input.id)
    assertCovers(ctx, head)
    assertDraft(head)
    if (head.version !== input.version) throw new AppError('conflict')
    await tx
      .update(stockCountLines)
      .set({ deletedAt: sql`now()` })
      .where(
        and(
          eq(stockCountLines.businessId, ctx.businessId),
          eq(stockCountLines.countId, head.id),
          isNull(stockCountLines.deletedAt),
        ),
      )
    await tx
      .update(stockCounts)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(stockCounts.businessId, ctx.businessId), eq(stockCounts.id, head.id)))
    return { ok: true as const }
  })
}

// ---------------------------------------------------------------------------------------------------
// The book at the end of a day
// ---------------------------------------------------------------------------------------------------

interface Pair {
  readonly locationId: string
  readonly materialId: string
}

const pairKey = (locationId: string, materialId: string) => `${locationId}:${materialId}`

/**
 * What the book says for each (branch, material) at the end of `day`: its balance less what is dated
 * after the day (an entry posted before the count for a later day comes after it, Q5). Read after
 * the balances are locked when finalizing, so nothing can be posted for them in between.
 */
async function booksAt(
  tx: Tx,
  businessId: string,
  pairs: readonly Pair[],
  day: string,
): Promise<{ balance: Map<string, string>; book: Map<string, string> }> {
  const balance = new Map<string, string>()
  const book = new Map<string, string>()
  if (pairs.length === 0) return { balance, book }
  const locations = uuidArray(pairs.map((p) => p.locationId))
  const materials = uuidArray(pairs.map((p) => p.materialId))
  const rows = (await tx.execute(sql`
    select p.location_id, p.material_id,
           trim_scale(coalesce(b.qty, 0))::text as balance,
           trim_scale(coalesce((
             select sum(m.qty) from app.stock_movements m
              where m.business_id = ${businessId} and m.material_id = p.material_id
                and m.location_id = p.location_id and m.business_date > ${day}::date
           ), 0))::text as after
      from unnest(${locations}, ${materials}) as p(location_id, material_id)
      left join app.stock_balances b
        on b.business_id = ${businessId} and b.location_id = p.location_id
       and b.material_id = p.material_id
  `)) as unknown as { location_id: string; material_id: string; balance: string; after: string }[]
  for (const r of rows) {
    const key = pairKey(r.location_id, r.material_id)
    balance.set(key, r.balance)
    book.set(key, subtractDecimals(r.balance, r.after))
  }
  return { balance, book }
}

/** The cost rows of materials as they stand (not locked: the review only reads them). */
async function costStates(
  tx: Tx,
  businessId: string,
  ids: readonly string[],
): Promise<Map<string, WacState>> {
  const states = new Map<string, WacState>()
  if (ids.length === 0) return states
  const rows = (await tx.execute(sql`
    select c.material_id, trim_scale(c.qty)::text as qty, trim_scale(c.value)::text as value,
           trim_scale(c.avg_cost)::text as avg_cost
      from app.material_costs c
     where c.business_id = ${businessId} and c.material_id = any(${uuidArray(ids)})
  `)) as unknown as { material_id: string; qty: string; value: string; avg_cost: string | null }[]
  for (const r of rows) {
    states.set(r.material_id, {
      qty: r.qty as Quantity,
      value: r.value as CostAmount,
      avgCost: r.avg_cost as UnitCost | null,
    })
  }
  return states
}

/** A first count's opening of one material, as of the count's day (D-115 basis, Q3). */
function openingFor(record: CostRecord, counted: string) {
  const basis = averageBasisOf(record)
  return openingOf(counted as Quantity, basis ? { value: basis.value, qty: basis.qty } : null)
}

// ---------------------------------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------------------------------

interface ReviewLineRecord extends Record<string, unknown> {
  id: string
  location_id: string
  location_name: string
  material_id: string
  material_name: string
  unit: StandardUnit
  counted_qty: string | null
}

/**
 * `count.review` (counts.manage), a draft only (DOCUMENT_POSTED once finalized or reversed: what it
 * found is stored on its lines, which `count.get` returns to managers): each line in the caller's
 * branches with what was counted and, for a count, what the book expects at the end of its day, the
 * difference and, with the costs switch, what finalizing now would move the stock's value by (at
 * today's average); a first count instead says what each material would start at (counted in every
 * branch × that day's 90-day average) and which live branches still miss a line of a material
 * (`missingLines`). Its `version` is the one `count.finalize` names.
 */
export async function reviewCount(ctx: BusinessCtx, input: IdInput): Promise<CountReviewDto> {
  return ctx.tx(async (tx) => {
    const head = await readHead(tx, ctx.businessId, input.id)
    if (!head || !mayRead(ctx, head)) throw new AppError('not_found')
    if (head.status !== 'draft') throw new AppError('document_posted')
    const lines = (await tx.execute(sql`
      select l.id, l.location_id, loc.name as location_name, l.material_id,
             m.name as material_name, m.unit, trim_scale(l.counted_base_qty)::text as counted_qty
        from app.stock_count_lines l
        join app.materials m on m.business_id = l.business_id and m.id = l.material_id
        join app.locations loc on loc.business_id = l.business_id and loc.id = l.location_id
       where l.business_id = ${ctx.businessId} and l.count_id = ${head.id}
         and l.deleted_at is null
       order by lower(m.name), m.id, lower(loc.name), loc.id
    `)) as unknown as ReviewLineRecord[]
    const mine = lines.filter((l) => inBranch(ctx, l.location_id))
    assertOpeningInScope(ctx, head, mine.length)
    const openings: CountReviewDto['data']['openings'] = []
    const reviewed: CountReviewDto['data']['lines'] = []
    const missingLines: CountReviewDto['data']['missingLines'] = []
    // What a first count starts each material at counts every branch: shown to a member who works in
    // every branch (who alone may finalize it).
    if (head.kind === 'opening' && ctx.access.locationScope.all) {
      const ids = [...new Set(lines.map((l) => l.material_id))]
      const records = await costRecordsOf(tx, ctx.businessId, ids, head.business_date)
      for (const materialId of ids) {
        const own = lines.filter((l) => l.material_id === materialId)
        const counted = sumDecimals(own.map((l) => l.counted_qty ?? '0'))
        const record = records.get(materialId)
        const opening = record ? openingFor(record, counted) : null
        openings.push({
          materialId,
          countedQty: counted,
          avgPerUnit:
            opening?.avgCost != null
              ? costRatio([opening.avgCost, STANDARD_UNITS[own[0]!.unit].factor], ['1'])
              : null,
          value: opening?.value ?? '0',
        })
      }
    }
    if (head.kind === 'opening') {
      for (const l of mine) {
        reviewed.push({
          lineId: l.id,
          locationId: l.location_id,
          locationName: l.location_name,
          materialId: l.material_id,
          materialName: l.material_name,
          countedQty: l.counted_qty,
          expectedQty: null,
          differenceQty: null,
          differenceValue: null,
        })
      }
      // Each material in every live branch of the caller's: a branch added since it started has no
      // line yet (finalizing needs one, COUNT_INCOMPLETE; count.addLines brings it).
      const live = (await tx.execute(sql`
        select l.id, l.name from app.locations l
         where l.business_id = ${ctx.businessId} and l.deleted_at is null
           and ${inScope(ctx, sql`l.id`)}
         order by lower(l.name), l.id
      `)) as unknown as { id: string; name: string }[]
      const have = new Set(lines.map((l) => pairKey(l.location_id, l.material_id)))
      for (const materialId of new Set(lines.map((l) => l.material_id))) {
        for (const branch of live) {
          if (have.has(pairKey(branch.id, materialId))) continue
          missingLines.push({ locationId: branch.id, locationName: branch.name, materialId })
        }
      }
    } else {
      const { book } = await booksAt(
        tx,
        ctx.businessId,
        mine.map((l) => ({ locationId: l.location_id, materialId: l.material_id })),
        head.business_date,
      )
      const states = await costStates(
        tx,
        ctx.businessId,
        mine.map((l) => l.material_id),
      )
      for (const l of mine) {
        const expected = book.get(pairKey(l.location_id, l.material_id)) ?? '0'
        const difference =
          l.counted_qty === null
            ? null
            : countDifference(l.counted_qty as Quantity, expected as Quantity)
        reviewed.push({
          lineId: l.id,
          locationId: l.location_id,
          locationName: l.location_name,
          materialId: l.material_id,
          materialName: l.material_name,
          countedQty: l.counted_qty,
          expectedQty: expected,
          differenceQty: difference,
          differenceValue:
            difference === null
              ? null
              : compareDecimal(difference, '0') === 0
                ? '0'
                : wacCount(states.get(l.material_id) ?? EMPTY_WAC_STATE, difference).value,
        })
      }
    }
    return result({
      id: head.id,
      kind: head.kind,
      status: head.status,
      businessDate: head.business_date,
      lines: reviewed,
      notCounted: mine.filter((l) => l.counted_qty === null).length,
      openings,
      missingLines,
      version: head.version,
    })
  })
}

function inBranch(ctx: BusinessCtx, locationId: string): boolean {
  try {
    assertBranch(ctx, locationId)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------------------------------
// Finalizing
// ---------------------------------------------------------------------------------------------------

interface FinalLine extends Record<string, unknown> {
  id: string
  location_id: string
  material_id: string
  counted_qty: string | null
  location_live: boolean
}

/**
 * The materials, locked by ascending id (lock 3): FOR SHARE, or FOR NO KEY UPDATE for a first count
 * (which sets or clears their stock_tracked_from). Returns the live ones with their tracking.
 */
async function lockCountMaterials(
  tx: Tx,
  businessId: string,
  ids: readonly string[],
  mode: 'share' | 'no key update',
): Promise<Map<string, MaterialState>> {
  const sorted = [...new Set(ids)].sort()
  if (sorted.length === 0) return new Map()
  const rows = (await tx.execute(sql`
    select m.id, m.name, m.archived_at is not null as archived,
           m.stock_tracked_from::text as tracked_from
      from app.materials m
     where m.business_id = ${businessId} and m.id = any(${uuidArray(sorted)})
       and m.deleted_at is null
     order by m.id
       for ${mode === 'share' ? sql`share` : sql`no key update`}
  `)) as unknown as MaterialState[]
  return new Map(rows.map((r) => [r.id, r] as const))
}

/** Movements of a finalize or a reversal, inserted in one statement; each cost row's last seq set. */
async function insertCountMovements(
  tx: Tx,
  costs: Map<string, CostRow>,
  rows: readonly NewStockMovement[],
): Promise<void> {
  if (rows.length === 0) return
  const inserted = await tx
    .insert(stockMovements)
    .values([...rows])
    .returning({ materialId: stockMovements.materialId, seq: stockMovements.seq })
  for (const row of inserted) {
    const cost = costs.get(row.materialId)!
    if (cost.lastSeq === null || row.seq > cost.lastSeq) cost.lastSeq = row.seq
  }
}

/**
 * `count.finalize` (counts.manage): the draft (its `version` as `count.review` returned it: a line
 * changed since is CONFLICT) becomes posted and sets the stock (see the rules at the top).
 * Idempotent: a count already posted (or reversed since) is returned as it is. Refused: a date after
 * today (FUTURE_DATE) or into closed books (BOOKS_CLOSED); no line (VALIDATION); a line not counted
 * (COUNT_INCOMPLETE); a first count of a material already tracked (STOCK_TRACKED), not covering every
 * active branch for each material (COUNT_INCOMPLETE), with a line at a removed branch (VALIDATION),
 * dated before an entry already recorded for one of its materials (COUNT_OUT_OF_ORDER), or while a
 * removed branch holds stock of one of them (BRANCH_HAS_STOCK); a count of a material not tracked
 * (STOCK_NOT_TRACKED), dated on or before its material's first count or a finalized count of one of
 * its lines (COUNT_OUT_OF_ORDER).
 */
export async function finalizeCount(
  ctx: BusinessCtx,
  input: VersionInput,
): Promise<CountResultDto> {
  return ctx.tx(async (tx) => {
    const head = await lockCount(tx, ctx, input.id)
    assertCovers(ctx, head)
    if (head.status !== 'draft') return result(await readCount(tx, ctx, head.id))
    if (head.version !== input.version) throw new AppError('conflict')
    const business = await lockPostingBusiness(tx, ctx.businessId)
    assertPostable(business, head.business_date)
    const lines = (await tx.execute(sql`
      select l.id, l.location_id, l.material_id,
             trim_scale(l.counted_base_qty)::text as counted_qty,
             loc.deleted_at is null as location_live
        from app.stock_count_lines l
        join app.locations loc on loc.business_id = l.business_id and loc.id = l.location_id
       where l.business_id = ${ctx.businessId} and l.count_id = ${head.id} and l.deleted_at is null
       order by l.material_id, l.location_id
    `)) as unknown as FinalLine[]
    if (lines.length === 0) throw invalid('lines: a count needs a line to finalize')
    if (lines.some((l) => l.counted_qty === null)) throw new AppError('count_incomplete')
    const opening = head.kind === 'opening'
    const materialIds = [...new Set(lines.map((l) => l.material_id))].sort()
    const states = await lockCountMaterials(
      tx,
      ctx.businessId,
      materialIds,
      opening ? 'no key update' : 'share',
    )
    if (materialIds.some((id) => !states.has(id))) throw invalid('lines: a material was removed')
    if (lines.some((l) => !l.location_live)) throw invalid('lines: a branch was removed')
    if (opening) {
      const tracked = [...states.values()].filter((m) => m.tracked_from !== null)
      if (tracked.length > 0) {
        throw new AppError('stock_tracked', { names: tracked.map((m) => m.name) })
      }
      const branches = await activeBranches(tx, ctx.businessId)
      const have = new Set(lines.map((l) => pairKey(l.location_id, l.material_id)))
      if (materialIds.some((m) => branches.some((b) => !have.has(pairKey(b, m))))) {
        throw new AppError('count_incomplete', { message: 'a branch is missing' })
      }
    } else {
      const untracked = [...states.values()].filter((m) => m.tracked_from === null)
      if (untracked.length > 0) {
        throw new AppError('stock_not_tracked', { names: untracked.map((m) => m.name) })
      }
    }

    const costs = await lockCostRows(tx, ctx.businessId, materialIds)
    const pairs = lines.map((l) => ({ locationId: l.location_id, materialId: l.material_id }))
    const balances = await lockBalances(tx, ctx.businessId, pairs)
    // With the materials, cost rows and balances locked, nothing else posts for these materials (nor
    // finalizes or reverses another count of them): what other counts and entries say is settled.
    if (opening) {
      await assertNoEntryAfter(tx, ctx.businessId, materialIds, head.business_date)
      await assertNoRemovedBranchStock(tx, ctx.businessId, materialIds)
    } else {
      await assertCountDayFree(
        tx,
        ctx.businessId,
        head.location_id!,
        materialIds,
        head.business_date,
        head.id,
      )
    }

    const { balance, book } = await booksAt(tx, ctx.businessId, pairs, head.business_date)
    const movements: NewStockMovement[] = []
    const results: Record<string, string | null>[] = []
    if (opening) {
      const records = await costRecordsOf(tx, ctx.businessId, materialIds, head.business_date)
      for (const materialId of materialIds) {
        const own = lines.filter((l) => l.material_id === materialId)
        const counted = own.map((l) => l.counted_qty as Quantity)
        const record = records.get(materialId)
        if (!record) throw invalid('lines: a material was removed')
        const start = openingFor(record, sumDecimals(counted))
        const row = costs.get(materialId)!
        const shares = openingRows(counted, start.value as CostAmount, row.state.value)
        row.state = wacOpen(row.state, start).state
        row.changed = true
        for (const [index, line] of own.entries()) {
          const before = balance.get(pairKey(line.location_id, materialId)) ?? '0'
          const qty = countDifference(counted[index]!, before as Quantity)
          const share = shares[index]!
          movements.push({
            id: newId(),
            businessId: ctx.businessId,
            businessDate: head.business_date,
            locationId: line.location_id,
            materialId,
            kind: 'opening',
            qty,
            value: share.value,
            adjustment: share.adjustment,
            unitCost: start.avgCost,
            countLineId: line.id,
          })
          moveBalance(balances, line.location_id, materialId, qty, addDecimal)
          results.push({
            id: line.id,
            book: before,
            difference: qty,
            value: subtractDecimals(share.value, share.adjustment),
            unit_cost: start.avgCost,
          })
        }
      }
    } else {
      for (const line of lines) {
        const expected = book.get(pairKey(line.location_id, line.material_id)) ?? '0'
        const difference = countDifference(line.counted_qty as Quantity, expected as Quantity)
        const row = costs.get(line.material_id)!
        if (compareDecimal(difference, '0') === 0) {
          results.push({
            id: line.id,
            book: expected,
            difference: '0',
            value: '0',
            unit_cost: row.state.avgCost,
          })
          continue
        }
        const step = wacCount(row.state, difference)
        row.state = step.state
        row.changed = true
        movements.push({
          id: newId(),
          businessId: ctx.businessId,
          businessDate: head.business_date,
          locationId: line.location_id,
          materialId: line.material_id,
          kind: 'count',
          qty: difference,
          value: step.value,
          adjustment: step.adjustment,
          unitCost: step.unitCost,
          countLineId: line.id,
        })
        moveBalance(balances, line.location_id, line.material_id, difference, addDecimal)
        results.push({
          id: line.id,
          book: expected,
          difference,
          value: step.value,
          unit_cost: step.unitCost,
        })
      }
    }
    await insertCountMovements(tx, costs, movements)
    await writeProjections(tx, ctx.businessId, costs, balances)
    // What each line found, in one statement (the count is still a draft: its lines may change).
    await tx.execute(sql`
      update app.stock_count_lines l
         set book_base_qty = v.book::numeric, difference_qty = v.difference::numeric,
             difference_value = v.value::numeric, unit_cost = v.unit_cost::numeric
        from jsonb_to_recordset(${jsonRecords(results)})
             as v(id uuid, book text, difference text, value text, unit_cost text)
       where l.business_id = ${ctx.businessId} and l.id = v.id
    `)
    await tx
      .update(stockCounts)
      .set({ status: 'posted', postedAt: sql`now()`, postedBy: sql`app.current_user_id()` })
      .where(and(eq(stockCounts.businessId, ctx.businessId), eq(stockCounts.id, head.id)))
    if (opening) {
      // After the count is posted (the database checks a tracked material has a first count standing).
      await tx
        .update(materialsTable)
        .set({ stockTrackedFrom: head.business_date })
        .where(
          and(
            eq(materialsTable.businessId, ctx.businessId),
            inArray(materialsTable.id, materialIds),
          ),
        )
    }
    return result(await readCount(tx, ctx, head.id))
  })
}

// ---------------------------------------------------------------------------------------------------
// Reversal
// ---------------------------------------------------------------------------------------------------

interface CountMovementRecord extends Record<string, unknown> {
  id: string
  material_id: string
  location_id: string
  qty: string
  value: string
  adjustment: string
  unit_cost: string | null
  count_line_id: string
}

/**
 * `count.reverse` (counts.manage): as if never finalized (each material's ledger replayed without
 * it, D-109), dated the count's own day or the first open day (D-114 rule 3). Idempotent: a reversed
 * count is returned as it is. DOCUMENT_NOT_POSTED for a draft; HAS_LATER_COUNTS while a later finalized
 * count of one of its lines stands (a first count: of one of its materials, anywhere; that count is
 * reversed first); a first count, STOCK_USED_SINCE while something that took stock of one of its
 * materials out since stands (the plan's "only while nothing has taken stock out since"; today a
 * supplier return; a later count is HAS_LATER_COUNTS). A first count's reversal stops tracking its
 * materials (back to the 90-day average, D-115): its rows go back out, and with them the book they
 * replaced comes back.
 */
export async function reverseCount(ctx: BusinessCtx, input: IdInput): Promise<CountResultDto> {
  return ctx.tx(async (tx) => {
    const head = await lockCount(tx, ctx, input.id)
    assertCovers(ctx, head)
    if (head.status === 'reversed') return result(await readCount(tx, ctx, head.id))
    if (head.status !== 'posted') throw new AppError('document_not_posted')
    const business = await lockPostingBusiness(tx, ctx.businessId)
    const reversalDate = reversalDateOf(business, head.business_date)
    const opening = head.kind === 'opening'
    const lines = (await tx.execute(sql`
      select l.location_id, l.material_id from app.stock_count_lines l
       where l.business_id = ${ctx.businessId} and l.count_id = ${head.id} and l.deleted_at is null
    `)) as unknown as { location_id: string; material_id: string }[]
    const materialIds = [...new Set(lines.map((l) => l.material_id))].sort()
    await lockCountMaterials(tx, ctx.businessId, materialIds, opening ? 'no key update' : 'share')
    const rows = (await tx.execute(sql`
      select m.id, m.material_id, m.location_id, trim_scale(m.qty)::text as qty,
             trim_scale(m.value)::text as value, trim_scale(m.adjustment)::text as adjustment,
             trim_scale(m.unit_cost)::text as unit_cost, m.count_line_id
        from app.stock_movements m
        join app.stock_count_lines l on l.business_id = m.business_id and l.id = m.count_line_id
       where m.business_id = ${ctx.businessId} and l.count_id = ${head.id}
         and m.kind in ('opening', 'count')
         and not exists (
           select 1 from app.stock_movements r
            where r.business_id = m.business_id and r.reverses_id = m.id)
       order by m.seq
    `)) as unknown as CountMovementRecord[]
    const moved = [...new Set(rows.map((r) => r.material_id))].sort()
    // Every material's cost row, not only those its rows moved: a line that found no difference has
    // no row, and its later counts are checked below under this lock too.
    const costs = await lockCostRows(tx, ctx.businessId, materialIds)
    const balances = await lockBalances(
      tx,
      ctx.businessId,
      rows.map((r) => ({ locationId: r.location_id, materialId: r.material_id })),
    )
    // With the cost rows locked, no other count of these materials is finalized in between.
    const later = opening
      ? sql`l.material_id = any(${uuidArray(materialIds)})`
      : sql`c.business_date > ${head.business_date}::date
            and (l.location_id, l.material_id) in (
              select p.location_id, p.material_id
                from unnest(${uuidArray(lines.map((l) => l.location_id))},
                            ${uuidArray(lines.map((l) => l.material_id))})
                     as p(location_id, material_id))`
    const [found] = (await tx.execute(sql`
      select 1 as found
        from app.stock_count_lines l
        join app.stock_counts c on c.business_id = l.business_id and c.id = l.count_id
       where l.business_id = ${ctx.businessId} and l.deleted_at is null
         and c.deleted_at is null and c.status = 'posted' and c.id <> ${head.id}
         and ${later}
       limit 1
    `)) as unknown as { found: number }[]
    if (found) throw new AppError('has_later_counts')
    if (opening) {
      // What took quantity out of one of its materials after its rows, and stands (not a count's row
      // nor a reversal: those are checked above, or put back what their document moved).
      const used = (await tx.execute(sql`
        select mat.name
          from app.materials mat
         where mat.business_id = ${ctx.businessId} and mat.id = any(${uuidArray(materialIds)})
           and exists (
             select 1
               from app.stock_movements x
              where x.business_id = mat.business_id and x.material_id = mat.id
                and x.qty < 0 and x.kind <> 'reversal' and x.count_line_id is null
                and exists (
                  select 1
                    from app.stock_movements o
                    join app.stock_count_lines l
                      on l.business_id = o.business_id and l.id = o.count_line_id
                   where o.business_id = x.business_id and o.material_id = x.material_id
                     and o.kind = 'opening' and l.count_id = ${head.id} and o.seq < x.seq)
                and not exists (
                  select 1 from app.stock_movements r
                   where r.business_id = x.business_id and r.reverses_id = x.id))
         order by lower(mat.name), mat.id
      `)) as unknown as { name: string }[]
      if (used.length > 0) {
        throw new AppError('stock_used_since', { names: used.map((u) => u.name) })
      }
    }

    const movements: NewStockMovement[] = []
    for (const materialId of moved) {
      const own = rows.filter((r) => r.material_id === materialId)
      const ledger = toWacMovements(await materialLedger(tx, ctx.businessId, materialId))
      const replay = replayWithNew(
        ledger,
        opening
          ? [{ type: 'opening_reversal', openingId: own[0]!.id }]
          : own.map((r) => ({ type: 'count_reversal' as const, countId: r.id })),
      )
      for (const [index, r] of own.entries()) {
        // A first count's rows are one opening: the reversal's adjustment goes on its first row, and
        // each row takes back what it moved the value by (value − adjustment).
        const adjustment = opening
          ? index === 0
            ? replay.newSteps[0]!.adjustment
            : '0'
          : replay.newSteps[index]!.adjustment
        movements.push({
          id: newId(),
          businessId: ctx.businessId,
          businessDate: reversalDate,
          locationId: r.location_id,
          materialId,
          kind: 'reversal',
          qty: negate(r.qty),
          value: opening ? subtractDecimals(r.adjustment, r.value) : negate(r.value),
          adjustment,
          unitCost: r.unit_cost,
          reversesId: r.id,
          countLineId: r.count_line_id,
        })
        moveBalance(balances, r.location_id, materialId, negate(r.qty), addDecimal)
      }
      const row = costs.get(materialId)!
      row.state = replay.state
      row.changed = true
    }
    await insertCountMovements(tx, costs, movements)
    await writeProjections(tx, ctx.businessId, costs, balances)
    await tx
      .update(stockCounts)
      .set({
        status: 'reversed',
        reversedAt: sql`now()`,
        reversedBy: sql`app.current_user_id()`,
        reversalDate,
      })
      .where(and(eq(stockCounts.businessId, ctx.businessId), eq(stockCounts.id, head.id)))
    if (opening) {
      await tx
        .update(materialsTable)
        .set({ stockTrackedFrom: null })
        .where(
          and(
            eq(materialsTable.businessId, ctx.businessId),
            inArray(materialsTable.id, materialIds),
          ),
        )
    }
    return result(await readCount(tx, ctx, head.id))
  })
}
