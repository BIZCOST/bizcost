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
//     there; a pair with movements has a row;
//   - the two projections against each other: a material's cost row quantity is its balances added.
// Counts (M4 Step 2, D-340): a first count's rows of one material (one per branch line, consecutive)
// are one opening of what its lines counted together, worth their values added, at the average they
// name; their adjustments add up to the stock's value just before it (the book it replaced), and
// their reversal rows are one opening reversal whose adjustments add up to its step's. A count's row
// is a count difference.
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
  kind: 'purchase' | 'purchase_return' | 'purchase_credit' | 'reversal' | 'opening' | 'count'
  qty: string
  value: string
  adjustment: string
  unit_cost: string | null
  receipt_id: string | null
  reverses_id: string | null
  reverses_kind: string | null
  count_id: string | null
  counted_qty: string | null
}

const negate = (v: string) => (v.startsWith('-') ? v.slice(1) : v === '0' ? '0' : `-${v}`)
const same = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : compareDecimal(a, b) === 0

/** A stored movement (not a first count's row) as the WAC engine reads it (values as posted). */
export function toWacMovement(r: MovementRow): WacMovement {
  switch (r.kind) {
    case 'opening':
      throw new Error('an opening is read with the other rows of its count (groupsOf)')
    case 'count':
      return { type: 'count', id: r.id, qty: r.qty } as WacMovement
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
      if (r.reverses_kind === 'count') return { type: 'count_reversal', countId: r.reverses_id! }
      return { type: 'credit_reversal', creditId: r.reverses_id! }
  }
}

/** One engine movement and the stored rows it is made of (several for a first count). */
interface Group {
  readonly rows: MovementRow[]
  readonly movement: WacMovement
}

/**
 * A material's stored rows as engine movements: a first count's consecutive rows are one opening
 * (what its lines counted, their values added, the average they name), their reversal rows one
 * opening reversal; every other row is one movement.
 */
function groupsOf(ledger: readonly MovementRow[]): Group[] {
  const groups: Group[] = []
  const openings = new Map<string, string>()
  for (const r of ledger) {
    const last = groups.at(-1)
    const lastRow = last?.rows.at(-1)
    if (r.kind === 'opening') {
      if (last && lastRow?.kind === 'opening' && lastRow.count_id === r.count_id) {
        last.rows.push(r)
        const rows = last.rows
        groups[groups.length - 1] = {
          rows,
          movement: {
            type: 'opening',
            id: rows[0]!.id,
            qty: sumDecimals(rows.map((x) => x.counted_qty ?? '0')),
            value: sumDecimals(rows.map((x) => x.value)),
            avgCost: rows[0]!.unit_cost,
          } as WacMovement,
        }
        continue
      }
      openings.set(r.count_id ?? '', r.id)
      groups.push({
        rows: [r],
        movement: {
          type: 'opening',
          id: r.id,
          qty: r.counted_qty ?? '0',
          value: r.value,
          avgCost: r.unit_cost,
        } as WacMovement,
      })
      continue
    }
    if (r.kind === 'reversal' && r.reverses_kind === 'opening') {
      if (last && last.movement.type === 'opening_reversal' && lastRow?.count_id === r.count_id) {
        last.rows.push(r)
        continue
      }
      groups.push({
        rows: [r],
        movement: { type: 'opening_reversal', openingId: openings.get(r.count_id ?? '') ?? '' },
      })
      continue
    }
    groups.push({ rows: [r], movement: toWacMovement(r) })
  }
  return groups
}

/** Every difference between the business's projections and a rebuild from its ledger. */
export async function ledgerDrift(admin: Admin, businessId: string): Promise<Drift[]> {
  const drift: Drift[] = []
  const movements = await admin<MovementRow[]>`
    select m.id, m.seq::text as seq, m.material_id, m.location_id, m.kind,
           trim_scale(m.qty)::text as qty, trim_scale(m.value)::text as value,
           trim_scale(m.adjustment)::text as adjustment, trim_scale(m.unit_cost)::text as unit_cost,
           m.receipt_id, m.reverses_id, r.kind as reverses_kind, cl.count_id,
           trim_scale(cl.counted_base_qty)::text as counted_qty
      from app.stock_movements m
      left join app.stock_movements r on r.business_id = m.business_id and r.id = m.reverses_id
      left join app.stock_count_lines cl
        on cl.business_id = m.business_id and cl.id = m.count_line_id
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
    let groups: Group[]
    try {
      groups = groupsOf(ledger)
      replay = replayWac(groups.map((g) => g.movement))
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
    for (const [index, group] of groups.entries()) {
      const step = replay.steps[index]!
      const first = group.rows[0]!
      const adjustment = sumDecimals(group.rows.map((r) => r.adjustment))
      // A first count's rows carry the book they replaced: the stock's value just before it (its
      // step moves the value by value − that, with no adjustment of its own).
      const expected =
        group.movement.type === 'opening'
          ? index === 0
            ? '0'
            : replay.steps[index - 1]!.state.value
          : step.adjustment
      if (!same(adjustment, expected)) {
        drift.push({
          material,
          what: `adjustment of ${first.kind} ${first.id}`,
          stored: adjustment,
          rebuilt: expected,
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

  // The two projections agree with each other: a material's one quantity (its cost row) is what its
  // branches hold together (its balances). Each may rebuild from the ledger and still part from the
  // other (a first count is absolute in the cost engine, relative per branch in the balances).
  const held = new Map<string, string[]>()
  for (const b of balances) held.set(b.material_id, [...(held.get(b.material_id) ?? []), b.qty])
  for (const material of new Set([...costs.keys(), ...held.keys()])) {
    const costQty = costs.get(material)?.qty ?? '0'
    const branches = sumDecimals(held.get(material) ?? [])
    if (!same(costQty, branches)) {
      drift.push({
        material,
        what: 'cost row qty ≠ Σ balances',
        stored: costQty,
        rebuilt: branches,
      })
    }
  }
  return drift
}
