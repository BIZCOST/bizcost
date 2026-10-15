import type { refundSaleInput, SaleResultDto } from '@bizcost/contracts'
import { saleLines, sales, type NewSaleLine, type Tx } from '@bizcost/db'
import {
  can,
  computeSale,
  creditError,
  creditLeft,
  fitCredit,
  isCurrencyCode,
  newId,
  planCredit,
  proportionOf,
  QUANTITY_SCALE,
  saleError,
  sumDecimals,
  type CostAmount,
  type CreditLinePlan,
  type CreditMade,
  type Money,
  type Quantity,
  type SaleLineInput as DomainSaleLine,
  type SaleMaterialBasis,
  type UnitCost,
  type VatCategory,
} from '@bizcost/domain'
import { and, eq, sql } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { assertModuleActive, assertPermission } from '../trpc'
import { requestHashOf } from './catalog'
import { lockReceivable, recordCustomerPaymentInTx } from './payments'
import { insertMaterialRows, shareCostRows } from './sale-costs'
import { lockSale, readSale, result } from './sales'
import { assertPostable, lockPostingBusiness } from './stock'

// Refunds (ROADMAP.md M3 Step 5; the plan's credit maths; the owner's answer Q16 = A of D-218):
// `sale.refund` takes back part of a finalized sale (One sale, Today's sales, or a delivered order's
// sale) as a negative sale linked to it (source `refund`, `refund_of_id`), by quantity (goods
// returned: it takes off the line's frozen cost of what was sold for that quantity, its materials too,
// D-222) or by amount (a price cut: it takes off no cost). Never more than is left of a line
// (EXCEEDS_SALE); each later refund starts from what the earlier ones left (documents/credit.ts; VAT
// ER Art. 60), and the last one of what is left takes exactly that. Its VAT is the refund's own, once
// per rate (D-220), under the VAT registration of the sale it refunds. A refund is finalized at once
// (it is reversed if it was a mistake, never edited or corrected); its day is never after today nor on
// or before the books-closed date. With `payment`, the money given back is recorded on the order (or
// the sale "they'll pay later") in the same step.
//
// Keys: a sale's refund needs sales.documents.reverse; a delivered order's, Orders on and
// orders.documents.reverse; the money given back, Payments on and payments.customers.record.
//
// Locks: the order first (lock 1, as a payment, a delivery or an undo of it), then the sale refunded
// (FOR UPDATE: two refunds of one sale wait for each other, each counting what the other left), then
// the business row (lock 2), then the cost rows of the materials whose price is still missing (lock
// 3, FOR SHARE: a purchase posting at the same moment either filled the sale's rows before they are
// read here, or waits and fills the refund's too, sale-costs.ts).

type RefundInput = z.output<typeof refundSaleInput>

const invalid = (message: string) => new AppError('validation', { message })

interface OriginalLine extends Record<string, unknown> {
  id: string
  kind: 'item' | 'delivery' | 'charge'
  product_id: string | null
  description: string | null
  qty: string
  unit: NewSaleLine['unit']
  unit_price: string
  price_includes_vat: boolean
  vat_category: VatCategory | null
  vat_rate: string | null
  net: string
  vat: string
  total: string
  cost_basis: NewSaleLine['costBasis']
  cost: string | null
  time_minutes: string | null
  time_cost: string | null
  taken_qty: string
  taken_net: string
  taken_vat: string
  taken_total: string
}

interface OriginalMaterial extends Record<string, unknown> {
  sale_line_id: string
  material_id: string
  base_qty: string
  unit_cost: string | null
  cost: string | null
  basis: SaleMaterialBasis | null
}

/** The sale's lines with what its refunds that stand took of each (positive sums). */
async function originalLines(tx: Tx, businessId: string, saleId: string) {
  return (await tx.execute(sql`
    select l.id, l.kind, l.product_id, l.description, trim_scale(l.qty)::text as qty, l.unit,
           trim_scale(l.unit_price)::text as unit_price, l.price_includes_vat, l.vat_category,
           trim_scale(l.vat_rate)::text as vat_rate, trim_scale(l.net)::text as net,
           trim_scale(l.vat)::text as vat, trim_scale(l.total)::text as total, l.cost_basis,
           trim_scale(l.cost)::text as cost, trim_scale(l.time_minutes)::text as time_minutes,
           trim_scale(l.time_cost)::text as time_cost,
           trim_scale(coalesce(t.qty, 0))::text as taken_qty,
           trim_scale(coalesce(t.net, 0))::text as taken_net,
           trim_scale(coalesce(t.vat, 0))::text as taken_vat,
           trim_scale(coalesce(t.total, 0))::text as taken_total
      from app.sale_lines l
      left join (
        select rl.refund_of_line_id,
               sum(abs(rl.qty)) filter (where r.refund_by = 'quantity') as qty,
               sum(abs(rl.net)) as net, sum(abs(rl.vat)) as vat, sum(abs(rl.total)) as total
          from app.sale_lines rl
          join app.sales r on r.business_id = rl.business_id and r.id = rl.sale_id
         where rl.business_id = ${businessId} and r.refund_of_id = ${saleId}
           and r.status = 'posted' and r.deleted_at is null and rl.deleted_at is null
         group by rl.refund_of_line_id
      ) t on t.refund_of_line_id = l.id
     where l.business_id = ${businessId} and l.sale_id = ${saleId} and l.deleted_at is null
     order by l.position, l.id
  `)) as unknown as OriginalLine[]
}

