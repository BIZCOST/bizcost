import type {
  createPurchaseReturnInput,
  documentIdInput,
  documentVersionInput,
  OkDto,
  PurchaseReturnDto,
  purchaseReturnListInput,
  PurchaseReturnListDto,
  PurchaseReturnResultDto,
  updatePurchaseReturnInput,
} from '@bizcost/contracts'
import {
  createIdempotent,
  purchaseReturnLines,
  purchaseReturns,
  type NewPurchaseReturnLine,
  type Tx,
} from '@bizcost/db'
import {
  compareDecimal,
  currencyMinorUnit,
  fitsCurrency,
  isCurrencyCode,
  newId,
  proportionOf,
  replayWac,
  splitByWeights,
  subtractDecimals,
  sumDecimals,
  type CostAmount,
  type CurrencyCode,
  type PurchaseReturnKind,
  type Quantity,
  type StandardUnit,
  type WacMovement,
} from '@bizcost/domain'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { assertQueryable } from '../trpc'
import { decodeCursor, encodeCursor, requestHashOf } from './catalog'
import {
  assertPostable,
  insertMovement,
  isoOf,
  lockBalances,
  lockCostRows,
  lockMaterials,
  lockPostingBusiness,
  materialLedger,
  moveBalance,
  negate,
  replayWithNew,
  reversalDateOf,
  toWacMovements,
  unitCostOf,
  writeProjections,
} from './stock'

// Supplier returns and credit notes (ROADMAP.md M2 Step 3; D-120), one table with a `kind`, linked to
// a posted purchase, with the purchases module's keys (the router checks them). Like purchases: draft
// → post → reverse, never edited once posted, posted on their own business day (it must be open and
// not after today; the purchase's own day may be closed), reversed "as if never posted".
//   - A return takes a quantity of a purchase line out at the price paid for it (D-120 rule 2): the
//     WAC engine works out its value from what the line's goods still carry.
//   - A credit note takes an amount (before VAT) off a purchase line, or one amount split over the
//     lines by what is left of their net (D-120 rule 3); with its VAT when VAT is part of the cost.
// Neither can be more than is left of the line (EXCEEDS_PURCHASE): bought minus returned, and for a
// credit its net minus what returns took back and earlier credits.

type CreateInput = z.output<typeof createPurchaseReturnInput>
type UpdateInput = z.output<typeof updatePurchaseReturnInput>
type Fields = Omit<UpdateInput, 'id' | 'version'>
type IdInput = z.output<typeof documentIdInput>
type VersionInput = z.output<typeof documentVersionInput>
type ListInput = z.output<typeof purchaseReturnListInput>

const invalid = (message: string) => new AppError('validation', { message })
const addDecimal = (a: string, b: string) => sumDecimals([a, b])

/**
 * A credit note's amounts are checked against the purchase's (EXCEEDS_PURCHASE), which are supplier
 * prices: a member who may not see them would read them from the refusals (a binary search over the
 * amount). So writing one needs them visible, FORBIDDEN otherwise, whatever the amount (D-142;
 * ARCHITECTURE.md §Redaction: a hidden value cannot be derived from errors). Returns take quantities,
 * which everyone who sees the purchase sees.
 */
function assertMayCredit(ctx: BusinessCtx, kind: PurchaseReturnKind) {
  if (kind === 'credit_note') assertQueryable(ctx, [{ name: 'amount', category: 'supplier_price' }])
}

function result(data: PurchaseReturnDto): PurchaseReturnResultDto {
  return { data, meta: { redacted: [] } }
}

// ---------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------

interface ReturnRecord extends Record<string, unknown> {
  id: string
  purchase_id: string
  kind: PurchaseReturnKind
  status: PurchaseReturnDto['status']
  business_date: string
  reference: string | null
  notes: string | null
  currency: string
  split_amount: string | null
  net_total: string
  vat_total: string
  total: string
  cost_total: string | null
  posted_at: Date | string | null
  reversed_at: Date | string | null
  reversal_date: string | null
  created_at: Date | string
  version: number
}

interface ReturnLineRecord extends Record<string, unknown> {
  id: string
  purchase_line_id: string
  material_id: string | null
  description: string | null
  unit: StandardUnit | null
  pack_id: string | null
  pack_name: string | null
  qty: string | null
  amount: string | null
  net: string
  vat: string
  base_qty: string | null
  cost: string | null
}

