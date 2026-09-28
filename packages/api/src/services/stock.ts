import { materialCosts, stockBalances, stockMovements, type Tx } from '@bizcost/db'
import {
  costRatio,
  isCurrencyCode,
  newId,
  replayWac,
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

/** A uuid[] of `ids` for raw SQL (drizzle expands a JS array into a list of parameters). */
export function uuidArray(ids: readonly string[]) {
  if (ids.length === 0) return sql`'{}'::uuid[]`
  return sql`array[${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`
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

/** Locks the materials FOR SHARE by ascending id (lock 3); returns the ids found (live ones). */
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
           r.kind as reverses_kind, m.purchase_line_id, m.return_line_id
      from app.stock_movements m
      left join app.stock_movements r on r.business_id = m.business_id and r.id = m.reverses_id
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
  }))
}

/** Negates a decimal string ("-" added or taken off; "0" stays). */
export function negate(value: string): string {
  if (value === '0' || /^-?0(?:\.0+)?$/.test(value)) return '0'
  return value.startsWith('-') ? value.slice(1) : `-${value}`
}

/** The WAC engine's movements for a stored ledger (values as posted). */
export function toWacMovements(ledger: readonly LedgerEntry[]): WacMovement[] {
  return ledger.map((entry): WacMovement => {
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
      case 'reversal': {
        const target = entry.reversesId ?? ''
        if (entry.reversesKind === 'purchase')
          return { type: 'receipt_reversal', receiptId: target }
        if (entry.reversesKind === 'purchase_return') {
          return { type: 'return_reversal', returnId: target }
        }
        return { type: 'credit_reversal', creditId: target }
      }
    }
  })
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