async function originalMaterials(tx: Tx, businessId: string, saleId: string) {
  return (await tx.execute(sql`
    select m.sale_line_id, m.material_id, trim_scale(m.base_qty)::text as base_qty,
           trim_scale(m.unit_cost)::text as unit_cost, trim_scale(m.cost)::text as cost, m.basis
      from app.sale_line_materials m
     where m.business_id = ${businessId} and m.sale_id = ${saleId} and m.deleted_at is null
     order by m.sale_line_id, m.id
  `)) as unknown as OriginalMaterial[]
}

/** −(value × part ÷ whole), rounded half away from zero to `places`. */
const shareOf = (value: string, part: string, whole: string, places: number) =>
  negate(proportionOf(value, part, whole, places))

const negate = (value: string) =>
  value.startsWith('-')
    ? value.slice(1)
    : value === '0' || /^0(\.0+)?$/.test(value)
      ? '0'
      : `-${value}`

/** The refund line of `line` for a computeSale line (a part of it). */
function partialInput(line: OriginalLine, plan: CreditLinePlan & { whole: false }): DomainSaleLine {
  const base = {
    qty: plan.qty as Quantity,
    unitPrice: plan.unitPrice as Money,
    priceIncludesVat: line.price_includes_vat,
    discount: plan.discountAmount ? { amount: plan.discountAmount as Money } : null,
  }
  if (line.kind === 'delivery') return { kind: 'delivery', ...base }
  return { kind: line.kind, ...base, vatCategory: line.vat_category ?? 'standard' }
}

/**
 * `sale.refund` (see above). Idempotent on the client's id: the same refund again returns it; an id
 * used otherwise is CONFLICT.
 */