export async function readReturn(
  tx: Tx,
  businessId: string,
  id: string,
): Promise<PurchaseReturnDto> {
  const [head] = (await tx.execute(sql`
    select r.id, r.purchase_id, r.kind, r.status, r.business_date::text as business_date,
           r.reference, r.notes, trim(r.currency) as currency,
           trim_scale(r.split_amount)::text as split_amount,
           trim_scale(r.net_total)::text as net_total, trim_scale(r.vat_total)::text as vat_total,
           trim_scale(r.total)::text as total, trim_scale(r.cost_total)::text as cost_total,
           r.posted_at, r.reversed_at, r.reversal_date::text as reversal_date, r.created_at,
           r.version
      from app.purchase_returns r
     where r.business_id = ${businessId} and r.id = ${id} and r.deleted_at is null
  `)) as unknown as ReturnRecord[]
  if (!head) throw new AppError('not_found')
  const lines = (await tx.execute(sql`
    select rl.id, rl.purchase_line_id, l.material_id, l.description, l.unit, l.pack_id,
           u.name as pack_name, trim_scale(rl.qty)::text as qty,
           trim_scale(rl.amount)::text as amount, trim_scale(rl.net)::text as net,
           trim_scale(rl.vat)::text as vat, trim_scale(rl.base_qty)::text as base_qty,
           trim_scale(rl.cost)::text as cost
      from app.purchase_return_lines rl
      join app.purchase_lines l on l.business_id = rl.business_id and l.id = rl.purchase_line_id
      left join app.material_units u
        on u.business_id = l.business_id and u.id = l.pack_id
     where rl.business_id = ${businessId} and rl.return_id = ${id} and rl.deleted_at is null
     order by rl.position, rl.id
  `)) as unknown as ReturnLineRecord[]
  return {
    id: head.id,
    purchaseId: head.purchase_id,
    kind: head.kind,
    status: head.status,
    businessDate: head.business_date,
    reference: head.reference,
    notes: head.notes,
    currency: head.currency,
    splitAmount: head.split_amount,
    netTotal: head.net_total,
    vatTotal: head.vat_total,
    total: head.total,
    costTotal: head.cost_total,
    lines: lines.map((l) => ({
      id: l.id,
      purchaseLineId: l.purchase_line_id,
      materialId: l.material_id,
      description: l.description,
      unit: l.unit,
      packId: l.pack_id,
      packName: l.pack_name,
      qty: l.qty,
      amount: l.amount,
      net: l.net,
      vat: l.vat,
      baseQty: l.base_qty,
      cost: l.cost,
    })),
    postedAt: isoOf(head.posted_at),
    reversedAt: isoOf(head.reversed_at),
    reversalDate: head.reversal_date,
    createdAt: isoOf(head.created_at),
    version: head.version,
  }
}

/** `purchaseReturn.get`. */
export function getReturn(ctx: BusinessCtx, input: IdInput): Promise<PurchaseReturnResultDto> {
  return ctx.tx(async (tx) => result(await readReturn(tx, ctx.businessId, input.id)))
}

/** `purchaseReturn.list`: newest business day first. */
export async function listReturns(
  ctx: BusinessCtx,
  input: ListInput,
): Promise<PurchaseReturnListDto> {
  const conditions = [sql`r.business_id = ${ctx.businessId}`, sql`r.deleted_at is null`]
  if (input.purchaseId) conditions.push(sql`r.purchase_id = ${input.purchaseId}`)
  if (input.kind) conditions.push(sql`r.kind = ${input.kind}`)
  if (input.status !== 'all') conditions.push(sql`r.status = ${input.status}`)
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cursor.key)) {
      throw new AppError('validation', { message: 'invalid cursor' })
    }
    conditions.push(sql`(r.business_date, r.id) < (${cursor.key}::date, ${cursor.id}::uuid)`)
  }
  return ctx.tx(async (tx) => {
    // A filter names a purchase of this business (NOT_FOUND otherwise, like any other reference).
    if (input.purchaseId) {
      const [purchase] = (await tx.execute(sql`
        select p.id from app.purchases p
         where p.business_id = ${ctx.businessId} and p.id = ${input.purchaseId}
           and p.deleted_at is null
      `)) as unknown as { id: string }[]
      if (!purchase) throw new AppError('not_found')
    }
    const rows = (await tx.execute(sql`
      select r.id, r.purchase_id, r.kind, r.status, r.business_date::text as business_date,
             r.reference, s.name as supplier_name, trim(r.currency) as currency,
             trim_scale(r.total)::text as total, r.version
        from app.purchase_returns r
        join app.purchases p on p.business_id = r.business_id and p.id = r.purchase_id
        left join app.suppliers s on s.business_id = p.business_id and s.id = p.supplier_id
       where ${sql.join(conditions, sql` and `)}
       order by r.business_date desc, r.id desc
       limit ${input.limit + 1}
    `)) as unknown as {
      id: string
      purchase_id: string
      kind: PurchaseReturnKind
      status: PurchaseReturnDto['status']
      business_date: string
      reference: string | null
      supplier_name: string | null
      currency: string
      total: string
      version: number
    }[]
    const page = rows.slice(0, input.limit)
    const last = page.at(-1)
    return {
      data: {
        items: page.map((r) => ({
          id: r.id,
          purchaseId: r.purchase_id,
          kind: r.kind,
          status: r.status,
          businessDate: r.business_date,
          reference: r.reference,
          supplierName: r.supplier_name,
          currency: r.currency,
          total: r.total,
          version: r.version,
        })),
        nextCursor:
          rows.length > input.limit && last
            ? encodeCursor({ key: last.business_date, id: last.id })
            : null,
      },
      meta: { redacted: [] },
    }
  })
}

