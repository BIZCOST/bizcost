import { materialCosts, stockBalances, stockMovements, type Tx } from '@bizcost/db'
import {
  costRatio,
  isCurrencyCode,
  newId,
  replayWac,
  sumDecimals,
  type CostAmount,
  type CurrencyCode,
  type Quantity,
  type StockMovementKind,
  type UnitCost,
  type WacMovement,
  type WacState,
} from '@bizcost/domain'
import { and, eq, sql } from 'drizzle-orm'
import { AppError } from '../errors'

// The stock ledger and its projections (D-006, D-109, D-110, D-114, D-120; docs/DATA_MODEL.md §6).
// Every posting runs in ONE transaction and takes its locks in this order, so postings that touch the
// same materials wait for each other and none deadlock (D-110 rule 3):
//   1. the document being posted or reversed (FOR UPDATE; a return or credit note then its purchase,
//      FOR SHARE), taken by the caller;
//   2. the business row FOR SHARE (lockPostingBusiness): the books-closed date cannot change until the
//      posting commits, and a change of it waits for the postings in flight;
//   3. the materials FOR SHARE, by ascending id (their units cannot change under the posting);
//   4. the material cost rows FOR UPDATE, by ascending material id (created first when missing);
//   5. the location balances FOR UPDATE, by ascending (location id, material id);
// then the movements are inserted (their `seq`, the posting order, is taken on insert, after the
// locks) and the projections written. Receipts update the cost row with wacReceive; returns, credits
// and reversals replay the material's ledger (replayWac), which is also what a rebuild does.
//
// Sales (M3 Step 2, D-228) take no stock and never change a cost row's values (D-219), but freeze
// their cost from the purchases posted, in the same order: the sale FOR UPDATE, the business row FOR
// SHARE, the materials' cost rows (missing ones inserted, ON CONFLICT DO NOTHING) FOR SHARE by
// ascending material id (sale-costs.ts). After lock 5 a purchase posting, and a return's or credit
// note's reversal (its goods stand again, D-236), take one more step: the lines of finalized sales
// still without a price for its materials, FOR NO KEY UPDATE by ascending id, to fill them once (lock
// 6, the edge cost rows → sale lines). Setting the owner's hourly rate locks
// the business row, then those lines (business row → sale lines). Nothing locks a cost row or the
// business row while holding a sale line, and a sale's reversal locks only its header, so none of
// these wait in a cycle.
//
// Counts (M4 Step 2, D-339, D-340) are documents posted in the same order: the count FOR UPDATE, the
// business row FOR SHARE, its materials (FOR SHARE; FOR NO KEY UPDATE for a first count, which sets
// or clears materials.stock_tracked_from, so no posting holding a material FOR SHARE waits on it while
// it waits for that posting's cost row), the cost rows, the balances. A first count writes one
// `opening` row per branch line of each material and the cost engine reads them back as ONE opening
// (toWacMovements); a later count one `count` row per line that found a difference.

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A uuid[] of `ids` for raw SQL, as ONE parameter (an array literal; drizzle would expand a JS array
 * into a parameter each). No number of ids reaches the driver's limit of 65,534 parameters per
 * statement (postgres.js MAX_PARAMETERS_EXCEEDED): a purchase may fill the material rows of thousands
 * of sales (D-229). Each id is checked first, so the literal holds uuids only.
 */
export function uuidArray(ids: readonly string[]) {
  for (const id of ids) {
    if (!UUID_TEXT.test(id)) throw new AppError('validation', { message: 'invalid id' })
  }
  return sql`${`{${ids.join(',')}}`}::text::uuid[]`
}

/**
 * Rows for raw SQL as ONE jsonb parameter, read with `jsonb_to_recordset(…) as v(col type, …)`: a
 * set-based insert or update of any number of rows stays one statement under the driver's limit of
 * parameters. Decimal strings stay strings (their exact text feeds `numeric`'s input, never a float).
 */
export function jsonRecords(rows: readonly Record<string, string | boolean | null>[]) {
  return sql`${JSON.stringify(rows)}::text::jsonb`
}