export function refundSale(ctx: BusinessCtx, input: RefundInput): Promise<SaleResultDto> {
  const { id, ...rest } = input
  const requestHash = requestHashOf({ refund: rest })
  if (input.payment) {
    assertModuleActive(ctx, 'payments')
    assertPermission(ctx, 'payments.customers.record')
  }
  return ctx.tx(async (tx) => {
    /** A replay (also one sent twice at once: asked again once the locks below are held). */
    const replayed = async (): Promise<SaleResultDto | null> => {
      const [existing] = (await tx.execute(sql`
        select s.request_hash, s.created_by = app.current_user_id() as mine, s.source
          from app.sales s where s.business_id = ${ctx.businessId} and s.id = ${id}
      `)) as unknown as { request_hash: string | null; mine: boolean; source: string }[]
      if (!existing) return null
      if (existing.request_hash !== requestHash || !existing.mine || existing.source !== 'refund') {
        throw new AppError('conflict')
      }
      return result(await readSale(tx, ctx, id))
    }
    const first = await replayed()
    if (first) return first

    // What is refunded: a delivered order's sale (the order locked first), or a sale.
    let orderId: string | null = null
    let saleId: string
    if (input.orderId !== undefined) {
      assertModuleActive(ctx, 'orders')
      assertPermission(ctx, 'orders.documents.reverse')
      const order = await lockReceivable(tx, ctx, 'order', input.orderId)
      if (order.status === 'cancelled') throw new AppError('order_cancelled')
      if (order.status !== 'delivered') throw new AppError('document_not_posted')
      const [row] = (await tx.execute(sql`
        select o.sale_id from app.orders o
         where o.business_id = ${ctx.businessId} and o.id = ${input.orderId}
      `)) as unknown as { sale_id: string | null }[]
      if (!row?.sale_id) throw new AppError('document_not_posted')
      orderId = input.orderId
      saleId = row.sale_id
    } else {
      saleId = input.saleId ?? ''
      const [peek] = (await tx.execute(sql`
        select s.order_id, s.source from app.sales s
         where s.business_id = ${ctx.businessId} and s.id = ${saleId} and s.deleted_at is null
      `)) as unknown as { order_id: string | null; source: string }[]
      if (peek?.source === 'order' && peek.order_id !== null) {
        // An order's sale is refunded as its order is (its keys, and the order locked first).
        assertModuleActive(ctx, 'orders')
        assertPermission(ctx, 'orders.documents.reverse')
        await lockReceivable(tx, ctx, 'order', peek.order_id)
        orderId = peek.order_id
      } else {
        assertPermission(ctx, 'sales.documents.reverse')
      }
    }
    const head = await lockSale(tx, ctx, saleId)
    const again = await replayed()
    if (again) return again
    if (head.status === 'draft') throw new AppError('document_not_posted')
    if (head.status !== 'posted') throw new AppError('document_posted')
    if (head.source === 'import') throw invalid('an imported sale’s refunds come in its file')
    if (head.source === 'refund') throw invalid('a refund is reversed, never refunded')
    if (head.source === 'order' && !can(ctx.access.effective, 'orders.documents.reverse')) {
      throw new AppError('forbidden')
    }

    const business = await lockPostingBusiness(tx, ctx.businessId)
    const day = input.businessDate ?? business.today
    assertPostable(business, day)
    if (day < head.business_date) throw invalid('businessDate: before the sale')

    const [sale] = (await tx.execute(sql`
      select s.vat_registered, trim(s.currency) as currency, s.location_id, s.channel_id,
             s.customer_id
        from app.sales s where s.business_id = ${ctx.businessId} and s.id = ${saleId}
    `)) as unknown as {
      vat_registered: boolean
      currency: string
      location_id: string
      channel_id: string
      customer_id: string | null
    }[]
    if (!sale || !isCurrencyCode(sale.currency)) throw invalid('currency: not supported')
    const currency = sale.currency

    // Lock 3: the cost rows of the materials still without a price, then what they froze (a fill
    // committed while waiting is read).
    let materials = await originalMaterials(tx, ctx.businessId, saleId)
    const unpriced = [
      ...new Set(materials.filter((m) => m.cost === null).map((m) => m.material_id)),
    ]
    if (unpriced.length > 0) {
      await shareCostRows(tx, ctx.businessId, unpriced)
      materials = await originalMaterials(tx, ctx.businessId, saleId)
    }
    const lines = await originalLines(tx, ctx.businessId, saleId)
    const byId = new Map(lines.map((l) => [l.id, l] as const))

    // Each line asked: what is left of it, and the refund line that takes the request.
    const planned = input.lines.map((asked) => {
      const line = byId.get(asked.lineId)
      if (!line) throw new AppError('not_found')
      const made: CreditMade[] = [
        {
          by: 'quantity',
          qty: line.taken_qty,
          net: line.taken_net,
          vat: line.taken_vat,
          total: line.taken_total,
        },
      ]
      const credited = {
        qty: line.qty,
        unitPrice: line.unit_price,
        priceIncludesVat: line.price_includes_vat,
        net: line.net,
        vat: line.vat,
        total: line.total,
      }
      const left = creditLeft(credited, made)
      const request =
        input.by === 'quantity'
          ? { by: 'quantity' as const, qty: asked.qty ?? '0' }
          : { by: 'amount' as const, amount: asked.amount ?? '0' }
      const error = creditError(left, request, currency)
      if (error === 'exceeds_left') throw new AppError('exceeds_sale')
      if (error) throw invalid(`lines: ${error}`)
      return { line, left, plan: planCredit(credited, left, request, currency), asked: request }
    })

    // The partial lines' amounts: computeSale, VAT once per rate, under the sale's VAT registration.
    const partial = planned.flatMap((p, i) => (p.plan.whole ? [] : [{ p, i }]))
    const computeInput = {
      vatRegistered: sale.vat_registered,
      lines: partial.map(({ p }) =>
        partialInput(p.line, p.plan as CreditLinePlan & { whole: false }),
      ),
    }
    if (partial.length > 0) {
      const problem = saleError(computeInput, currency)
      if (problem) throw invalid(`amounts: ${problem.code}`)
    }
    const computed = partial.length > 0 ? computeSale(computeInput, currency) : null
    const amountsAt = new Map(partial.map(({ i }, k) => [i, computed!.lines[k]!] as const))

    const refundLines: NewSaleLine[] = []
    const materialRows: Parameters<typeof insertMaterialRows>[1] = []
    for (const [i, { line, plan, asked, left }] of planned.entries()) {
      const lineId = newId()
      const a = amountsAt.get(i)
      const amounts = plan.whole
        ? {
            subtotal: plan.total,
            discount: '0',
            net: plan.net,
            vat: plan.vat,
            total: plan.total,
            vatCategory: line.vat_category,
            vatRate: line.vat_rate,
          }
        : {
            subtotal: a!.subtotal,
            discount: a!.discount,
            // Within what is left of the line (its VAT never below zero, fitCredit).
            ...fitCredit(left, a!, line.price_includes_vat),
            vatCategory: line.vat_category,
            vatRate: line.vat_rate,
          }
      // Its cost: by quantity, the line's frozen cost of that quantity (its materials too); by amount,
      // none (a price cut takes back no cost). Delivery and charges cost nothing (as sold).
      let cost: string | null = null
      let timeMinutes: string | null = null
      let timeCost: string | null = null
      if (line.kind === 'item' && asked.by === 'amount') {
        cost = '0'
      } else if (line.kind === 'item' && asked.by === 'quantity') {
        const q = asked.qty
        const own = materials.filter((m) => m.sale_line_id === line.id)
        const rows = own.map((m) => ({
          id: newId(),
          businessId: ctx.businessId,
          saleId: id,
          saleLineId: lineId,
          materialId: m.material_id,
          baseQty: shareOf(m.base_qty, q, line.qty, QUANTITY_SCALE),
          unitCost: m.unit_cost as UnitCost | null,
          cost: (m.cost === null ? null : shareOf(m.cost, q, line.qty, 12)) as CostAmount | null,
          basis: m.basis,
        }))
        materialRows.push(...rows)
        cost =
          line.cost === null
            ? null
            : rows.length > 0
              ? sumDecimals(rows.map((r) => r.cost ?? '0'))
              : shareOf(line.cost, q, line.qty, 12)
        timeMinutes =
          line.time_minutes === null ? null : shareOf(line.time_minutes, q, line.qty, 12)
        timeCost = line.time_cost === null ? null : shareOf(line.time_cost, q, line.qty, 12)
      }
      refundLines.push({
        id: lineId,
        businessId: ctx.businessId,
        saleId: id,
        position: i,
        kind: line.kind,
        productId: line.product_id,
        description: line.description,
        qty: plan.qty,
        unit: line.unit,
        unitPrice: plan.whole ? line.unit_price : plan.unitPrice,
        priceIncludesVat: line.price_includes_vat,
        discountPercent: null,
        discountAmount: plan.whole ? null : plan.discountAmount,
        ...amounts,
        costBasis: line.cost_basis ?? 'none',
        cost,
        timeMinutes,
        timeCost,
        refundOfLineId: line.id,
      })
    }
    const totals = {
      subtotal: sumDecimals(refundLines.map((l) => l.subtotal ?? '0')),
      discountTotal: sumDecimals(refundLines.map((l) => l.discount ?? '0')),
      netTotal: sumDecimals(refundLines.map((l) => l.net ?? '0')),
      vatTotal: sumDecimals(refundLines.map((l) => l.vat ?? '0')),
      total: sumDecimals(refundLines.map((l) => l.total ?? '0')),
    }
    // Written as a draft with its lines and materials, then finalized (the books-closed date holds).
    await tx.insert(sales).values({
      id,
      businessId: ctx.businessId,
      source: 'refund',
      businessDate: day,
      locationId: sale.location_id,
      channelId: sale.channel_id,
      vatRegistered: sale.vat_registered,
      currency,
      ...totals,
      notes: input.notes,
      customerId: sale.customer_id,
      orderId,
      refundOfId: saleId,
      refundBy: input.by,
      requestHash,
    })
    await tx.insert(saleLines).values(refundLines)
    await insertMaterialRows(tx, materialRows)
    await tx
      .update(sales)
      .set({ status: 'posted', postedAt: sql`now()`, postedBy: sql`app.current_user_id()` })
      .where(and(eq(sales.businessId, ctx.businessId), eq(sales.id, id)))

    // The money given back with it: on the order, or on the sale "they'll pay later".
    if (input.payment) {
      const document =
        orderId !== null
          ? { kind: 'order' as const, id: orderId }
          : head.pay_later
            ? { kind: 'sale' as const, id: saleId }
            : null
      if (document === null) throw invalid('payment: the sale was paid when made')
      const receivable = await lockReceivable(tx, ctx, document.kind, document.id)
      await recordCustomerPaymentInTx(tx, ctx, document, receivable, {
        id: input.payment.id,
        kind: 'refund',
        businessDate: day,
        method: input.payment.method,
        amount: input.payment.amount,
        note: null,
        requestHash: requestHashOf({ refund: id, payment: input.payment }),
      })
    }
    return result(await readSale(tx, ctx, id))
  })
}