// ---------------------------------------------------------------------------------------------------
// What is left of a purchase's lines
// ---------------------------------------------------------------------------------------------------

/** A posted material line of the purchase, and what posted returns and credits took from it. */
interface LineLeft extends Record<string, unknown> {
  id: string
  material_id: string
  location_id: string
  receipt_id: string
  qty: string
  base_qty: string
  taxable: string
  vat: string
  vat_rate: string
  returned_qty: string
  returned_base_qty: string
  returned_net: string
  returned_vat: string
  credited: string
  credited_vat: string
}

/**
 * The purchase's posted material lines with what is left of them (returns and credit notes that are
 * posted, not reversed, other than `except`).
 */
async function linesLeft(
  tx: Tx,
  businessId: string,
  purchaseId: string,
  except: string,
): Promise<Map<string, LineLeft>> {
  const rows = (await tx.execute(sql`
    select l.id, l.material_id, m.location_id, m.id as receipt_id,
           trim_scale(l.qty)::text as qty, trim_scale(l.base_qty)::text as base_qty,
           trim_scale(l.taxable)::text as taxable, trim_scale(l.vat)::text as vat,
           trim_scale(l.vat_rate)::text as vat_rate,
           trim_scale(coalesce(sum(rl.qty) filter (where r.kind = 'return'), 0))::text
             as returned_qty,
           trim_scale(coalesce(sum(rl.base_qty) filter (where r.kind = 'return'), 0))::text
             as returned_base_qty,
           trim_scale(coalesce(sum(rl.net) filter (where r.kind = 'return'), 0))::text
             as returned_net,
           trim_scale(coalesce(sum(rl.vat) filter (where r.kind = 'return'), 0))::text
             as returned_vat,
           trim_scale(coalesce(sum(rl.amount) filter (where r.kind = 'credit_note'), 0))::text
             as credited,
           trim_scale(coalesce(sum(rl.vat) filter (where r.kind = 'credit_note'), 0))::text
             as credited_vat
      from app.purchase_lines l
      join app.stock_movements m
        on m.business_id = l.business_id and m.purchase_line_id = l.id and m.kind = 'purchase'
      left join app.purchase_return_lines rl
        on rl.business_id = l.business_id and rl.purchase_line_id = l.id and rl.deleted_at is null
      left join app.purchase_returns r
        on r.business_id = rl.business_id and r.id = rl.return_id and r.status = 'posted'
           and r.id <> ${except}
     where l.business_id = ${businessId} and l.purchase_id = ${purchaseId}
       and l.kind = 'material' and l.deleted_at is null
     group by l.id, l.material_id, m.location_id, m.id, l.qty, l.base_qty, l.taxable, l.vat,
              l.vat_rate, l.position
     order by l.position, l.id
  `)) as unknown as LineLeft[]
  return new Map(rows.map((row) => [row.id, row] as const))
}

// What is left of a line: its quantity less what returns took back; its amounts (before VAT, and its
// VAT) less what returns took back and credit notes took off. A return takes its share of what is
// left, so a price cut by a credit note reaches the goods sent back after it too.
const qtyLeft = (line: LineLeft) => subtractDecimals(line.qty, line.returned_qty)
const netLeft = (line: LineLeft) => subtractDecimals(line.taxable, line.returned_net, line.credited)
const vatLeft = (line: LineLeft) => {
  // Each credit's VAT is rounded on its own: never below zero in all.
  const vat = subtractDecimals(line.vat, line.returned_vat, line.credited_vat)
  return compareDecimal(vat, '0') < 0 ? '0' : vat
}

interface PurchaseHead extends Record<string, unknown> {
  status: string
  business_date: string
  currency: string
  vat_in_cost: boolean | null
}

/**
 * The purchase of a return (FOR SHARE when `lock`): it must be posted (DOCUMENT_NOT_POSTED), and the
 * return or credit note (dated `businessDate`) cannot be dated before it (VALIDATION).
 */
