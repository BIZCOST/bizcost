import type {
  correctPurchaseInput,
  createPurchaseInput,
  documentIdInput,
  documentVersionInput,
  OkDto,
  PurchaseDto,
  PurchaseLineDto,
  purchaseListInput,
  PurchaseListDto,
  PurchaseResultDto,
  updatePurchaseInput,
} from '@bizcost/contracts'
import {
  createIdempotent,
  purchaseLines,
  purchases,
  type NewPurchaseLine,
  type Tx,
} from '@bizcost/db'
import {
  computePurchase,
  isCurrencyCode,
  newId,
  purchaseError,
  sumDecimals,
  vatInCost,
  wacReceive,
  type CurrencyCode,
  type LineDiscount,
  type Money,
  type Percent,
  type PurchaseAmounts,
  type PurchaseDocumentType,
  type PurchaseLineInput as DomainLineInput,
  type Quantity,
  type StandardUnit,
} from '@bizcost/domain'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { detachAll, removeStoredFiles } from './attachments'
import { containsPattern, decodeCursor, encodeCursor, requestHashOf } from './catalog'
import { baseQtyOf, loadMaterials, type MaterialInfo } from './purchase-materials'
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

// Purchases (ROADMAP.md M2 Step 3; DATA_MODEL.md §6; D-114, D-120). Module `purchases`:
// purchases.documents.view to read, .manage to save and discard drafts, .post to post, .reverse to
// reverse or correct (the router checks them). A draft changes nothing but itself: every save checks
// the whole document (supplier, location, materials and their units, amounts) and stores the amounts
// computePurchase gives. Posting freezes it and writes the stock ledger and the average (stock.ts);
// a posted purchase is never edited (a database trigger refuses it): it is reversed ("as if never
// posted", D-109), or corrected (reversed, and a copy opened as a new draft).

type CreateInput = z.output<typeof createPurchaseInput>
type UpdateInput = z.output<typeof updatePurchaseInput>
type Fields = Omit<CreateInput, 'id'>
type IdInput = z.output<typeof documentIdInput>
type VersionInput = z.output<typeof documentVersionInput>
type CorrectInput = z.output<typeof correctPurchaseInput>
type ListInput = z.output<typeof purchaseListInput>

const invalid = (message: string) => new AppError('validation', { message })

const addDecimal = (a: string, b: string) => sumDecimals([a, b])

// ---------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------

interface PurchaseRecord extends Record<string, unknown> {
  id: string
  status: PurchaseDto['status']
  supplier_id: string | null
  supplier_name: string | null
  location_id: string
  business_date: string
  document_type: PurchaseDocumentType
  reference: string | null
  payment_method: PurchaseDto['paymentMethod']
  vat_not_reclaimable: boolean
  currency: string
  discount_percent: string | null
  discount_amount: string | null
  notes: string | null
  subtotal: string
  document_discount: string
  discount_total: string
  net_total: string
  vat_total: string
  total: string
  vat_in_cost: boolean | null
  cost_total: string | null
  posted_at: Date | string | null
  reversed_at: Date | string | null
  reversal_date: string | null
  copied_from_id: string | null
  created_at: Date | string
  version: number
  attachment_count: number
}

interface LineRecord extends Record<string, unknown> {
  id: string
  kind: PurchaseLineDto['kind']
  material_id: string | null
  description: string | null
  qty: string
  unit: PurchaseLineDto['unit']
  pack_id: string | null
  pack_name: string | null
  unit_price: string
  discount_percent: string | null
  discount_amount: string | null
  vat_rate: string
  subtotal: string
  discount: string
  net: string
  document_discount: string
  taxable: string
  vat: string
  total: string
  base_qty: string | null
  delivery_share: string | null
  cost: string | null
  returned_qty: string
  returned_amount: string
  credited_amount: string
}

function discountOf(percent: string | null, amount: string | null) {
  if (percent !== null) return { percent }
  if (amount !== null) return { amount }
  return null
}

