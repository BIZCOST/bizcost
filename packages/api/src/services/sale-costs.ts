import { materialCosts, type Tx } from '@bizcost/db'
import {
  dimensionOf,
  fillSaleLineCost,
  newId,
  STANDARD_UNITS,
  type CostAmount,
  type PostedPurchaseLine,
  type SaleCostBasis,
  type SaleItemMaterials,
  type SaleLineCost,
  type SaleMaterialBasis,
  type SaleTimeCost,
  type StandardUnit,
  type UnitCost,
} from '@bizcost/domain'
import { sql } from 'drizzle-orm'
import { jsonRecords, uuidArray } from './stock'

// The cost of what was sold, frozen when a sale is finalized, and filled once (M3 Step 2; D-219,
// D-222, D-228, D-229). Nothing here moves stock or changes a cost row's values (D-219): a sale only
// reads the purchases posted when it is finalized.
//
// Lock order (D-110, extended by D-228; stock.ts says the whole of it). A sale's posting takes:
//   1. the sale FOR UPDATE (the caller);
//   2. the business row FOR SHARE (lockPostingBusiness: the books-closed date);
//   3. its materials' cost rows: the missing ones inserted with ON CONFLICT DO NOTHING (as
//      lockCostRows does), then all of them FOR SHARE, by ascending material id (shareCostRows);
// then ONE read of the purchases posted (postedPurchaseLinesOf) and ONE insert of every line's
// materials. A purchase posting at the same moment holds those cost rows FOR UPDATE: it is either
// finished before the sale reads (inside the sale's cost) or waits for the sale to commit and then
// fills what the sale left without a price (fillSaleMaterialCosts), never missed; the first purchase of
// a material too, since the insert of its cost row waits for the other's (H4).
//
// The fills run AFTER the locks of what triggers them, and touch only sale_line_materials rows and
// sale_lines costs that are still null, never a sale's header: the lines to fill are locked FOR NO
// KEY UPDATE by ascending id (two purchases filling materials of one line wait for each other there,
// so the second sees the first's material and gives the line its cost), then each value is written
// only `where … is null`. A sale's reversal locks only its header, so a reversal and a fill never wait
// on each other. The new lock edge: cost rows → sale lines (a purchase's posting, a return's or credit
// note's reversal: D-236), business row → sale lines (the hourly rate); nothing locks in the other
// direction. Every statement here takes its ids and rows as ONE parameter (uuidArray, jsonRecords), so
// no number of lines or waiting sales reaches the driver's limit of parameters (D-236).

/** One standing receipt line per material: what D-222's averageAsOf reads. */
interface PurchaseLineRecord extends Record<string, unknown> {
  material_id: string
  purchase_id: string
  business_date: string
  seq: string
  qty: string
  value: string
}

/**
 * Each material's posted purchase lines still standing (receipts not reversed, each net of its
 * returns and credit notes that stand, D-120): the input of averageAsOf, in one read of the ledger.
 */
export async function postedPurchaseLinesOf(
  tx: Tx,
  businessId: string,
  materialIds: readonly string[],
): Promise<Map<string, PostedPurchaseLine[]>> {
  const ids = [...new Set(materialIds)]
  const byMaterial = new Map<string, PostedPurchaseLine[]>()
  if (ids.length === 0) return byMaterial
  const records = (await tx.execute(sql`
    with receipts as (
      select m.id, m.material_id, m.purchase_line_id, m.business_date, m.seq, m.qty, m.value
        from app.stock_movements m
       where m.business_id = ${businessId}
         and m.material_id = any(${uuidArray(ids)})
         and m.kind = 'purchase'
         and not exists (
           select 1 from app.stock_movements r
            where r.business_id = m.business_id and r.reverses_id = m.id)
    ),
    taken as (
      select x.receipt_id, sum(-x.qty) as qty, sum(-x.value) as value
        from app.stock_movements x
       where x.business_id = ${businessId}
         and x.material_id = any(${uuidArray(ids)})
         and x.kind in ('purchase_return', 'purchase_credit')
         and not exists (
           select 1 from app.stock_movements r
            where r.business_id = x.business_id and r.reverses_id = x.id)
       group by x.receipt_id
    )
    select r.material_id, pl.purchase_id, r.business_date::text as business_date,
           r.seq::text as seq,
           trim_scale(r.qty - coalesce(t.qty, 0))::text as qty,
           trim_scale(r.value - coalesce(t.value, 0))::text as value
      from receipts r
      join app.purchase_lines pl on pl.business_id = ${businessId} and pl.id = r.purchase_line_id
      left join taken t on t.receipt_id = r.id
     order by r.material_id, r.seq
  `)) as unknown as PurchaseLineRecord[]
  for (const r of records) {
    const list = byMaterial.get(r.material_id) ?? []
    list.push({
      purchaseId: r.purchase_id,
      businessDate: r.business_date,
      seq: r.seq,
      qty: r.qty,
      value: r.value,
    })
    byMaterial.set(r.material_id, list)
  }
  return byMaterial
}