async function postedPurchase(
  tx: Tx,
  businessId: string,
  purchaseId: string,
  businessDate: string,
  lock: boolean,
): Promise<{ currency: CurrencyCode; vatInCost: boolean }> {
  const [row] = (await tx.execute(sql`
    select p.status, p.business_date::text as business_date, trim(p.currency) as currency,
           p.vat_in_cost
      from app.purchases p
     where p.business_id = ${businessId} and p.id = ${purchaseId} and p.deleted_at is null
     ${lock ? sql`for share` : sql``}
  `)) as unknown as PurchaseHead[]
  if (!row) throw new AppError('not_found')
  if (row.status !== 'posted') throw new AppError('document_not_posted')
  if (businessDate < row.business_date) throw invalid('businessDate: before its purchase')
  if (!isCurrencyCode(row.currency)) throw invalid(`currency: ${row.currency} is not supported`)
  return { currency: row.currency, vatInCost: row.vat_in_cost === true }
}

/** A line's amounts: what a return of `qty` of it is worth, or a credit of `amount`. */
function lineAmounts(
  kind: PurchaseReturnKind,
  line: LineLeft,
  value: string,
  currency: CurrencyCode,
): { net: string; vat: string } {
  const digits = currencyMinorUnit(currency)
  if (kind === 'credit_note') {
    return { net: value, vat: proportionOf(value, line.vat_rate, '100', digits) }
  }
  const left = qtyLeft(line)
  // All that is left: exactly what is left of its amounts; a part: its share of them.
  if (compareDecimal(value, left) === 0) return { net: netLeft(line), vat: vatLeft(line) }
  return {
    net: proportionOf(netLeft(line), value, left, digits),
    vat: proportionOf(vatLeft(line), value, left, digits),
  }
}

/** The document's lines checked against what is left of the purchase (EXCEEDS_PURCHASE). */
function checkedLines(
  kind: PurchaseReturnKind,
  fields: Fields,
  left: Map<string, LineLeft>,
  currency: CurrencyCode,
): { lines: { id: string; purchaseLineId: string; qty: string | null; amount: string | null }[] } {
  const digits = currencyMinorUnit(currency)
  // A credit is a document amount: never finer than the currency's minor unit (D-107), and refused
  // rather than rounded behind the person's back (D-142).
  if (fields.splitAmount !== null) {
    if (kind !== 'credit_note') throw invalid('splitAmount: only for a credit note')
    if (fields.lines.length > 0) throw invalid('lines: a split amount comes without lines')
    if (!fitsCurrency(fields.splitAmount, currency)) {
      throw invalid(`splitAmount: at most ${digits} decimals`)
    }
    const candidates = [...left.values()].filter((line) => compareDecimal(netLeft(line), '0') > 0)
    const available = sumDecimals(candidates.map(netLeft))
    if (compareDecimal(fields.splitAmount, available) > 0) throw new AppError('exceeds_purchase')
    // Largest remainder (D-142): no share below zero or above what is left of its line; a line whose
    // share is 0 gets no credit line.
    const shares = splitByWeights(fields.splitAmount, candidates.map(netLeft), digits)
    const lines = candidates
      .map((line, index) => ({
        id: newId(),
        purchaseLineId: line.id,
        qty: null,
        amount: shares[index]!,
      }))
      .filter((line) => compareDecimal(line.amount, '0') > 0)
    for (const line of lines) {
      if (compareDecimal(line.amount, netLeft(left.get(line.purchaseLineId)!)) > 0) {
        throw new AppError('exceeds_purchase')
      }
    }
    // The lines credit exactly the amount typed, never more or less.
    if (compareDecimal(sumDecimals(lines.map((line) => line.amount)), fields.splitAmount) !== 0) {
      throw invalid('splitAmount: cannot be shared over the lines')
    }
    return { lines }
  }
  const lines = fields.lines.map((line) => {
    const purchaseLine = left.get(line.purchaseLineId)
    if (!purchaseLine) throw new AppError('not_found')
    if (kind === 'return') {
      if (line.qty == null) throw invalid('lines: a return takes a quantity')
      if (compareDecimal(line.qty, qtyLeft(purchaseLine)) > 0) {
        throw new AppError('exceeds_purchase')
      }
      return { id: line.id, purchaseLineId: line.purchaseLineId, qty: line.qty, amount: null }
    }
    if (line.amount == null) throw invalid('lines: a credit note takes an amount')
    if (!fitsCurrency(line.amount, currency)) throw invalid(`lines: at most ${digits} decimals`)
    if (compareDecimal(line.amount, netLeft(purchaseLine)) > 0) {
      throw new AppError('exceeds_purchase')
    }
    return { id: line.id, purchaseLineId: line.purchaseLineId, qty: null, amount: line.amount }
  })
  return { lines }
}