/** The purchase as the API returns it (NOT_FOUND unless a live purchase of this business). */
export async function readPurchase(tx: Tx, businessId: string, id: string): Promise<PurchaseDto> {
  const [head] = (await tx.execute(sql`
    select p.id, p.status, p.supplier_id, s.name as supplier_name, p.location_id,
           p.business_date::text as business_date, p.document_type, p.reference, p.payment_method,
           p.vat_not_reclaimable, trim(p.currency) as currency,
           trim_scale(p.discount_percent)::text as discount_percent,
           trim_scale(p.discount_amount)::text as discount_amount, p.notes,
           trim_scale(p.subtotal)::text as subtotal,
           trim_scale(p.document_discount)::text as document_discount,
           trim_scale(p.discount_total)::text as discount_total,
           trim_scale(p.net_total)::text as net_total, trim_scale(p.vat_total)::text as vat_total,
           trim_scale(p.total)::text as total, p.vat_in_cost,
           trim_scale(p.cost_total)::text as cost_total, p.posted_at, p.reversed_at,
           p.reversal_date::text as reversal_date, p.copied_from_id, p.created_at, p.version,
           (select count(*)::int from app.attachments a
             where a.business_id = p.business_id and a.entity = 'purchase' and a.entity_id = p.id
               and a.deleted_at is null) as attachment_count
      from app.purchases p
      left join app.suppliers s on s.business_id = p.business_id and s.id = p.supplier_id
     where p.business_id = ${businessId} and p.id = ${id} and p.deleted_at is null
  `)) as unknown as PurchaseRecord[]
  if (!head) throw new AppError('not_found')

  const lines = (await tx.execute(sql`
    select l.id, l.kind, l.material_id, l.description, trim_scale(l.qty)::text as qty, l.unit,
           l.pack_id, u.name as pack_name, trim_scale(l.unit_price)::text as unit_price,
           trim_scale(l.discount_percent)::text as discount_percent,
           trim_scale(l.discount_amount)::text as discount_amount,
           trim_scale(l.vat_rate)::text as vat_rate, trim_scale(l.subtotal)::text as subtotal,
           trim_scale(l.discount)::text as discount, trim_scale(l.net)::text as net,
           trim_scale(l.document_discount)::text as document_discount,
           trim_scale(l.taxable)::text as taxable, trim_scale(l.vat)::text as vat,
           trim_scale(l.total)::text as total, trim_scale(l.base_qty)::text as base_qty,
           trim_scale(l.delivery_share)::text as delivery_share, trim_scale(l.cost)::text as cost,
           trim_scale(coalesce((
             select sum(rl.qty) from app.purchase_return_lines rl
               join app.purchase_returns r on r.business_id = rl.business_id and r.id = rl.return_id
              where rl.business_id = l.business_id and rl.purchase_line_id = l.id
                and rl.deleted_at is null and r.status = 'posted' and r.kind = 'return'
           ), 0))::text as returned_qty,
           trim_scale(coalesce((
             select sum(rl.net) from app.purchase_return_lines rl
               join app.purchase_returns r on r.business_id = rl.business_id and r.id = rl.return_id
              where rl.business_id = l.business_id and rl.purchase_line_id = l.id
                and rl.deleted_at is null and r.status = 'posted' and r.kind = 'return'
           ), 0))::text as returned_amount,
           trim_scale(coalesce((
             select sum(rl.amount) from app.purchase_return_lines rl
               join app.purchase_returns r on r.business_id = rl.business_id and r.id = rl.return_id
              where rl.business_id = l.business_id and rl.purchase_line_id = l.id
                and rl.deleted_at is null and r.status = 'posted' and r.kind = 'credit_note'
           ), 0))::text as credited_amount
      from app.purchase_lines l
      left join app.material_units u
        on u.business_id = l.business_id and u.id = l.pack_id
     where l.business_id = ${businessId} and l.purchase_id = ${id} and l.deleted_at is null
     order by l.position, l.id
  `)) as unknown as LineRecord[]

  const returns = (await tx.execute(sql`
    select r.id, r.kind, r.status, r.business_date::text as business_date, r.reference,
           trim_scale(r.total)::text as total, trim_scale(r.cost_total)::text as cost_total
      from app.purchase_returns r
     where r.business_id = ${businessId} and r.purchase_id = ${id} and r.deleted_at is null
     order by r.business_date, r.created_at, r.id
  `)) as unknown as {
    id: string
    kind: PurchaseDto['returns'][number]['kind']
    status: PurchaseDto['status']
    business_date: string
    reference: string | null
    total: string
    cost_total: string | null
  }[]

  return {
    id: head.id,
    status: head.status,
    supplierId: head.supplier_id,
    supplierName: head.supplier_name,
    locationId: head.location_id,
    businessDate: head.business_date,
    documentType: head.document_type,
    reference: head.reference,
    paymentMethod: head.payment_method,
    vatNotReclaimable: head.vat_not_reclaimable,
    currency: head.currency,
    discount: discountOf(head.discount_percent, head.discount_amount),
    notes: head.notes,
    subtotal: head.subtotal,
    documentDiscount: head.document_discount,
    discountTotal: head.discount_total,
    netTotal: head.net_total,
    vatTotal: head.vat_total,
    total: head.total,
    vatInCost: head.vat_in_cost,
    costTotal: head.cost_total,
    lines: lines.map((l) => ({
      id: l.id,
      kind: l.kind,
      materialId: l.material_id,
      description: l.description,
      qty: l.qty,
      unit: l.unit,
      packId: l.pack_id,
      packName: l.pack_name,
      vatRate: l.vat_rate,
      unitPrice: l.unit_price,
      discount: discountOf(l.discount_percent, l.discount_amount),
      subtotal: l.subtotal,
      lineDiscount: l.discount,
      net: l.net,
      documentDiscount: l.document_discount,
      taxable: l.taxable,
      vat: l.vat,
      total: l.total,
      baseQty: l.base_qty,
      deliveryShare: l.delivery_share,
      cost: l.cost,
      returnedQty: l.returned_qty,
      returnedAmount: l.returned_amount,
      creditedAmount: l.credited_amount,
    })),
    returns: returns.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      businessDate: r.business_date,
      reference: r.reference,
      total: r.total,
      costTotal: r.cost_total,
    })),
    attachmentCount: head.attachment_count,
    postedAt: isoOf(head.posted_at),
    reversedAt: isoOf(head.reversed_at),
    reversalDate: head.reversal_date,
    copiedFromId: head.copied_from_id,
    createdAt: isoOf(head.created_at),
    version: head.version,
  }
}