/** The types a column of rows may be read as (columnArray). */
type ColumnType = 'uuid' | 'int' | 'date' | 'text' | 'numeric' | 'boolean'

/** What an element of an array literal escapes inside its double quotes. */
const ARRAY_ESCAPED = /[\\"]/g

/**
 * One column of many rows for raw SQL as ONE array parameter, the columns read together with
 * `unnest(a, b, …) as v(…)`: an import's tens of thousands of staged rows and sale lines send each
 * value once (jsonRecords sends every key with every value, and Postgres reads it as jsonb first).
 * Every element is quoted, its backslashes and double quotes escaped, and null is NULL; decimal
 * strings stay text until `numeric` reads them. `type` is one of a fixed few, never input.
 */
export function columnArray(values: readonly (string | boolean | null)[], type: ColumnType) {
  const elements = values.map((value) =>
    value === null ? 'NULL' : `"${String(value).replace(ARRAY_ESCAPED, '\\$&')}"`,
  )
  return sql`${`{${elements.join(',')}}`}::text::${sql.raw(type)}[]`
}

/** An instant from raw SQL (the driver hands timestamps over as text) as an ISO string. */
export function isoOf(value: Date | string): string
export function isoOf(value: Date | string | null): string | null
export function isoOf(value: Date | string | null): string | null {
  if (value === null) return null
  return (value instanceof Date ? value : new Date(value)).toISOString()
}

/** What a posting needs of the business, read with its row locked FOR SHARE. */
export interface PostingBusiness {
  /** "Books closed up to" (D-114 rule 6), YYYY-MM-DD; null when open. */
  readonly closedThrough: string | null
  /** Today in the business's time zone, YYYY-MM-DD. */
  readonly today: string
  readonly vatRegistered: boolean
  readonly currency: CurrencyCode
}

interface BusinessRow extends Record<string, unknown> {
  closed_through: string | null
  today: string
  vat_registered: boolean
  currency: string
}

/** Locks the business row FOR SHARE and reads what a posting checks (lock 2). */
export async function lockPostingBusiness(tx: Tx, businessId: string): Promise<PostingBusiness> {
  const [row] = (await tx.execute(sql`
    select b.books_closed_through::text as closed_through,
           (now() at time zone b.timezone)::date::text as today,
           b.vat_registered,
           trim(b.currency) as currency
      from app.businesses b
     where b.id = ${businessId} and b.deleted_at is null
       for share
  `)) as unknown as BusinessRow[]
  if (!row) throw new AppError('forbidden')
  if (!isCurrencyCode(row.currency)) {
    throw new AppError('internal', { message: `unsupported currency ${row.currency}` })
  }
  return {
    closedThrough: row.closed_through,
    today: row.today,
    vatRegistered: row.vat_registered,
    currency: row.currency,
  }
}

/** The day after `date` (YYYY-MM-DD). */
export function dayAfter(date: string): string {
  const next = new Date(`${date}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString().slice(0, 10)
}

/**
 * The checks of a posting's business day: never after today (FUTURE_DATE), never on or before the
 * books-closed date (BOOKS_CLOSED).
 */
export function assertPostable(business: PostingBusiness, businessDate: string): void {
  if (businessDate > business.today) throw new AppError('future_date')
  if (business.closedThrough !== null && businessDate <= business.closedThrough) {
    throw new AppError('books_closed')
  }
}

/**
 * The business day of a reversal: the document's own day, or the first open day when the books are
 * closed on it (D-114 rule 3; D-120 rule 1). BOOKS_CLOSED when that day is after today (the books are
 * closed up to today): like a posting, a reversal is never dated in the future.
 */
export function reversalDateOf(business: PostingBusiness, businessDate: string): string {
  if (business.closedThrough === null || businessDate > business.closedThrough) return businessDate
  const firstOpen = dayAfter(business.closedThrough)
  if (firstOpen > business.today) throw new AppError('books_closed')
  return firstOpen
}

/**
 * Locks the materials FOR SHARE by ascending id (lock 3; a draft save takes it too before it reads
 * their units, D-145); returns the ids found (live ones).
 */
export async function lockMaterials(
  tx: Tx,
  businessId: string,
  materialIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(materialIds)].sort()
  if (ids.length === 0) return new Set()
  const rows = (await tx.execute(sql`
    select m.id from app.materials m
     where m.business_id = ${businessId}
       and m.id = any(${uuidArray(ids)})
       and m.deleted_at is null
     order by m.id
       for share
  `)) as unknown as { id: string }[]
  return new Set(rows.map((row) => row.id))
}

/** A material's cost row (its projection), locked. */
export interface CostRow {
  readonly id: string
  readonly materialId: string
  state: WacState
  lastSeq: number | null
  changed: boolean
}

interface CostRowRecord extends Record<string, unknown> {
  id: string
  material_id: string
  qty: string
  value: string
  avg_cost: string | null
  last_seq: string | number | null
}

/**
 * The cost rows of the materials, created when missing, locked FOR UPDATE by ascending material id
 * (lock 4).
 */
export async function lockCostRows(
  tx: Tx,
  businessId: string,
  materialIds: readonly string[],
): Promise<Map<string, CostRow>> {
  const ids = [...new Set(materialIds)].sort()
  const rows = new Map<string, CostRow>()
  if (ids.length === 0) return rows
  // One statement, in ascending order: concurrent postings create and wait in the same order.
  await tx
    .insert(materialCosts)
    .values(ids.map((materialId) => ({ id: newId(), businessId, materialId })))
    .onConflictDoNothing({ target: [materialCosts.businessId, materialCosts.materialId] })
  const records = (await tx.execute(sql`
    select c.id, c.material_id, trim_scale(c.qty)::text as qty, trim_scale(c.value)::text as value,
           trim_scale(c.avg_cost)::text as avg_cost, c.last_seq
      from app.material_costs c
     where c.business_id = ${businessId} and c.material_id = any(${uuidArray(ids)})
     order by c.material_id
       for update
  `)) as unknown as CostRowRecord[]
  for (const record of records) {
    rows.set(record.material_id, {
      id: record.id,
      materialId: record.material_id,
      state: {
        qty: record.qty as Quantity,
        value: record.value as CostAmount,
        avgCost: record.avg_cost as UnitCost | null,
      },
      lastSeq: record.last_seq === null ? null : Number(record.last_seq),
      changed: false,
    })
  }
  return rows
}

/** A location balance (quantity of a material at a location), locked. */
export interface BalanceRow {
  readonly id: string
  delta: string
}

const balanceKey = (locationId: string, materialId: string) => `${locationId}:${materialId}`

/**
 * The balances of (location, material) pairs, created when missing, locked FOR UPDATE by ascending
 * (location id, material id) (lock 5). Keyed by `${locationId}:${materialId}`.
 */
export async function lockBalances(
  tx: Tx,
  businessId: string,
  pairs: readonly { locationId: string; materialId: string }[],
): Promise<Map<string, BalanceRow>> {
  const unique = [
    ...new Map(pairs.map((p) => [balanceKey(p.locationId, p.materialId), p] as const)).values(),
  ].sort((a, b) =>
    a.locationId === b.locationId
      ? a.materialId.localeCompare(b.materialId)
      : a.locationId.localeCompare(b.locationId),
  )
  const rows = new Map<string, BalanceRow>()
  if (unique.length === 0) return rows
  await tx
    .insert(stockBalances)
    .values(unique.map((p) => ({ id: newId(), businessId, ...p })))
    .onConflictDoNothing({
      target: [stockBalances.businessId, stockBalances.locationId, stockBalances.materialId],
    })
  const locations = unique.map((p) => p.locationId)
  const materials = unique.map((p) => p.materialId)
  const records = (await tx.execute(sql`
    select b.id, b.location_id, b.material_id
      from app.stock_balances b
      join unnest(${uuidArray(locations)}, ${uuidArray(materials)}) as p(location_id, material_id)
        on p.location_id = b.location_id and p.material_id = b.material_id
     where b.business_id = ${businessId}
     order by b.location_id, b.material_id
       for update of b
  `)) as unknown as { id: string; location_id: string; material_id: string }[]
  for (const record of records) {
    rows.set(balanceKey(record.location_id, record.material_id), { id: record.id, delta: '0' })
  }
  return rows
}

/** Adds `qty` (signed) to a locked balance. */
export function moveBalance(
  balances: Map<string, BalanceRow>,
  locationId: string,
  materialId: string,
  qty: string,
  add: (a: string, b: string) => string,
): void {
  const row = balances.get(balanceKey(locationId, materialId))
  if (!row) throw new AppError('internal', { message: 'balance not locked' })
  row.delta = add(row.delta, qty)
}

/** Writes the locked projections that changed. */
export async function writeProjections(
  tx: Tx,
  businessId: string,
  costs: Map<string, CostRow>,
  balances: Map<string, BalanceRow>,
): Promise<void> {
  for (const row of costs.values()) {
    if (!row.changed) continue
    await tx
      .update(materialCosts)
      .set({
        qty: row.state.qty,
        value: row.state.value,
        avgCost: row.state.avgCost,
        lastSeq: row.lastSeq,
      })
      .where(and(eq(materialCosts.businessId, businessId), eq(materialCosts.id, row.id)))
  }
  for (const row of balances.values()) {
    if (row.delta === '0') continue
    await tx
      .update(stockBalances)
      .set({ qty: sql`${stockBalances.qty} + ${row.delta}::numeric` })
      .where(and(eq(stockBalances.businessId, businessId), eq(stockBalances.id, row.id)))
  }
}

/** One movement of a material's ledger, as stored. */
export interface LedgerEntry {
  readonly id: string
  readonly kind: StockMovementKind
  readonly locationId: string
  readonly qty: string
  readonly value: string
  readonly receiptId: string | null
  readonly reversesId: string | null
  readonly reversesKind: StockMovementKind | null
  readonly purchaseLineId: string | null
  readonly returnLineId: string | null
  /** An opening or count row, or its reversal: its count line, that line's count and what it counted. */
  readonly countLineId: string | null
  readonly countId: string | null
  readonly countedQty: string | null
  /** As stored: the average an opening started at (per base unit). */
  readonly unitCost: string | null
}

interface LedgerRecord extends Record<string, unknown> {
  id: string
  kind: StockMovementKind
  location_id: string
  qty: string
  value: string
  receipt_id: string | null
  reverses_id: string | null
  reverses_kind: StockMovementKind | null
  purchase_line_id: string | null
  return_line_id: string | null
  count_line_id: string | null
  count_id: string | null
  counted_qty: string | null
  unit_cost: string | null
}

/** Every movement of a material, in posting order. */
export async function materialLedger(
  tx: Tx,
  businessId: string,
  materialId: string,
): Promise<LedgerEntry[]> {
  const records = (await tx.execute(sql`
    select m.id, m.kind, m.location_id, trim_scale(m.qty)::text as qty,
           trim_scale(m.value)::text as value, m.receipt_id, m.reverses_id,
           r.kind as reverses_kind, m.purchase_line_id, m.return_line_id, m.count_line_id,
           cl.count_id, trim_scale(cl.counted_base_qty)::text as counted_qty,
           trim_scale(m.unit_cost)::text as unit_cost
      from app.stock_movements m
      left join app.stock_movements r on r.business_id = m.business_id and r.id = m.reverses_id
      left join app.stock_count_lines cl
        on cl.business_id = m.business_id and cl.id = m.count_line_id
     where m.business_id = ${businessId} and m.material_id = ${materialId}
     order by m.seq
  `)) as unknown as LedgerRecord[]
  return records.map((r) => ({
    id: r.id,
    kind: r.kind,
    locationId: r.location_id,
    qty: r.qty,
    value: r.value,
    receiptId: r.receipt_id,
    reversesId: r.reverses_id,
    reversesKind: r.reverses_kind,
    purchaseLineId: r.purchase_line_id,
    returnLineId: r.return_line_id,
    countLineId: r.count_line_id,
    countId: r.count_id,
    countedQty: r.counted_qty,
    unitCost: r.unit_cost,
  }))
}

/** Negates a decimal string ("-" added or taken off; "0" stays). */
export function negate(value: string): string {
  if (value === '0' || /^-?0(?:\.0+)?$/.test(value)) return '0'
  return value.startsWith('-') ? value.slice(1) : `-${value}`
}

/**
 * The WAC engine's movements for a stored ledger (values as posted). A first count's rows of one
 * material (one per branch line, consecutive: posted together under its cost row's lock) are ONE
 * opening: its id the first row's, its quantity what the lines counted together, its value the rows'
 * values added (each row's adjustment is its share of the book the count replaced), at the average
 * it started at; their reversal rows are ONE opening_reversal. A count's row is a count difference.
 */
export function toWacMovements(ledger: readonly LedgerEntry[]): WacMovement[] {
  const out: WacMovement[] = []
  // The opening being read (its count, what it adds up to so far, where it is in `out`), the count
  // whose opening the last reversal read undid, and each count's opening id.
  let open: { countId: string; qty: string; value: string; at: number } | null = null
  let undone: string | null = null
  const openingIds = new Map<string, string>()
  for (const entry of ledger) {
    if (entry.kind === 'opening') {
      const countId = entry.countId ?? ''
      undone = null
      if (open !== null && open.countId === countId && open.at === out.length - 1) {
        open.qty = sumDecimals([open.qty, entry.countedQty ?? '0'])
        open.value = sumDecimals([open.value, entry.value])
        const first = out[open.at] as Extract<WacMovement, { type: 'opening' }>
        out[open.at] = { ...first, qty: open.qty as Quantity, value: open.value as CostAmount }
        continue
      }
      openingIds.set(countId, entry.id)
      open = { countId, qty: entry.countedQty ?? '0', value: entry.value, at: out.length }
      out.push({
        type: 'opening',
        id: entry.id,
        qty: open.qty as Quantity,
        value: open.value as CostAmount,
        avgCost: entry.unitCost as UnitCost | null,
      })
      continue
    }
    open = null
    if (entry.kind === 'reversal' && entry.reversesKind === 'opening') {
      const countId = entry.countId ?? ''
      if (undone === countId) continue
      undone = countId
      out.push({ type: 'opening_reversal', openingId: openingIds.get(countId) ?? '' })
      continue
    }
    undone = null
    out.push(toWacMovement(entry))
  }
  return out
}

/** One stored movement (not a first count's row) as the WAC engine reads it. */
function toWacMovement(entry: LedgerEntry): WacMovement {
  switch (entry.kind) {
    case 'purchase':
      return {
        type: 'receipt',
        id: entry.id,
        qty: entry.qty as Quantity,
        value: entry.value as CostAmount,
      }
    case 'purchase_return':
      return {
        type: 'return',
        id: entry.id,
        receiptId: entry.receiptId ?? '',
        qty: negate(entry.qty) as Quantity,
        value: negate(entry.value) as CostAmount,
      }
    case 'purchase_credit':
      return {
        type: 'credit',
        id: entry.id,
        receiptId: entry.receiptId ?? '',
        amount: negate(entry.value) as CostAmount,
      }
    case 'count':
      return { type: 'count', id: entry.id, qty: entry.qty as Quantity }
    case 'opening':
      throw new AppError('internal', { message: 'an opening row is read with its count' })
    case 'reversal': {
      const target = entry.reversesId ?? ''
      if (entry.reversesKind === 'purchase') return { type: 'receipt_reversal', receiptId: target }
      if (entry.reversesKind === 'purchase_return') {
        return { type: 'return_reversal', returnId: target }
      }
      if (entry.reversesKind === 'count') return { type: 'count_reversal', countId: target }
      return { type: 'credit_reversal', creditId: target }
    }
  }
}

/**
 * A movement that moved quantity and was posted before a first count of its material that stands is
 * not reversed (STOCK_COUNTED, naming those materials): the first count set the material's stock to
 * what was counted (absolute in the cost engine, D-344), but its rows say only how far each branch
 * moved (relative), so taking such a movement out would change the balances and not the cost row,
 * and the two projections would part (material_costs.qty ≠ Σ stock_balances.qty). By posting order
 * (`seq`), not by day: what was posted after the first count, whatever its day, comes after it in the
 * ledger and reverses as anything else. Until late entries get their offset (M4 Step 3), that first
 * count is reversed first. Read under the materials' locks (lock 3): a first count's finalize or
 * reversal holds them FOR NO KEY UPDATE, so neither changes the answer before this commits.
 */
export async function assertNotBeforeFirstCount(
  tx: Tx,
  businessId: string,
  movementIds: readonly string[],
): Promise<void> {
  if (movementIds.length === 0) return
  const rows = (await tx.execute(sql`
    select mat.name
      from app.materials mat
     where mat.business_id = ${businessId}
       and exists (
         select 1
           from app.stock_movements m
           join app.stock_movements o
             on o.business_id = m.business_id and o.material_id = m.material_id
            and o.kind = 'opening' and o.seq > m.seq
           join app.stock_count_lines l on l.business_id = o.business_id and l.id = o.count_line_id
           join app.stock_counts c on c.business_id = l.business_id and c.id = l.count_id
          where m.business_id = ${businessId} and m.id = any(${uuidArray(movementIds)})
            and m.material_id = mat.id and m.qty <> 0
            and c.status = 'posted' and c.deleted_at is null)
     order by lower(mat.name), mat.id
  `)) as unknown as { name: string }[]
  if (rows.length > 0) throw new AppError('stock_counted', { names: rows.map((r) => r.name) })
}

/** A movement to insert (its id is chosen by the caller, its seq by the database). */
export interface NewMovement {
  readonly id: string
  readonly businessDate: string
  readonly locationId: string
  readonly materialId: string
  readonly kind: StockMovementKind
  readonly qty: string
  readonly value: string
  readonly adjustment: string
  readonly unitCost: string | null
  readonly purchaseLineId: string | null
  readonly returnLineId?: string | null
  readonly receiptId?: string | null
  readonly reversesId?: string | null
  readonly countLineId?: string | null
}

/** Inserts a movement; returns its posting sequence. */
export async function insertMovement(
  tx: Tx,
  businessId: string,
  movement: NewMovement,
): Promise<number> {
  const [row] = await tx
    .insert(stockMovements)
    .values({
      id: movement.id,
      businessId,
      businessDate: movement.businessDate,
      locationId: movement.locationId,
      materialId: movement.materialId,
      kind: movement.kind,
      qty: movement.qty,
      value: movement.value,
      adjustment: movement.adjustment,
      unitCost: movement.unitCost,
      purchaseLineId: movement.purchaseLineId,
      returnLineId: movement.returnLineId ?? null,
      receiptId: movement.receiptId ?? null,
      reversesId: movement.reversesId ?? null,
      countLineId: movement.countLineId ?? null,
    })
    .returning({ seq: stockMovements.seq })
  if (!row) throw new AppError('internal', { message: 'movement not inserted' })
  return row.seq
}

/** value ÷ |qty| for display (null when there is no quantity). */
export function unitCostOf(value: string, qty: string): string | null {
  const absQty = qty.startsWith('-') ? qty.slice(1) : qty
  const absValue = value.startsWith('-') ? value.slice(1) : value
  return costRatio([absValue], [absQty])
}

/**
 * Replays `ledger` plus `extra` (the movements being posted, in order) and returns the steps of the
 * extra ones and the final state. A RangeError of the engine (more than is left, a missing receipt)
 * means the document does not fit the ledger: EXCEEDS_PURCHASE.
 */
export function replayWithNew(
  ledger: readonly WacMovement[],
  extra: readonly WacMovement[],
): ReturnType<typeof replayWac> & { newSteps: ReturnType<typeof replayWac>['steps'] } {
  let replay: ReturnType<typeof replayWac>
  try {
    replay = replayWac([...ledger, ...extra])
  } catch (error) {
    if (error instanceof RangeError) {
      throw new AppError('exceeds_purchase', { message: error.message, cause: error })
    }
    throw error
  }
  return { ...replay, newSteps: replay.steps.slice(ledger.length) }
}