/**
 * Locks 3 of a sale's posting: the materials' cost rows, the missing ones created first (one insert in
 * ascending order, ON CONFLICT DO NOTHING: a first purchase creating the same row is waited for), then
 * all of them FOR SHARE by ascending material id. A cost row's values never change here (D-219).
 */
export async function shareCostRows(
  tx: Tx,
  businessId: string,
  materialIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(materialIds)].sort()
  if (ids.length === 0) return
  await tx
    .insert(materialCosts)
    .values(ids.map((materialId) => ({ id: newId(), businessId, materialId })))
    .onConflictDoNothing({ target: [materialCosts.businessId, materialCosts.materialId] })
  await tx.execute(sql`
    select c.id from app.material_costs c
     where c.business_id = ${businessId} and c.material_id = any(${uuidArray(ids)})
     order by c.material_id
       for share
  `)
}

/** A product as what one unit sold uses needs it. */
export interface SoldProduct {
  readonly id: string
  readonly unit: StandardUnit
  readonly resaleMaterialId: string | null
}

/**
 * What one unit sold of each product uses (D-178, D-117, D-222): its recipe (base quantities for its
 * yield), its material bought ready to sell (the base units of its unit), or nothing (Materials off, no
 * recipe or a recipe without lines). Two reads.
 */
export async function itemMaterialsOf(
  tx: Tx,
  businessId: string,
  products: readonly SoldProduct[],
  materialsOn: boolean,
): Promise<Map<string, SaleItemMaterials>> {
  const uses = new Map<string, SaleItemMaterials>()
  if (products.length === 0) return uses
  if (!materialsOn) {
    for (const product of products) uses.set(product.id, { basis: 'none' })
    return uses
  }
  const ids = products.map((p) => p.id)
  const resaleIds = products.flatMap((p) => (p.resaleMaterialId ? [p.resaleMaterialId] : []))
  const recipeLines = (await tx.execute(sql`
    select r.product_id, trim_scale(r.yield_qty)::text as yield_qty, l.material_id,
           trim_scale(l.base_qty)::text as base_qty
      from app.recipes r
      join app.recipe_lines l
        on l.business_id = r.business_id and l.recipe_id = r.id and l.deleted_at is null
     where r.business_id = ${businessId}
       and r.product_id = any(${uuidArray(ids)})
       and r.deleted_at is null
     order by r.product_id, l.position, l.id
  `)) as unknown as {
    product_id: string
    yield_qty: string
    material_id: string
    base_qty: string
  }[]
  const resaleUnits = new Map(
    (
      (await tx.execute(sql`
        select m.id, m.unit from app.materials m
         where m.business_id = ${businessId} and m.id = any(${uuidArray(resaleIds)})
      `)) as unknown as { id: string; unit: StandardUnit }[]
    ).map((m) => [m.id, m.unit] as const),
  )
  for (const product of products) {
    if (product.resaleMaterialId !== null) {
      const unit = resaleUnits.get(product.resaleMaterialId)
      // One unit sold, in base units of its material (its unit is the product's, D-117).
      uses.set(
        product.id,
        unit !== undefined && dimensionOf(unit) === dimensionOf(product.unit)
          ? {
              basis: 'resale',
              materialId: product.resaleMaterialId,
              baseQty: STANDARD_UNITS[product.unit].factor,
            }
          : { basis: 'none' },
      )
      continue
    }
    const own = recipeLines.filter((l) => l.product_id === product.id)
    uses.set(
      product.id,
      own.length === 0
        ? { basis: 'none' }
        : {
            basis: 'recipe',
            yieldQty: own[0]!.yield_qty,
            lines: own.map((l) => ({ materialId: l.material_id, baseQty: l.base_qty })),
          },
    )
  }
  return uses
}

/** The sale_lines columns of a line's snapshot. */
export function lineCostColumns(snapshot: SaleLineCost) {
  const time = snapshot.time
  return {
    costBasis: snapshot.basis,
    cost: snapshot.cost,
    timeMinutes: time.state === 'applied' || time.state === 'rate_not_set' ? time.minutes : null,
    timeCost: time.state === 'applied' ? time.cost : null,
  }
}