/** An envelope for redaction (the redact middleware fills meta.redacted). */
function result(data: PurchaseDto): PurchaseResultDto {
  return { data, meta: { redacted: [] } }
}

/** `purchase.get`. */
export function getPurchase(ctx: BusinessCtx, input: IdInput): Promise<PurchaseResultDto> {
  return ctx.tx(async (tx) => result(await readPurchase(tx, ctx.businessId, input.id)))
}

interface ListRecord extends Record<string, unknown> {
  id: string
  status: PurchaseDto['status']
  supplier_id: string | null
  supplier_name: string | null
  location_id: string
  business_date: string
  document_type: PurchaseDocumentType
  reference: string | null
  currency: string
  total: string
  line_count: number
  item_names: string[]
  version: number
}

/** `purchase.list`: newest business day first, with filters and a cursor. */
export async function listPurchases(ctx: BusinessCtx, input: ListInput): Promise<PurchaseListDto> {
  const conditions = [sql`p.business_id = ${ctx.businessId}`, sql`p.deleted_at is null`]
  if (input.status !== 'all') conditions.push(sql`p.status = ${input.status}`)
  if (input.supplierId) conditions.push(sql`p.supplier_id = ${input.supplierId}`)
  if (input.from) conditions.push(sql`p.business_date >= ${input.from}::date`)
  if (input.to) conditions.push(sql`p.business_date <= ${input.to}::date`)
  if (input.search) {
    const pattern = containsPattern(input.search)
    conditions.push(sql`(p.reference ilike ${pattern} or s.name ilike ${pattern})`)
  }
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cursor.key)) {
      throw new AppError('validation', { message: 'invalid cursor' })
    }
    conditions.push(sql`(p.business_date, p.id) < (${cursor.key}::date, ${cursor.id}::uuid)`)
  }
  return ctx.tx(async (tx) => {
    // A filter names a supplier of this business (NOT_FOUND otherwise, like any other reference).
    if (input.supplierId) await assertSupplier(tx, ctx.businessId, input.supplierId)
    const rows = (await tx.execute(sql`
      select p.id, p.status, p.supplier_id, s.name as supplier_name, p.location_id,
             p.business_date::text as business_date, p.document_type, p.reference,
             trim(p.currency) as currency, trim_scale(p.total)::text as total, p.version,
             (select count(*)::int from app.purchase_lines l
               where l.business_id = p.business_id and l.purchase_id = p.id
                 and l.kind = 'material' and l.deleted_at is null) as line_count,
             array(select coalesce(l.description, '') from app.purchase_lines l
                    where l.business_id = p.business_id and l.purchase_id = p.id
                      and l.kind = 'material' and l.deleted_at is null
                    order by l.position, l.id
                    limit 2) as item_names
        from app.purchases p
        left join app.suppliers s on s.business_id = p.business_id and s.id = p.supplier_id
       where ${sql.join(conditions, sql` and `)}
       order by p.business_date desc, p.id desc
       limit ${input.limit + 1}
    `)) as unknown as ListRecord[]
    const page = rows.slice(0, input.limit)
    const last = page.at(-1)
    return {
      data: {
        items: page.map((r) => ({
          id: r.id,
          status: r.status,
          supplierId: r.supplier_id,
          supplierName: r.supplier_name,
          locationId: r.location_id,
          businessDate: r.business_date,
          documentType: r.document_type,
          reference: r.reference,
          currency: r.currency,
          total: r.total,
          lineCount: r.line_count,
          itemNames: r.item_names,
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
// Drafts
// ---------------------------------------------------------------------------------------------------

/** The business's currency and default location, as a draft save needs them. */
async function draftContext(tx: Tx, businessId: string) {
  const [row] = (await tx.execute(sql`
    select trim(b.currency) as currency,
           (select l.id from app.locations l
             where l.business_id = b.id and l.is_default and l.deleted_at is null) as default_location_id
      from app.businesses b
     where b.id = ${businessId} and b.deleted_at is null
  `)) as unknown as { currency: string; default_location_id: string | null }[]
  if (!row) throw new AppError('forbidden')
  if (!isCurrencyCode(row.currency)) throw invalid(`currency: ${row.currency} is not supported`)
  return { currency: row.currency, defaultLocationId: row.default_location_id }
}

/**
 * The location of a purchase: the default one when none is chosen. Another location needs the
 * multi_location capability (CAPABILITY_DISABLED) and must be a live location of the business
 * (NOT_FOUND).
 */
async function resolveLocation(
  tx: Tx,
  ctx: BusinessCtx,
  locationId: string | null,
  defaultLocationId: string | null,
): Promise<string> {
  if (locationId === null || locationId === defaultLocationId) {
    if (!defaultLocationId) throw invalid('location: the business has no default location')
    return defaultLocationId
  }
  if (!ctx.access.capabilities.multi_location) throw new AppError('capability_disabled')
  const [row] = (await tx.execute(sql`
    select l.id from app.locations l
     where l.business_id = ${ctx.businessId} and l.id = ${locationId} and l.deleted_at is null
  `)) as unknown as { id: string }[]
  if (!row) throw new AppError('not_found')
  return row.id
}

async function assertSupplier(tx: Tx, businessId: string, supplierId: string | null) {
  if (supplierId === null) return
  const [row] = (await tx.execute(sql`
    select s.id from app.suppliers s
     where s.business_id = ${businessId} and s.id = ${supplierId} and s.deleted_at is null
  `)) as unknown as { id: string }[]
  if (!row) throw new AppError('not_found')
}

type InputLine = Fields['lines'][number]

function toLineDiscount(
  discount: { percent: string } | { amount: string } | null | undefined,
): LineDiscount | null {
  if (!discount) return null
  return 'percent' in discount
    ? { percent: discount.percent as Percent }
    : { amount: discount.amount as Money }
}

/** The domain's view of the lines (for computePurchase). */
function domainLines(lines: readonly InputLine[]): DomainLineInput[] {
  return lines.map((line) =>
    line.kind === 'material'
      ? {
          kind: 'material',
          qty: line.qty as Quantity,
          unitPrice: line.unitPrice as Money,
          discount: toLineDiscount(line.discount),
          vatRate: line.vatRate as Percent,
        }
      : { kind: 'delivery', amount: line.amount as Money, vatRate: line.vatRate as Percent },
  )
}

/** A document's amounts; VALIDATION with the domain's code when they cannot be computed. */
function amountsOf(
  lines: readonly InputLine[],
  discount: Fields['discount'],
  inCost: boolean,
  currency: CurrencyCode,
): PurchaseAmounts {
  const input = { lines: domainLines(lines), discount: toLineDiscount(discount), vatInCost: inCost }
  const error = purchaseError(input, currency)
  if (error) {
    const where = error.line === undefined ? '' : ` (line ${error.line + 1})`
    throw invalid(`amounts: ${error.code}${where}`)
  }
  try {
    return computePurchase(input, currency)
  } catch (cause) {
    throw new AppError('validation', { message: 'amounts: cannot be computed', cause })
  }
}

/**
 * Checks a draft's supplier, location and materials (their units convert to base units), and
 * computes its amounts. Returns the columns of the purchase and of each line.
 */
async function prepareDraft(tx: Tx, ctx: BusinessCtx, input: Fields) {
  const { currency, defaultLocationId } = await draftContext(tx, ctx.businessId)
  await assertSupplier(tx, ctx.businessId, input.supplierId)
  const locationId = await resolveLocation(tx, ctx, input.locationId, defaultLocationId)
  const materialIds = input.lines.flatMap((l) => (l.kind === 'material' ? [l.materialId] : []))
  // Locked FOR SHARE first, as a posting does: a change of a material's units or kind of measure in
  // flight finishes before its units are read here, or waits for this save and then sees its lines
  // (MATERIAL_IN_USE, D-145).
  await lockMaterials(tx, ctx.businessId, materialIds)
  const materials = await loadMaterials(tx, ctx.businessId, materialIds)
  for (const line of input.lines) {
    if (line.kind !== 'material') continue
    const material = materials.get(line.materialId)
    if (!material) throw new AppError('not_found')
    baseQtyOf(material, line.qty, { unit: line.unit ?? null, packId: line.packId ?? null })
  }
  // A draft's document amounts do not depend on the VAT rule; its costs are worked out at posting.
  const amounts = amountsOf(input.lines, input.discount, false, currency)
  const header = {
    supplierId: input.supplierId,
    locationId,
    businessDate: input.businessDate,
    documentType: input.documentType,
    reference: input.reference,
    paymentMethod: input.paymentMethod,
    vatNotReclaimable: input.vatNotReclaimable,
    currency,
    discountPercent: input.discount && 'percent' in input.discount ? input.discount.percent : null,
    discountAmount: input.discount && 'amount' in input.discount ? input.discount.amount : null,
    notes: input.notes,
    subtotal: amounts.subtotal,
    documentDiscount: amounts.documentDiscount,
    discountTotal: amounts.discount,
    netTotal: amounts.net,
    vatTotal: amounts.vat,
    total: amounts.total,
  }
  const lines = input.lines.map((line, position) =>
    lineValues(ctx.businessId, line, position, amounts, materials),
  )
  return { header, lines }
}

function lineValues(
  businessId: string,
  line: InputLine,
  position: number,
  amounts: PurchaseAmounts,
  materials: ReadonlyMap<string, MaterialInfo>,
): Omit<NewPurchaseLine, 'purchaseId'> {
  const a = amounts.lines[position]!
  const common = {
    id: line.id,
    businessId,
    position,
    kind: line.kind,
    vatRate: line.vatRate,
    subtotal: a.subtotal,
    discount: a.discount,
    net: a.net,
    documentDiscount: a.documentDiscount,
    taxable: a.taxable,
    vat: a.vat,
    total: a.total,
  }
  if (line.kind === 'delivery') {
    return {
      ...common,
      materialId: null,
      description: line.description,
      qty: '1',
      unit: null,
      packId: null,
      unitPrice: line.amount,
      discountPercent: null,
      discountAmount: null,
    }
  }
  return {
    ...common,
    materialId: line.materialId,
    description: materials.get(line.materialId)?.name ?? null,
    qty: line.qty,
    unit: line.unit ?? null,
    packId: line.packId ?? null,
    unitPrice: line.unitPrice,
    discountPercent: line.discount && 'percent' in line.discount ? line.discount.percent : null,
    discountAmount: line.discount && 'amount' in line.discount ? line.discount.amount : null,
  }
}

/**
 * `purchase.create`: a draft, idempotent on the client's id (the same payload again returns it; an
 * id used by another create or another business is CONFLICT).
 */
export async function createPurchase(
  ctx: BusinessCtx,
  input: CreateInput,
): Promise<PurchaseResultDto> {
  const { id, ...fields } = input
  return ctx.tx(async (tx) => {
    const { header, lines } = await prepareDraft(tx, ctx, fields)
    const { row, created } = await createIdempotent(tx, purchases, {
      id,
      businessId: ctx.businessId,
      ...header,
      requestHash: requestHashOf(fields),
    })
    if (row.deletedAt !== null)
      throw new AppError('conflict', { message: 'purchase was discarded' })
    if (created && lines.length > 0) {
      await tx.insert(purchaseLines).values(lines.map((line) => ({ ...line, purchaseId: id })))
    }
    return result(await readPurchase(tx, ctx.businessId, id))
  })
}

interface HeadRecord extends Record<string, unknown> {
  id: string
  status: PurchaseDto['status']
  version: number
  business_date: string
  location_id: string
  document_type: PurchaseDocumentType
  vat_not_reclaimable: boolean
  discount_percent: string | null
  discount_amount: string | null
}

/** The purchase row, locked FOR UPDATE (lock 1 of a posting); NOT_FOUND when not live. */
async function lockPurchase(tx: Tx, businessId: string, id: string): Promise<HeadRecord> {
  const [row] = (await tx.execute(sql`
    select p.id, p.status, p.version, p.business_date::text as business_date, p.location_id,
           p.document_type, p.vat_not_reclaimable,
           trim_scale(p.discount_percent)::text as discount_percent,
           trim_scale(p.discount_amount)::text as discount_amount
      from app.purchases p
     where p.business_id = ${businessId} and p.id = ${id} and p.deleted_at is null
       for update
  `)) as unknown as HeadRecord[]
  if (!row) throw new AppError('not_found')
  return row
}

/** A draft that may still change: DOCUMENT_POSTED once posted, CONFLICT for another version. */
function assertDraft(head: HeadRecord, version: number) {
  if (head.status !== 'draft') throw new AppError('document_posted')
  if (head.version !== version) throw new AppError('conflict')
}

/**
 * `purchase.update`: the whole draft, `version` as read. Lines are matched by id: new ids are added,
 * changed ones updated, missing ones taken out (soft-deleted). An id used anywhere else is CONFLICT.
 */
export async function updatePurchase(
  ctx: BusinessCtx,
  input: UpdateInput,
): Promise<PurchaseResultDto> {
  const { id, version, ...fields } = input
  return ctx.tx(async (tx) => {
    assertDraft(await lockPurchase(tx, ctx.businessId, id), version)
    const { header, lines } = await prepareDraft(tx, ctx, fields)
    await tx
      .update(purchases)
      .set(header)
      .where(and(eq(purchases.businessId, ctx.businessId), eq(purchases.id, id)))
    const live = new Set(
      (
        await tx
          .select({ id: purchaseLines.id })
          .from(purchaseLines)
          .where(
            and(
              eq(purchaseLines.businessId, ctx.businessId),
              eq(purchaseLines.purchaseId, id),
              isNull(purchaseLines.deletedAt),
            ),
          )
      ).map((row) => row.id),
    )
    const kept = new Set(lines.map((line) => line.id))
    const removed = [...live].filter((lineId) => !kept.has(lineId))
    if (removed.length > 0) {
      await tx
        .update(purchaseLines)
        .set({ deletedAt: sql`now()` })
        .where(
          and(
            eq(purchaseLines.businessId, ctx.businessId),
            eq(purchaseLines.purchaseId, id),
            inArray(purchaseLines.id, removed),
          ),
        )
    }
    const added = lines.filter((line) => !live.has(line.id))
    if (added.length > 0) {
      await tx.insert(purchaseLines).values(added.map((line) => ({ ...line, purchaseId: id })))
    }
    for (const line of lines.filter((l) => live.has(l.id))) {
      const values: Partial<NewPurchaseLine> = { ...line }
      delete values.id
      delete values.businessId
      await tx
        .update(purchaseLines)
        .set(values)
        .where(
          and(
            eq(purchaseLines.businessId, ctx.businessId),
            eq(purchaseLines.purchaseId, id),
            eq(purchaseLines.id, line.id),
          ),
        )
    }
    return result(await readPurchase(tx, ctx.businessId, id))
  })
}

/**
 * `purchase.discard`: a draft is taken out (soft-deleted, with its lines); never a posted one. Its
 * receipts go with it: taken off in the same transaction, their files removed after it.
 */
export async function discardPurchase(ctx: BusinessCtx, input: VersionInput): Promise<OkDto> {
  const files = await ctx.tx(async (tx) => {
    assertDraft(await lockPurchase(tx, ctx.businessId, input.id), input.version)
    const paths = await detachAll(tx, ctx.businessId, 'purchase', input.id)
    await tx
      .update(purchaseLines)
      .set({ deletedAt: sql`now()` })
      .where(
        and(
          eq(purchaseLines.businessId, ctx.businessId),
          eq(purchaseLines.purchaseId, input.id),
          isNull(purchaseLines.deletedAt),
        ),
      )
    await tx
      .update(purchases)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(purchases.businessId, ctx.businessId), eq(purchases.id, input.id)))
    return paths
  })
  await removeStoredFiles(ctx, files)
  return { ok: true as const }
}

// ---------------------------------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------------------------------

interface DraftLineRecord extends Record<string, unknown> {
  id: string
  kind: 'material' | 'delivery'
  material_id: string | null
  qty: string
  unit: StandardUnit | null
  pack_id: string | null
  unit_price: string
  discount_percent: string | null
  discount_amount: string | null
  vat_rate: string
}

async function draftLines(tx: Tx, businessId: string, purchaseId: string) {
  return (await tx.execute(sql`
    select l.id, l.kind, l.material_id, trim_scale(l.qty)::text as qty, l.unit, l.pack_id,
           trim_scale(l.unit_price)::text as unit_price,
           trim_scale(l.discount_percent)::text as discount_percent,
           trim_scale(l.discount_amount)::text as discount_amount,
           trim_scale(l.vat_rate)::text as vat_rate
      from app.purchase_lines l
     where l.business_id = ${businessId} and l.purchase_id = ${purchaseId} and l.deleted_at is null
     order by l.position, l.id
  `)) as unknown as DraftLineRecord[]
}

function asInputLine(line: DraftLineRecord): InputLine {
  const discount = discountOf(line.discount_percent, line.discount_amount)
  return line.kind === 'material'
    ? {
        kind: 'material',
        id: line.id,
        materialId: line.material_id ?? '',
        qty: line.qty,
        unit: line.unit,
        packId: line.pack_id,
        unitPrice: line.unit_price,
        discount,
        vatRate: line.vat_rate,
      }
    : {
        kind: 'delivery',
        id: line.id,
        description: null,
        amount: line.unit_price,
        vatRate: line.vat_rate,
      }
}

/**
 * `purchase.post`: the draft (its `version` as read) becomes posted, and its goods come into stock:
 * each material line brings its base quantity and what its goods cost (after discounts, with its
 * delivery share, VAT when it cannot be reclaimed) into the ledger, and the material's average moves
 * (D-114 rule 1). Idempotent: a purchase already posted (or reversed since) is returned as it is.
 * Refused: a date after today (FUTURE_DATE) or on or before the books-closed date (BOOKS_CLOSED), no
 * material line, a material or unit removed since the draft was saved (VALIDATION).
 */
export async function postPurchase(
  ctx: BusinessCtx,
  input: VersionInput,
): Promise<PurchaseResultDto> {
  return ctx.tx(async (tx) => {
    const head = await lockPurchase(tx, ctx.businessId, input.id)
    if (head.status !== 'draft') return result(await readPurchase(tx, ctx.businessId, input.id))
    if (head.version !== input.version) throw new AppError('conflict')

    const business = await lockPostingBusiness(tx, ctx.businessId)
    assertPostable(business, head.business_date)
    const stored = await draftLines(tx, ctx.businessId, input.id)
    const lines = stored.map(asInputLine)
    const materialLines = lines.filter((l) => l.kind === 'material')
    if (materialLines.length === 0) throw invalid('lines: a purchase needs a material to post')
    const [location] = (await tx.execute(sql`
      select l.id from app.locations l
       where l.business_id = ${ctx.businessId} and l.id = ${head.location_id}
         and l.deleted_at is null
    `)) as unknown as { id: string }[]
    if (!location) throw invalid('location: removed since the draft was saved')

    const materialIds = materialLines.map((l) => l.materialId)
    const locked = await lockMaterials(tx, ctx.businessId, materialIds)
    if (materialIds.some((materialId) => !locked.has(materialId))) {
      throw invalid('lines: a material was removed')
    }
    const materials = await loadMaterials(tx, ctx.businessId, materialIds)
    const inCost = vatInCost({
      vatRegistered: business.vatRegistered,
      documentType: head.document_type,
      vatNotReclaimable: head.vat_not_reclaimable,
    })
    const discount = discountOf(head.discount_percent, head.discount_amount)
    const amounts = amountsOf(lines, discount, inCost, business.currency)
    const baseQty = new Map<string, Quantity>()
    for (const line of materialLines) {
      const material = materials.get(line.materialId)!
      baseQty.set(
        line.id,
        baseQtyOf(material, line.qty, { unit: line.unit ?? null, packId: line.packId ?? null }),
      )
    }

    const costs = await lockCostRows(tx, ctx.businessId, materialIds)
    const balances = await lockBalances(
      tx,
      ctx.businessId,
      materialIds.map((materialId) => ({ locationId: head.location_id, materialId })),
    )
    for (const [position, line] of lines.entries()) {
      const a = amounts.lines[position]!
      if (line.kind === 'material') {
        const qty = baseQty.get(line.id)!
        const row = costs.get(line.materialId)!
        const receipt = wacReceive(row.state, { qty, value: a.cost })
        row.lastSeq = await insertMovement(tx, ctx.businessId, {
          id: newId(),
          businessDate: head.business_date,
          locationId: head.location_id,
          materialId: line.materialId,
          kind: 'purchase',
          qty,
          value: a.cost,
          adjustment: receipt.adjustment,
          unitCost: unitCostOf(a.cost, qty),
          purchaseLineId: line.id,
        })
        row.state = receipt.state
        row.changed = true
        moveBalance(balances, head.location_id, line.materialId, qty, addDecimal)
      }
      await tx
        .update(purchaseLines)
        .set({
          subtotal: a.subtotal,
          discount: a.discount,
          net: a.net,
          documentDiscount: a.documentDiscount,
          taxable: a.taxable,
          vat: a.vat,
          total: a.total,
          baseQty: line.kind === 'material' ? baseQty.get(line.id)! : null,
          deliveryShare: line.kind === 'material' ? a.deliveryShare : null,
          cost: line.kind === 'material' ? a.cost : null,
        })
        .where(and(eq(purchaseLines.businessId, ctx.businessId), eq(purchaseLines.id, line.id)))
    }
    await writeProjections(tx, ctx.businessId, costs, balances)
    await tx
      .update(purchases)
      .set({
        status: 'posted',
        postedAt: sql`now()`,
        postedBy: sql`app.current_user_id()`,
        // The amounts above are in the business's currency as it is now.
        currency: business.currency,
        vatInCost: inCost,
        costTotal: amounts.cost,
        subtotal: amounts.subtotal,
        documentDiscount: amounts.documentDiscount,
        discountTotal: amounts.discount,
        netTotal: amounts.net,
        vatTotal: amounts.vat,
        total: amounts.total,
      })
      .where(and(eq(purchases.businessId, ctx.businessId), eq(purchases.id, input.id)))
    return result(await readPurchase(tx, ctx.businessId, input.id))
  })
}

// ---------------------------------------------------------------------------------------------------
// Reversal and correction
// ---------------------------------------------------------------------------------------------------

interface ReceiptRecord extends Record<string, unknown> {
  id: string
  material_id: string
  location_id: string
  qty: string
  value: string
  unit_cost: string | null
  purchase_line_id: string
}

/**
 * Reverses a posted purchase in `tx` (already reversed: nothing to do). Its receipts leave the
 * ledger "as if never posted": each material's ledger is replayed without them (D-109), the
 * reversal movements carry what that changed, dated on the purchase's day or the first open day
 * (D-114 rule 3). PURCHASE_HAS_RETURNS while returns or credit notes of it are posted (D-120 rule 1).
 */
async function reverseInTx(tx: Tx, ctx: BusinessCtx, id: string): Promise<void> {
  const head = await lockPurchase(tx, ctx.businessId, id)
  if (head.status === 'reversed') return
  if (head.status !== 'posted') throw new AppError('document_not_posted')
  const [open] = (await tx.execute(sql`
    select count(*)::int as n from app.purchase_returns r
     where r.business_id = ${ctx.businessId} and r.purchase_id = ${id}
       and r.status = 'posted' and r.deleted_at is null
  `)) as unknown as { n: number }[]
  if ((open?.n ?? 0) > 0) throw new AppError('purchase_has_returns')

  const business = await lockPostingBusiness(tx, ctx.businessId)
  const reversalDate = reversalDateOf(business, head.business_date)
  const receipts = (await tx.execute(sql`
    select m.id, m.material_id, m.location_id, trim_scale(m.qty)::text as qty,
           trim_scale(m.value)::text as value, trim_scale(m.unit_cost)::text as unit_cost,
           m.purchase_line_id
      from app.stock_movements m
      join app.purchase_lines l on l.business_id = m.business_id and l.id = m.purchase_line_id
     where m.business_id = ${ctx.businessId} and l.purchase_id = ${id} and m.kind = 'purchase'
       and not exists (
         select 1 from app.stock_movements r
          where r.business_id = m.business_id and r.reverses_id = m.id)
     order by m.seq
  `)) as unknown as ReceiptRecord[]
  const materialIds = [...new Set(receipts.map((r) => r.material_id))].sort()
  await lockMaterials(tx, ctx.businessId, materialIds)
  const costs = await lockCostRows(tx, ctx.businessId, materialIds)
  const balances = await lockBalances(
    tx,
    ctx.businessId,
    receipts.map((r) => ({ locationId: r.location_id, materialId: r.material_id })),
  )
  for (const materialId of materialIds) {
    const mine = receipts.filter((r) => r.material_id === materialId)
    const ledger = toWacMovements(await materialLedger(tx, ctx.businessId, materialId))
    const replay = replayWithNew(
      ledger,
      mine.map((r) => ({ type: 'receipt_reversal', receiptId: r.id })),
    )
    const row = costs.get(materialId)!
    for (const [index, receipt] of mine.entries()) {
      const step = replay.newSteps[index]!
      row.lastSeq = await insertMovement(tx, ctx.businessId, {
        id: newId(),
        businessDate: reversalDate,
        locationId: receipt.location_id,
        materialId,
        kind: 'reversal',
        qty: negate(receipt.qty),
        value: negate(receipt.value),
        adjustment: step.adjustment,
        unitCost: receipt.unit_cost,
        purchaseLineId: receipt.purchase_line_id,
        reversesId: receipt.id,
      })
      moveBalance(balances, receipt.location_id, materialId, negate(receipt.qty), addDecimal)
    }
    row.state = replay.state
    row.changed = true
  }
  await writeProjections(tx, ctx.businessId, costs, balances)
  await tx
    .update(purchases)
    .set({
      status: 'reversed',
      reversedAt: sql`now()`,
      reversedBy: sql`app.current_user_id()`,
      reversalDate,
    })
    .where(and(eq(purchases.businessId, ctx.businessId), eq(purchases.id, id)))
}

/** `purchase.reverse`: see reverseInTx. Idempotent. */
export async function reversePurchase(
  ctx: BusinessCtx,
  input: IdInput,
): Promise<PurchaseResultDto> {
  return ctx.tx(async (tx) => {
    await reverseInTx(tx, ctx, input.id)
    return result(await readPurchase(tx, ctx.businessId, input.id))
  })
}

/**
 * `purchase.correct` ("correct" = reverse + a new draft copy, D-114 rule 3): reverses the purchase
 * (when still posted) and opens a copy of it as a new draft with the client's `newId`, in one
 * transaction. Idempotent on `newId`: the same call again returns the copy; an id used otherwise is
 * CONFLICT. A draft cannot be corrected (DOCUMENT_NOT_POSTED): it is edited.
 */
export async function correctPurchase(
  ctx: BusinessCtx,
  input: CorrectInput,
): Promise<PurchaseResultDto> {
  return ctx.tx(async (tx) => {
    // The purchase first (lock 1 of its reversal): two corrections of one purchase wait for each
    // other here, before either inserts a copy that names it (a copy's foreign key takes a key-share
    // lock on the purchase, which would deadlock with the other's lock for the reversal).
    await lockPurchase(tx, ctx.businessId, input.id)
    const requestHash = requestHashOf({ correct: input.id })
    const [existing] = (await tx.execute(sql`
      select p.id, p.request_hash, p.created_by = app.current_user_id() as mine, p.deleted_at
        from app.purchases p
       where p.business_id = ${ctx.businessId} and p.id = ${input.newId}
    `)) as unknown as {
      id: string
      request_hash: string | null
      mine: boolean
      deleted_at: Date | string | null
    }[]
    if (existing) {
      if (existing.request_hash !== requestHash || !existing.mine || existing.deleted_at) {
        throw new AppError('conflict')
      }
      return result(await readPurchase(tx, ctx.businessId, input.newId))
    }
    // The copy's header first: an id used anywhere (another business too) is CONFLICT before
    // anything else happens; everything below is rolled back with it.
    const [source] = await tx
      .select()
      .from(purchases)
      .where(
        and(
          eq(purchases.businessId, ctx.businessId),
          eq(purchases.id, input.id),
          isNull(purchases.deletedAt),
        ),
      )
    if (!source) throw new AppError('not_found')
    const { currency, defaultLocationId } = await draftContext(tx, ctx.businessId)
    const [location] = (await tx.execute(sql`
      select l.id from app.locations l
       where l.business_id = ${ctx.businessId} and l.id = ${source.locationId}
         and l.deleted_at is null
    `)) as unknown as { id: string }[]
    await tx.insert(purchases).values({
      id: input.newId,
      businessId: ctx.businessId,
      supplierId: source.supplierId,
      locationId: location?.id ?? defaultLocationId ?? source.locationId,
      businessDate: source.businessDate,
      documentType: source.documentType,
      reference: source.reference,
      paymentMethod: source.paymentMethod,
      vatNotReclaimable: source.vatNotReclaimable,
      currency,
      discountPercent: source.discountPercent,
      discountAmount: source.discountAmount,
      notes: source.notes,
      subtotal: source.subtotal,
      documentDiscount: source.documentDiscount,
      discountTotal: source.discountTotal,
      netTotal: source.netTotal,
      vatTotal: source.vatTotal,
      total: source.total,
      copiedFromId: input.id,
      requestHash,
    })
    await reverseInTx(tx, ctx, input.id)
    const sourceLines = await tx
      .select()
      .from(purchaseLines)
      .where(
        and(
          eq(purchaseLines.businessId, ctx.businessId),
          eq(purchaseLines.purchaseId, input.id),
          isNull(purchaseLines.deletedAt),
        ),
      )
      .orderBy(purchaseLines.position, purchaseLines.id)
    if (sourceLines.length > 0) {
      await tx.insert(purchaseLines).values(
        sourceLines.map((line, position) => ({
          id: newId(),
          businessId: ctx.businessId,
          purchaseId: input.newId,
          position,
          kind: line.kind,
          materialId: line.materialId,
          description: line.description,
          qty: line.qty,
          unit: line.unit,
          packId: line.packId,
          unitPrice: line.unitPrice,
          discountPercent: line.discountPercent,
          discountAmount: line.discountAmount,
          vatRate: line.vatRate,
          subtotal: line.subtotal,
          discount: line.discount,
          net: line.net,
          documentDiscount: line.documentDiscount,
          taxable: line.taxable,
          vat: line.vat,
          total: line.total,
        })),
      )
    }
    return result(await readPurchase(tx, ctx.businessId, input.newId))
  })
}
