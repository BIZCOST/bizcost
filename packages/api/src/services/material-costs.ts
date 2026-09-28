import type { MaterialCostDto, materialCostsInput, MaterialCostsDto } from '@bizcost/contracts'
import {
  costRatio,
  PURCHASE_AVERAGE_DAYS,
  STANDARD_UNITS,
  type StandardUnit,
} from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import type { z } from 'zod'
import type { BusinessCtx } from '../business-context'
import { AppError } from '../errors'
import { uuidArray } from './stock'

// The material cost view (ROADMAP.md M2 Step 3; D-115): the average a material's cost uses today and
// its last purchase price. Until the business's first stock count (Phase 4; businesses keep no
// first_stock_count_at yet, so every business is before it), the average is the average of the
// material's purchases in the last 90 days: Σ value ÷ Σ base quantity of its posted purchase lines
// dated in the 90 days ending today (the business's time zone), reversed purchases left out, and each
// line net of its posted returns and credit notes (D-120 rule 4). With none in the window it is the
// unit cost of its last posted purchase; never bought: no average (the page says "no price yet").
// Computed on read: the sums in SQL from the ledger's purchase rows (the index on material and
// business_date), each division in the domain once (costRatio: 12 decimals, never rounded to the
// currency). The stock-based average (material_costs) is kept from the first posting on, so the switch
// at the first count needs no rebuild.
//
// Sensitive: the averages are `cost`, the last purchase's prices `supplier_price` (the redact
// middleware removes them for members who may not see them).

type Input = z.output<typeof materialCostsInput>

interface CostRecord extends Record<string, unknown> {
  material_id: string
  unit: StandardUnit
  today: string
  window_from: string
  window_value: string | null
  window_qty: string | null
  last_purchase_id: string | null
  last_date: string | null
  last_qty: string | null
  last_unit: StandardUnit | null
  last_pack_id: string | null
  last_pack_name: string | null
  last_base_qty: string | null
  last_net_qty: string | null
  last_net_value: string | null
  doc_value: string | null
  doc_qty: string | null
}

/** `material.costs`: NOT_FOUND unless every id is a material of this business. */
export async function materialCosts(ctx: BusinessCtx, input: Input): Promise<MaterialCostsDto> {
  const ids = input.ids
  const records = await ctx.tx(
    async (tx) =>
      (await tx.execute(sql`
        with today as (
          select (now() at time zone b.timezone)::date as d
            from app.businesses b
           where b.id = ${ctx.businessId}
        ),
        receipts as (
          select m.id, m.material_id, m.purchase_line_id, m.business_date, m.seq, m.qty, m.value
            from app.stock_movements m
           where m.business_id = ${ctx.businessId}
             and m.material_id = any(${uuidArray(ids)})
             and m.kind = 'purchase'
             and not exists (
               select 1 from app.stock_movements r
                where r.business_id = m.business_id and r.reverses_id = m.id)
        ),
        taken as (
          select x.receipt_id, sum(-x.qty) as qty, sum(-x.value) as value
            from app.stock_movements x
           where x.business_id = ${ctx.businessId}
             and x.material_id = any(${uuidArray(ids)})
             and x.kind in ('purchase_return', 'purchase_credit')
             and not exists (
               select 1 from app.stock_movements r
                where r.business_id = x.business_id and r.reverses_id = x.id)
           group by x.receipt_id
        ),
        lines as (
          select r.material_id, r.purchase_line_id, r.business_date, r.seq,
                 r.qty - coalesce(t.qty, 0) as qty, r.value - coalesce(t.value, 0) as value
            from receipts r
            left join taken t on t.receipt_id = r.id
        ),
        last_line as (
          select distinct on (n.material_id)
                 n.material_id, n.purchase_line_id, n.business_date, n.qty, n.value
            from lines n
           where n.qty > 0
           order by n.material_id, n.business_date desc, n.seq desc
        )
        select mat.id as material_id, mat.unit, today.d::text as today,
               (today.d - ${PURCHASE_AVERAGE_DAYS - 1}::int)::text as window_from,
               trim_scale(sum(n.value) filter (
                 where n.qty > 0 and n.business_date > today.d - ${PURCHASE_AVERAGE_DAYS}::int
                   and n.business_date <= today.d))::text as window_value,
               trim_scale(sum(n.qty) filter (
                 where n.qty > 0 and n.business_date > today.d - ${PURCHASE_AVERAGE_DAYS}::int
                   and n.business_date <= today.d))::text as window_qty,
               max(pl.purchase_id::text) as last_purchase_id,
               max(ll.business_date)::text as last_date,
               trim_scale(max(pl.qty))::text as last_qty,
               max(pl.unit) as last_unit,
               max(pl.pack_id::text) as last_pack_id,
               max(u.name) as last_pack_name,
               trim_scale(max(pl.base_qty))::text as last_base_qty,
               trim_scale(max(ll.qty))::text as last_net_qty,
               trim_scale(max(ll.value))::text as last_net_value,
               trim_scale(sum(n.value) filter (
                 where n.qty > 0 and np.purchase_id = pl.purchase_id))::text as doc_value,
               trim_scale(sum(n.qty) filter (
                 where n.qty > 0 and np.purchase_id = pl.purchase_id))::text as doc_qty
          from app.materials mat
         cross join today
          left join lines n on n.material_id = mat.id
          left join app.purchase_lines np
            on np.business_id = mat.business_id and np.id = n.purchase_line_id
          left join last_line ll on ll.material_id = mat.id
          left join app.purchase_lines pl
            on pl.business_id = mat.business_id and pl.id = ll.purchase_line_id
          left join app.material_units u
            on u.business_id = pl.business_id and u.id = pl.pack_id
         where mat.business_id = ${ctx.businessId}
           and mat.id = any(${uuidArray(ids)})
           and mat.deleted_at is null
         group by mat.id, mat.unit, today.d, pl.purchase_id
      `)) as unknown as CostRecord[],
  )
  if (records.length !== ids.length) throw new AppError('not_found')
  const byId = new Map(records.map((record) => [record.material_id, record] as const))
  return {
    data: { items: ids.map((id) => toDto(byId.get(id)!)) },
    meta: { redacted: [] },
  }
}