/** The sale_line_materials rows of a line's snapshot. */
export function materialRows(
  businessId: string,
  saleId: string,
  saleLineId: string,
  snapshot: SaleLineCost,
) {
  return snapshot.materials.map((m) => ({
    id: newId(),
    businessId,
    saleId,
    saleLineId,
    materialId: m.materialId,
    baseQty: m.baseQty,
    unitCost: m.unitCost,
    cost: m.cost,
    basis: m.basis,
  }))
}

/**
 * Inserts the materials of every line of a sale being posted, in one statement whose rows are one
 * parameter (jsonRecords): 300 lines of a recipe of 60 materials are 18,000 rows, far beyond the
 * driver's 65,534 parameters had each value been one (D-209's rule: no valid sale fails to post).
 */
export async function insertMaterialRows(
  tx: Tx,
  rows: ReturnType<typeof materialRows>,
): Promise<void> {
  if (rows.length === 0) return
  await tx.execute(sql`
    insert into app.sale_line_materials
           (id, business_id, sale_id, sale_line_id, material_id, base_qty, unit_cost, cost, basis)
    select v.id, v.business_id, v.sale_id, v.sale_line_id, v.material_id, v.base_qty, v.unit_cost,
           v.cost, v.basis
      from jsonb_to_recordset(${jsonRecords(
        rows.map((r) => ({
          id: r.id,
          business_id: r.businessId,
          sale_id: r.saleId,
          sale_line_id: r.saleLineId,
          material_id: r.materialId,
          base_qty: r.baseQty,
          unit_cost: r.unitCost,
          cost: r.cost,
          basis: r.basis,
        })),
      )}) as v(id uuid, business_id uuid, sale_id uuid, sale_line_id uuid, material_id uuid,
               base_qty numeric, unit_cost numeric, cost numeric, basis text)
  `)
}

interface FillLineRecord extends Record<string, unknown> {
  id: string
  business_date: string
  cost_basis: SaleCostBasis
  cost: string | null
  time_minutes: string | null
  time_cost: string | null
}

interface FillMaterialRecord extends Record<string, unknown> {
  id: string
  sale_line_id: string
  material_id: string
  base_qty: string
  unit_cost: string | null
  cost: string | null
  basis: SaleMaterialBasis | null
}

/** Locks `lineIds` FOR NO KEY UPDATE by ascending id, then reads them with their sale's day. */
async function lockLines(tx: Tx, businessId: string, lineIds: readonly string[]) {
  const ids = [...new Set(lineIds)].sort()
  await tx.execute(sql`
    select l.id from app.sale_lines l
     where l.business_id = ${businessId} and l.id = any(${uuidArray(ids)})
     order by l.id
       for no key update
  `)
  // A new statement: it sees what a fill that held these lines committed.
  return (await tx.execute(sql`
    select l.id, s.business_date::text as business_date, l.cost_basis,
           trim_scale(l.cost)::text as cost, trim_scale(l.time_minutes)::text as time_minutes,
           trim_scale(l.time_cost)::text as time_cost
      from app.sale_lines l
      join app.sales s on s.business_id = l.business_id and s.id = l.sale_id
     where l.business_id = ${businessId} and l.id = any(${uuidArray(ids)})
     order by l.id
  `)) as unknown as FillLineRecord[]
}

/** A stored line as the domain's snapshot (its time as stored). */
function snapshotOf(line: FillLineRecord, materials: readonly FillMaterialRecord[]): SaleLineCost {
  const time: SaleTimeCost =
    line.time_minutes === null
      ? { state: 'none' }
      : line.time_cost === null
        ? { state: 'rate_not_set', minutes: line.time_minutes }
        : {
            state: 'applied',
            minutes: line.time_minutes,
            hourlyRate: '0',
            cost: line.time_cost as CostAmount,
          }
  return {
    basis: line.cost_basis,
    materials: materials.map((m) => ({
      materialId: m.material_id,
      baseQty: m.base_qty,
      unitCost: m.unit_cost as UnitCost | null,
      cost: m.cost as CostAmount | null,
      basis: m.basis,
    })),
    cost: line.cost as CostAmount | null,
    time,
  }
}

/**
 * After a purchase posted, or a return or credit note was reversed so its goods stand again (its own
 * locks held, its movements written): fills the missing material costs
 * of the finalized sales (posted or reversed: a reversal in a later month still counts its sale) of
 * the purchase's materials, once, from the purchases posted now (the first purchase that prices them,
 * averageAsOf as of each sale's day), and each line's cost once every material it uses has one
 * (fillSaleLineCost). Also into a closed month: it only completes a cost shown as "no price yet" (Q5).
 */