/** Checks a draft against its purchase and computes its amounts. */
async function prepareReturn(
  tx: Tx,
  businessId: string,
  id: string,
  purchaseId: string,
  kind: PurchaseReturnKind,
  fields: Fields,
) {
  const { currency } = await postedPurchase(tx, businessId, purchaseId, fields.businessDate, false)
  const left = await linesLeft(tx, businessId, purchaseId, id)
  const { lines } = checkedLines(kind, fields, left, currency)
  const rows: Omit<NewPurchaseReturnLine, 'returnId'>[] = lines.map((line, position) => {
    const amounts = lineAmounts(
      kind,
      left.get(line.purchaseLineId)!,
      line.qty ?? line.amount!,
      currency,
    )
    return {
      id: line.id,
      businessId,
      purchaseId,
      purchaseLineId: line.purchaseLineId,
      position,
      qty: line.qty,
      amount: line.amount,
      net: amounts.net,
      vat: amounts.vat,
    }
  })
  const netTotal = sumDecimals(rows.map((r) => r.net ?? '0'))
  const vatTotal = sumDecimals(rows.map((r) => r.vat ?? '0'))
  const header = {
    businessDate: fields.businessDate,
    reference: fields.reference,
    notes: fields.notes,
    currency,
    splitAmount: fields.splitAmount,
    netTotal,
    vatTotal,
    total: sumDecimals([netTotal, vatTotal]),
  }
  return { header, rows }
}

// ---------------------------------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------------------------------

/**
 * `purchaseReturn.create`: a draft return or credit note for a posted purchase (DOCUMENT_NOT_POSTED
 * otherwise), idempotent on the client's id.
 */
export async function createReturn(
  ctx: BusinessCtx,
  input: CreateInput,
): Promise<PurchaseReturnResultDto> {
  const { id, purchaseId, kind, ...fields } = input
  assertMayCredit(ctx, kind)
  return ctx.tx(async (tx) => {
    const { header, rows } = await prepareReturn(tx, ctx.businessId, id, purchaseId, kind, fields)
    const { row, created } = await createIdempotent(tx, purchaseReturns, {
      id,
      businessId: ctx.businessId,
      purchaseId,
      kind,
      ...header,
      requestHash: requestHashOf({ purchaseId, kind, ...fields }),
    })
    if (row.deletedAt !== null) throw new AppError('conflict', { message: 'it was discarded' })
    if (created && rows.length > 0) {
      await tx.insert(purchaseReturnLines).values(rows.map((r) => ({ ...r, returnId: id })))
    }
    return result(await readReturn(tx, ctx.businessId, id))
  })
}

interface ReturnHead extends Record<string, unknown> {
  id: string
  purchase_id: string
  kind: PurchaseReturnKind
  status: string
  version: number
  business_date: string
}

async function lockReturn(tx: Tx, businessId: string, id: string): Promise<ReturnHead> {
  const [row] = (await tx.execute(sql`
    select r.id, r.purchase_id, r.kind, r.status, r.version, r.business_date::text as business_date
      from app.purchase_returns r
     where r.business_id = ${businessId} and r.id = ${id} and r.deleted_at is null
       for update
  `)) as unknown as ReturnHead[]
  if (!row) throw new AppError('not_found')
  return row
}

function assertDraft(head: ReturnHead, version: number) {
  if (head.status !== 'draft') throw new AppError('document_posted')
  if (head.version !== version) throw new AppError('conflict')
}

/** Soft-deletes the draft's live lines. */
async function takeOutLines(tx: Tx, businessId: string, returnId: string) {
  await tx
    .update(purchaseReturnLines)
    .set({ deletedAt: sql`now()` })
    .where(
      and(
        eq(purchaseReturnLines.businessId, businessId),
        eq(purchaseReturnLines.returnId, returnId),
        isNull(purchaseReturnLines.deletedAt),
      ),
    )
}

/**
 * `purchaseReturn.update`: the whole draft, `version` as read. Its lines are matched by id: a line of
 * this draft (live or taken out before) is changed, a new id is added, a missing one is taken out
 * (soft-deleted). An id used by another document is CONFLICT. A split credit note gets new lines.
 */