function toDto(r: CostRecord): MaterialCostDto {
  const perUnitFactor = STANDARD_UNITS[r.unit].factor
  const window =
    r.window_value !== null && r.window_qty !== null
      ? { value: r.window_value, qty: r.window_qty, basis: 'purchases_90_days' as const }
      : r.doc_value !== null && r.doc_qty !== null
        ? { value: r.doc_value, qty: r.doc_qty, basis: 'last_purchase' as const }
        : null
  const perBaseUnit = window ? costRatio([window.value], [window.qty]) : null
  const perUnit = window ? costRatio([window.value, perUnitFactor], [window.qty]) : null
  const last =
    r.last_purchase_id !== null &&
    r.last_date !== null &&
    r.last_qty !== null &&
    r.last_base_qty !== null &&
    r.last_net_qty !== null &&
    r.last_net_value !== null
      ? {
          purchaseId: r.last_purchase_id,
          businessDate: r.last_date,
          qty: r.last_qty,
          unit: r.last_unit,
          packId: r.last_pack_id,
          packName: r.last_pack_name,
          pricePerPurchaseUnit: costRatio(
            [r.last_net_value, r.last_base_qty],
            [r.last_net_qty, r.last_qty],
          ),
          pricePerUnit: costRatio([r.last_net_value, perUnitFactor], [r.last_net_qty]),
          pricePerBaseUnit: costRatio([r.last_net_value], [r.last_net_qty]),
        }
      : null
  return {
    materialId: r.material_id,
    unit: r.unit,
    average:
      window && perBaseUnit !== null && perUnit !== null
        ? { basis: window.basis, from: r.window_from, to: r.today, perUnit, perBaseUnit }
        : null,
    lastPurchase:
      last &&
      last.pricePerPurchaseUnit !== null &&
      last.pricePerUnit !== null &&
      last.pricePerBaseUnit !== null
        ? {
            ...last,
            pricePerPurchaseUnit: last.pricePerPurchaseUnit,
            pricePerUnit: last.pricePerUnit,
            pricePerBaseUnit: last.pricePerBaseUnit,
          }
        : null,
  }
}