export async function fillSaleMaterialCosts(
  tx: Tx,
  businessId: string,
  materialIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(materialIds)]
  if (ids.length === 0) return
  const waiting = (await tx.execute(sql`
    select distinct m.sale_line_id
      from app.sale_line_materials m
      join app.sales s on s.business_id = m.business_id and s.id = m.sale_id
     where m.business_id = ${businessId}
       and m.material_id = any(${uuidArray(ids)})
       and m.cost is null and m.deleted_at is null
       and s.status in ('posted', 'reversed') and s.deleted_at is null
  `)) as unknown as { sale_line_id: string }[]
  if (waiting.length === 0) return
  const lines = await lockLines(
    tx,
    businessId,
    waiting.map((w) => w.sale_line_id),
  )
  const materials = (await tx.execute(sql`
    select m.id, m.sale_line_id, m.material_id, trim_scale(m.base_qty)::text as base_qty,
           trim_scale(m.unit_cost)::text as unit_cost, trim_scale(m.cost)::text as cost, m.basis
      from app.sale_line_materials m
     where m.business_id = ${businessId}
       and m.sale_line_id = any(${uuidArray(lines.map((l) => l.id))})
       and m.deleted_at is null
     order by m.sale_line_id, m.id
  `)) as unknown as FillMaterialRecord[]
  const purchases = await postedPurchaseLinesOf(tx, businessId, ids)
  const byLine = new Map<string, FillMaterialRecord[]>()
  for (const m of materials) {
    const list = byLine.get(m.sale_line_id)
    if (list) list.push(m)
    else byLine.set(m.sale_line_id, [m])
  }
  const materialUpdates: { id: string; unit_cost: string; cost: string; basis: string }[] = []
  const lineUpdates: { id: string; cost: string }[] = []
  for (const line of lines) {
    const own = byLine.get(line.id) ?? []
    const before = snapshotOf(line, own)
    const after = fillSaleLineCost(before, {
      day: line.business_date,
      purchases,
      hourlyRate: null,
    })
    if (after === before) continue
    after.materials.forEach((m, i) => {
      const was = own[i]!
      if (was.cost === null && m.cost !== null && m.unitCost !== null && m.basis !== null) {
        materialUpdates.push({ id: was.id, unit_cost: m.unitCost, cost: m.cost, basis: m.basis })
      }
    })
    if (line.cost === null && after.cost !== null)
      lineUpdates.push({ id: line.id, cost: after.cost })
  }
  // Each a single statement whose rows are one parameter (jsonRecords): a purchase may fill the rows
  // of thousands of sales entered before it (Q5) and still post.
  if (materialUpdates.length > 0) {
    await tx.execute(sql`
      update app.sale_line_materials m
         set unit_cost = v.unit_cost, cost = v.cost, basis = v.basis
        from jsonb_to_recordset(${jsonRecords(materialUpdates)})
             as v(id uuid, unit_cost numeric, cost numeric, basis text)
       where m.business_id = ${businessId} and m.id = v.id and m.cost is null
    `)
  }
  if (lineUpdates.length > 0) {
    await tx.execute(sql`
      update app.sale_lines l
         set cost = v.cost
        from jsonb_to_recordset(${jsonRecords(lineUpdates)}) as v(id uuid, cost numeric)
       where l.business_id = ${businessId} and l.id = v.id and l.cost is null
    `)
  }
}

/**
 * After the owner's hourly rate is set (the business row is locked by that update): fills the owner's
 * time of the finalized sales whose lines kept their minutes without a rate, once (D-222, Q7). Also
 * into a closed month.
 */
export async function fillSaleTimeCosts(
  tx: Tx,
  businessId: string,
  hourlyRate: string,
): Promise<void> {
  const waiting = (await tx.execute(sql`
    select l.id
      from app.sale_lines l
      join app.sales s on s.business_id = l.business_id and s.id = l.sale_id
     where l.business_id = ${businessId}
       and l.time_minutes is not null and l.time_cost is null and l.deleted_at is null
       and s.status in ('posted', 'reversed') and s.deleted_at is null
  `)) as unknown as { id: string }[]
  if (waiting.length === 0) return
  const lines = await lockLines(
    tx,
    businessId,
    waiting.map((w) => w.id),
  )
  const updates: { id: string; cost: string }[] = []
  for (const line of lines) {
    if (line.time_minutes === null || line.time_cost !== null) continue
    const after = fillSaleLineCost(snapshotOf(line, []), {
      day: line.business_date,
      purchases: new Map(),
      hourlyRate,
    })
    if (after.time.state === 'applied') updates.push({ id: line.id, cost: after.time.cost })
  }
  if (updates.length === 0) return
  await tx.execute(sql`
    update app.sale_lines l
       set time_cost = v.cost
      from jsonb_to_recordset(${jsonRecords(updates)}) as v(id uuid, cost numeric)
     where l.business_id = ${businessId} and l.id = v.id and l.time_cost is null
  `)
}
