import { compareDecimal, replayWac, sumDecimals, type WacMovement } from '@bizcost/domain'
import type { Admin } from './helpers'

// The rebuild of a business's stock projections from its ledger (D-110 rule 2: "replayWac over the
// ledger must give the same cost row"; M2 Step 8). Read as postgres, independently of the API's own
// ledger code (services/stock.ts): every movement of the business in posting order (`seq`), each
// material's replayed with replayWac, and compared with what the postings stored:
//   - the cost row (one per material, D-006): quantity, value, average and `last_seq` (the material's
//     last movement); a material with movements has one, a cost row without movements is empty;
//   - each movement's `adjustment`: the replay's step for it (value after = value before + value −
//     adjustment, D-109), so the stored value is conserved: cost value = Σ value − Σ adjustment;
//   - the balances (one per location and material, D-114 rule 5): the sum of the movements' quantities
//     there; a pair with movements has a row.
// An empty list means the projections are exactly a rebuild of the ledger.

export interface Drift {
  readonly material: string
  readonly location?: string
  readonly what: string
  readonly stored: unknown
  readonly rebuilt: unknown
}

interface MovementRow {
  id: string
  seq: string
  material_id: string
  location_id: string
  kind: 'purchase' | 'purchase_return' | 'purchase_credit' | 'reversal'
  qty: string
  value: string
  adjustment: string
  receipt_id: string | null
  reverses_id: string | null
  reverses_kind: string | null
}

const negate = (v: string) => (v.startsWith('-') ? v.slice(1) : v === '0' ? '0' : `-${v}`)
const same = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : compareDecimal(a, b) === 0

/** A stored movement as the WAC engine reads it (values as posted). */
export function toWacMovement(r: MovementRow): WacMovement {
  switch (r.kind) {
    case 'purchase':
      return { type: 'receipt', id: r.id, qty: r.qty, value: r.value } as WacMovement
    case 'purchase_return':
      return {
        type: 'return',
        id: r.id,
        receiptId: r.receipt_id!,
        qty: negate(r.qty),
        value: negate(r.value),
      } as WacMovement
    case 'purchase_credit':
      return {
        type: 'credit',
        id: r.id,
        receiptId: r.receipt_id!,
        amount: negate(r.value),
      } as WacMovement
    case 'reversal':
      if (r.reverses_kind === 'purchase')
        return { type: 'receipt_reversal', receiptId: r.reverses_id! }
      if (r.reverses_kind === 'purchase_return') {
        return { type: 'return_reversal', returnId: r.reverses_id! }
      }
      return { type: 'credit_reversal', creditId: r.reverses_id! }
  }
}

/** Every difference between the business's projections and a rebuild from its ledger. */
export async function ledgerDrift(admin: Admin, businessId: string): Promise<Drift[]> {
  const drift: Drift[] = []
  const movements = await admin<MovementRow[]>`
    select m.id, m.seq::text as seq, m.material_id, m.location_id, m.kind,
           trim_scale(m.qty)::text as qty, trim_scale(m.value)::text as value,
           trim_scale(m.adjustment)::text as adjustment, m.receipt_id, m.reverses_id,
           r.kind as reverses_kind
      from app.stock_movements m
      left join app.stock_movements r on r.business_id = m.business_id and r.id = m.reverses_id
     where m.business_id = ${businessId}
     order by m.seq`
  const costRows = await admin<
    {
      material_id: string
      qty: string
      value: string
      avg_cost: string | null
      last_seq: string | null
    }[]
  >`
    select material_id, trim_scale(qty)::text as qty, trim_scale(value)::text as value,
           trim_scale(avg_cost)::text as avg_cost, last_seq::text as last_seq
      from app.material_costs where business_id = ${businessId}`
  const balances = await admin<{ location_id: string; material_id: string; qty: string }[]>`
    select location_id, material_id, trim_scale(qty)::text as qty
      from app.stock_balances where business_id = ${businessId}`

  const byMaterial = new Map<string, MovementRow[]>()
  for (const m of movements) {
    const list = byMaterial.get(m.material_id) ?? []
    list.push(m)
    byMaterial.set(m.material_id, list)
  }
  const costs = new Map(costRows.map((c) => [c.material_id, c]))

  for (const [material, ledger] of byMaterial) {
    let replay: ReturnType<typeof replayWac>
    try {
      replay = replayWac(ledger.map(toWacMovement))
    } catch (error) {
      drift.push({ material, what: 'replay', stored: ledger.length, rebuilt: String(error) })
      continue
    }
    const row = costs.get(material)
    if (!row) {
      drift.push({ material, what: 'cost row', stored: null, rebuilt: replay.state })
      continue
    }
    const { state } = replay
    if (!same(row.qty, state.qty))
      drift.push({ material, what: 'qty', stored: row.qty, rebuilt: state.qty })
    if (!same(row.value, state.value)) {
      drift.push({ material, what: 'value', stored: row.value, rebuilt: state.value })
    }
    if (!same(row.avg_cost, state.avgCost)) {
      drift.push({ material, what: 'average', stored: row.avg_cost, rebuilt: state.avgCost })
    }
    const lastSeq = ledger.at(-1)!.seq
    if (row.last_seq !== lastSeq) {
      drift.push({ material, what: 'last_seq', stored: row.last_seq, rebuilt: lastSeq })
    }
    for (const [index, movement] of ledger.entries()) {
      const step = replay.steps[index]!
      if (!same(movement.adjustment, step.adjustment)) {
        drift.push({
          material,
          what: `adjustment of ${movement.kind} ${movement.id}`,
          stored: movement.adjustment,
          rebuilt: step.adjustment,
        })
      }
    }
    // Conservation: what is on hand is what came in less what went out and the adjustments.
    const conserved = sumDecimals([
      ...ledger.map((m) => m.value),
      ...ledger.map((m) => negate(m.adjustment)),
    ])
    if (!same(row.value, conserved)) {
      drift.push({ material, what: 'value conserved', stored: row.value, rebuilt: conserved })
    }
  }
  for (const row of costRows) {
    if (byMaterial.has(row.material_id)) continue
    if (
      !same(row.qty, '0') ||
      !same(row.value, '0') ||
      row.avg_cost !== null ||
      row.last_seq !== null
    ) {
      drift.push({
        material: row.material_id,
        what: 'cost row without movements',
        stored: row,
        rebuilt: null,
      })
    }
  }

  const sums = new Map<string, { location: string; material: string; qty: string[] }>()
  for (const m of movements) {
    const key = `${m.location_id}:${m.material_id}`
    const entry = sums.get(key) ?? { location: m.location_id, material: m.material_id, qty: [] }
    entry.qty.push(m.qty)
    sums.set(key, entry)
  }
  const stored = new Map(balances.map((b) => [`${b.location_id}:${b.material_id}`, b]))
  for (const [key, sum] of sums) {
    const qty = sumDecimals(sum.qty)
    const balance = stored.get(key)
    if (!balance || !same(balance.qty, qty)) {
      drift.push({
        material: sum.material,
        location: sum.location,
        what: 'balance',
        stored: balance?.qty ?? null,
        rebuilt: qty,
      })
    }
  }
  for (const [key, balance] of stored) {
    if (!sums.has(key) && !same(balance.qty, '0')) {
      drift.push({
        material: balance.material_id,
        location: balance.location_id,
        what: 'balance without movements',
        stored: balance.qty,
        rebuilt: '0',
      })
    }
  }
  return drift
}