export async function updateReturn(
  ctx: BusinessCtx,
  input: UpdateInput,
): Promise<PurchaseReturnResultDto> {
  const { id, version, ...fields } = input
  return ctx.tx(async (tx) => {
    const head = await lockReturn(tx, ctx.businessId, id)
    assertMayCredit(ctx, head.kind)
    assertDraft(head, version)
    const { header, rows } = await prepareReturn(
      tx,
      ctx.businessId,
      id,
      head.purchase_id,
      head.kind,
      fields,
    )
    await tx
      .update(purchaseReturns)
      .set(header)
      .where(and(eq(purchaseReturns.businessId, ctx.businessId), eq(purchaseReturns.id, id)))
    // Every line is taken out first, so bringing lines back one by one never meets the unique
    // (return, purchase line) index halfway.
    const own = new Set(
      (
        await tx
          .select({ id: purchaseReturnLines.id })
          .from(purchaseReturnLines)
          .where(
            and(
              eq(purchaseReturnLines.businessId, ctx.businessId),
              eq(purchaseReturnLines.returnId, id),
            ),
          )
      ).map((row) => row.id),
    )
    await takeOutLines(tx, ctx.businessId, id)
    const added = rows.filter((r) => !own.has(r.id!))
    for (const row of rows.filter((r) => own.has(r.id!))) {
      const values: Partial<NewPurchaseReturnLine> = { ...row, deletedAt: null }
      delete values.id
      delete values.businessId
      delete values.purchaseId
      await tx
        .update(purchaseReturnLines)
        .set(values)
        .where(
          and(
            eq(purchaseReturnLines.businessId, ctx.businessId),
            eq(purchaseReturnLines.returnId, id),
            eq(purchaseReturnLines.id, row.id!),
          ),
        )
    }
    if (added.length > 0) {
      await tx.insert(purchaseReturnLines).values(added.map((r) => ({ ...r, returnId: id })))
    }
    return result(await readReturn(tx, ctx.businessId, id))
  })
}

/** `purchaseReturn.discard`: a draft is taken out (soft-deleted); never a posted one. */
export async function discardReturn(ctx: BusinessCtx, input: VersionInput): Promise<OkDto> {
  return ctx.tx(async (tx) => {
    assertDraft(await lockReturn(tx, ctx.businessId, input.id), input.version)
    await takeOutLines(tx, ctx.businessId, input.id)
    await tx
      .update(purchaseReturns)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(purchaseReturns.businessId, ctx.businessId), eq(purchaseReturns.id, input.id)))
    return { ok: true as const }
  })
}

// ---------------------------------------------------------------------------------------------------
// Posting and reversal
// ---------------------------------------------------------------------------------------------------

interface DraftReturnLine extends Record<string, unknown> {
  id: string
  purchase_line_id: string
  qty: string | null
  amount: string | null
}

/**
 * `purchaseReturn.post`: the draft (its `version` as read) becomes posted. A return takes each line's
 * quantity out of stock at the price paid for it; a credit note takes its amount (with its VAT when
 * VAT is part of the cost) off the credited goods still on hand, and books the rest once as a
 * correction (D-120). Checked again under the posting's locks: the purchase is still posted, the day
 * is open and not after today, nothing is more than is left. Idempotent like purchase.post.
 */
export async function postReturn(
  ctx: BusinessCtx,
  input: VersionInput,
): Promise<PurchaseReturnResultDto> {
  return ctx.tx(async (tx) => {
    const head = await lockReturn(tx, ctx.businessId, input.id)
    if (head.status !== 'draft') return result(await readReturn(tx, ctx.businessId, input.id))
    if (head.version !== input.version) throw new AppError('conflict')
    const purchase = await postedPurchase(
      tx,
      ctx.businessId,
      head.purchase_id,
      head.business_date,
      true,
    )
    const business = await lockPostingBusiness(tx, ctx.businessId)
    assertPostable(business, head.business_date)

    const drafts = (await tx.execute(sql`
      select rl.id, rl.purchase_line_id, trim_scale(rl.qty)::text as qty,
             trim_scale(rl.amount)::text as amount
        from app.purchase_return_lines rl
       where rl.business_id = ${ctx.businessId} and rl.return_id = ${input.id}
         and rl.deleted_at is null
       order by rl.position, rl.id
    `)) as unknown as DraftReturnLine[]
    if (drafts.length === 0) throw invalid('lines: nothing to post')

    // Locks 3–5, then what is left, read under them (a concurrent return has committed or waits).
    const before = await linesLeft(tx, ctx.businessId, head.purchase_id, input.id)
    const materialIds = [...new Set([...before.values()].map((l) => l.material_id))].sort()
    await lockMaterials(tx, ctx.businessId, materialIds)
    const costs = await lockCostRows(tx, ctx.businessId, materialIds)
    const balances = await lockBalances(
      tx,
      ctx.businessId,
      [...before.values()].map((l) => ({ locationId: l.location_id, materialId: l.material_id })),
    )
    const left = await linesLeft(tx, ctx.businessId, head.purchase_id, input.id)
    const fields: Fields = {
      businessDate: head.business_date,
      reference: null,
      notes: null,
      lines: drafts.map((d) => ({
        id: d.id,
        purchaseLineId: d.purchase_line_id,
        qty: d.qty,
        amount: d.amount,
      })),
      splitAmount: null,
    }
    checkedLines(head.kind, fields, left, purchase.currency)

    const costTotal: string[] = []
    const netTotals: string[] = []
    const vatTotals: string[] = []
    for (const materialId of materialIds) {
      const mine = drafts.filter((d) => left.get(d.purchase_line_id)?.material_id === materialId)
      if (mine.length === 0) continue
      const ledger = toWacMovements(await materialLedger(tx, ctx.businessId, materialId))
      const standing = replayWac(ledger).receipts
      const planned = mine.map((draft) => {
        const line = left.get(draft.purchase_line_id)!
        const amounts = lineAmounts(head.kind, line, draft.qty ?? draft.amount!, purchase.currency)
        const movementId = newId()
        if (head.kind === 'return') {
          const all = compareDecimal(draft.qty!, qtyLeft(line)) === 0
          const baseQty = all
            ? subtractDecimals(line.base_qty, line.returned_base_qty)
            : proportionOf(line.base_qty, draft.qty!, line.qty, 6)
          if (compareDecimal(baseQty, '0') <= 0) throw invalid('qty: too small to take out')
          const movement: WacMovement = {
            type: 'return',
            id: movementId,
            receiptId: line.receipt_id,
            qty: baseQty as Quantity,
          }
          return { draft, line, amounts, movementId, baseQty, movement }
        }
        // What the credit takes off the goods' cost: with its VAT when VAT is part of the cost, never
        // more than what the line's goods still carry (VAT rounding on a last credit).
        const withVat = purchase.vatInCost ? sumDecimals([amounts.net, amounts.vat]) : amounts.net
        const carried = standing.get(line.receipt_id)?.remainingValue ?? '0'
        const amount = compareDecimal(withVat, carried) > 0 ? carried : withVat
        if (compareDecimal(amount, '0') <= 0) throw new AppError('exceeds_purchase')
        const movement: WacMovement = {
          type: 'credit',
          id: movementId,
          receiptId: line.receipt_id,
          amount: amount as CostAmount,
        }
        return { draft, line, amounts, movementId, baseQty: null, movement }
      })
      const replay = replayWithNew(
        ledger,
        planned.map((p) => p.movement),
      )
      const row = costs.get(materialId)!
      for (const [index, p] of planned.entries()) {
        const step = replay.newSteps[index]!
        const out = step.valueOut
        const qty = p.baseQty === null ? '0' : negate(p.baseQty)
        row.lastSeq = await insertMovement(tx, ctx.businessId, {
          id: p.movementId,
          businessDate: head.business_date,
          locationId: p.line.location_id,
          materialId,
          kind: head.kind === 'return' ? 'purchase_return' : 'purchase_credit',
          qty,
          value: negate(out),
          adjustment: step.adjustment,
          unitCost: p.baseQty === null ? null : unitCostOf(out, p.baseQty),
          purchaseLineId: p.line.id,
          returnLineId: p.draft.id,
          receiptId: p.line.receipt_id,
        })
        if (p.baseQty !== null) {
          moveBalance(balances, p.line.location_id, materialId, qty, addDecimal)
        }
        await tx
          .update(purchaseReturnLines)
          .set({ net: p.amounts.net, vat: p.amounts.vat, baseQty: p.baseQty, cost: out })
          .where(
            and(
              eq(purchaseReturnLines.businessId, ctx.businessId),
              eq(purchaseReturnLines.id, p.draft.id),
            ),
          )
        costTotal.push(out)
        netTotals.push(p.amounts.net)
        vatTotals.push(p.amounts.vat)
      }
      row.state = replay.state
      row.changed = true
    }
    await writeProjections(tx, ctx.businessId, costs, balances)
    const netTotal = sumDecimals(netTotals)
    const vatTotal = sumDecimals(vatTotals)
    await tx
      .update(purchaseReturns)
      .set({
        status: 'posted',
        postedAt: sql`now()`,
        postedBy: sql`app.current_user_id()`,
        costTotal: sumDecimals(costTotal),
        netTotal,
        vatTotal,
        total: sumDecimals([netTotal, vatTotal]),
      })
      .where(and(eq(purchaseReturns.businessId, ctx.businessId), eq(purchaseReturns.id, input.id)))
    return result(await readReturn(tx, ctx.businessId, input.id))
  })
}

interface MovementRecord extends Record<string, unknown> {
  id: string
  kind: 'purchase_return' | 'purchase_credit'
  material_id: string
  location_id: string
  qty: string
  value: string
  unit_cost: string | null
  purchase_line_id: string
  return_line_id: string
}

/**
 * `purchaseReturn.reverse`: a posted return or credit note leaves the ledger "as if never posted"
 * (each material's ledger replayed without it), dated on its own day or the first open day.
 * Idempotent: one already reversed is returned as it is.
 */
export async function reverseReturn(
  ctx: BusinessCtx,
  input: IdInput,
): Promise<PurchaseReturnResultDto> {
  return ctx.tx(async (tx) => {
    const head = await lockReturn(tx, ctx.businessId, input.id)
    if (head.status === 'reversed') return result(await readReturn(tx, ctx.businessId, input.id))
    if (head.status !== 'posted') throw new AppError('document_not_posted')
    // The purchase is locked FOR SHARE like a posting's; it stays posted while this stands.
    await tx.execute(sql`
      select 1 from app.purchases p
       where p.business_id = ${ctx.businessId} and p.id = ${head.purchase_id}
         for share
    `)
    const business = await lockPostingBusiness(tx, ctx.businessId)
    const reversalDate = reversalDateOf(business, head.business_date)
    const movements = (await tx.execute(sql`
      select m.id, m.kind, m.material_id, m.location_id, trim_scale(m.qty)::text as qty,
             trim_scale(m.value)::text as value, trim_scale(m.unit_cost)::text as unit_cost,
             m.purchase_line_id, m.return_line_id
        from app.stock_movements m
        join app.purchase_return_lines rl
          on rl.business_id = m.business_id and rl.id = m.return_line_id
       where m.business_id = ${ctx.businessId} and rl.return_id = ${input.id}
         and m.kind in ('purchase_return', 'purchase_credit')
         and not exists (
           select 1 from app.stock_movements r
            where r.business_id = m.business_id and r.reverses_id = m.id)
       order by m.seq
    `)) as unknown as MovementRecord[]
    const materialIds = [...new Set(movements.map((m) => m.material_id))].sort()
    await lockMaterials(tx, ctx.businessId, materialIds)
    const costs = await lockCostRows(tx, ctx.businessId, materialIds)
    const balances = await lockBalances(
      tx,
      ctx.businessId,
      movements.map((m) => ({ locationId: m.location_id, materialId: m.material_id })),
    )
    // Read under the cost-row locks, so a return of the same line posted meanwhile has committed or
    // waits: a later return that still stands took its value from what the goods carried after this
    // document, so it is reversed first (D-142; the engine refuses it too).
    const [later] = (await tx.execute(sql`
      select 1 as found
        from app.stock_movements m
        join app.purchase_return_lines rl
          on rl.business_id = m.business_id and rl.id = m.return_line_id
       where m.business_id = ${ctx.businessId} and rl.return_id = ${input.id}
         and m.kind in ('purchase_return', 'purchase_credit')
         and exists (
           select 1 from app.stock_movements x
            where x.business_id = m.business_id and x.receipt_id = m.receipt_id
              and x.kind = 'purchase_return' and x.seq > m.seq
              and not exists (
                select 1 from app.stock_movements r
                 where r.business_id = x.business_id and r.reverses_id = x.id))
       limit 1
    `)) as unknown as { found: number }[]
    if (later) throw new AppError('has_later_returns')
    for (const materialId of materialIds) {
      const mine = movements.filter((m) => m.material_id === materialId)
      const ledger = toWacMovements(await materialLedger(tx, ctx.businessId, materialId))
      const replay = replayWithNew(
        ledger,
        mine.map((m): WacMovement =>
          m.kind === 'purchase_return'
            ? { type: 'return_reversal', returnId: m.id }
            : { type: 'credit_reversal', creditId: m.id },
        ),
      )
      const row = costs.get(materialId)!
      for (const [index, movement] of mine.entries()) {
        const step = replay.newSteps[index]!
        row.lastSeq = await insertMovement(tx, ctx.businessId, {
          id: newId(),
          businessDate: reversalDate,
          locationId: movement.location_id,
          materialId,
          kind: 'reversal',
          qty: negate(movement.qty),
          value: negate(movement.value),
          adjustment: step.adjustment,
          unitCost: movement.unit_cost,
          purchaseLineId: movement.purchase_line_id,
          returnLineId: movement.return_line_id,
          reversesId: movement.id,
        })
        if (movement.kind === 'purchase_return') {
          moveBalance(balances, movement.location_id, materialId, negate(movement.qty), addDecimal)
        }
      }
      row.state = replay.state
      row.changed = true
    }
    await writeProjections(tx, ctx.businessId, costs, balances)
    await tx
      .update(purchaseReturns)
      .set({
        status: 'reversed',
        reversedAt: sql`now()`,
        reversedBy: sql`app.current_user_id()`,
        reversalDate,
      })
      .where(and(eq(purchaseReturns.businessId, ctx.businessId), eq(purchaseReturns.id, input.id)))
    return result(await readReturn(tx, ctx.businessId, input.id))
  })
}
