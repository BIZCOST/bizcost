import { exactProduct, plain, roundHalfUp, toDec } from '../numbers/decimal'
import { COST_SCALE, QUANTITY_SCALE, type CostAmount, type UnitCost } from '../numbers/kinds'
import { PURCHASE_AVERAGE_DAYS } from '../purchasing/keys'
import { dayNumber } from './cost-share'
import type { OwnerTimePart } from './product-cost'

// The cost of what was sold (M3 Step 1, D-222; the owner's answer Q5 of D-218): worked out once, when
// a sale is finalized, and frozen in the snapshot that posting stores (sale_lines' cost, cost_basis
// and time cost; one sale_line_materials row per material). Nothing leaves stock before the first
// stock count (Phase 4, D-219): the snapshot is the expected usage Phase 4 reads.
//   - One unit sold uses its recipe's base quantity ÷ what the recipe makes (D-178), or, for an item
//     bought ready to sell, the base units of its material in one unit (D-117). A line uses qty × that,
//     rounded once to 6 decimals (a base quantity, D-108): 500 g of flour in a cake of 12 slices is
//     41.666667 g a slice.
//   - Each material is costed at the D-115 average AS OF THE SALE'S DAY, from the purchases posted
//     when the sale is finalized (averageAsOf): its purchases dated in the 90 days ending that day,
//     else its last purchase dated on or before it, else (a sale dated before the material was first
//     bought) its first purchase after it, the one that prices it. A purchase posted later, of any
//     date, never changes it. cost = base quantity × Σ value ÷ Σ base quantity, an exact product
//     divided once and rounded once to 12 decimals (D-107), never to the currency. The Spanish Latte:
//     1.17 + 1.2 + 0.257034632035 + 0.25 + 0.09 + 0.035 = 3.002034632035 a cup.
//   - A material never bought by then has no price yet: null, never 0 (D-186). The line's cost is
//     the sum once every material has one (null until then). fillSaleLineCost fills each missing one
//     ONCE, from the purchases posted when it runs (the first purchase that prices it), and never
//     changes a cost that is set.
//   - The owner's time, only without a team (D-119): minutes for one unit × qty × hourly rate ÷ 60,
//     divided once. Without an hourly rate it is null and is filled once when the rate is set (the
//     line's minutes are kept for that).
//   - A refund or credit (a negative quantity) mirrors its sale: negative usage, cost and time (half
//     away from zero, so round(−x) = −round(x)).
// The cost columns are unbounded numeric with 12 decimals, so nothing here is "too large" (D-209).

/** `sale_lines.cost_basis`: what one unit sold uses. */
export const SALE_COST_BASES = ['recipe', 'resale', 'none'] as const
export type SaleCostBasis = (typeof SALE_COST_BASES)[number]

/** `sale_line_materials.basis`: which purchases priced the material (averageAsOf). */
export const SALE_MATERIAL_BASES = ['purchases_90_days', 'last_purchase', 'first_purchase'] as const
export type SaleMaterialBasis = (typeof SALE_MATERIAL_BASES)[number]

/** A posted purchase line of a material, as the ledger has it (a standing receipt). */
export interface PostedPurchaseLine {
  /** The purchase it is on: the last (or first) purchase's lines of the material count together. */
  readonly purchaseId: string
  /** YYYY-MM-DD: the purchase's business date. */
  readonly businessDate: string
  /** Its posting order (stock_movements.seq, an integer): of two purchases of a day, the later. */
  readonly seq: string
  /** Its base quantity still standing (after returns, D-120); not more than zero: not counted. */
  readonly qty: string
  /** Its value still standing (after returns and credit notes), zero or more. */
  readonly value: string
}

/** The sums a material's average is made of as of a day, and which purchases they are. */
export interface DayAverage {
  readonly basis: SaleMaterialBasis
  /** Σ value of the purchases counted. */
  readonly value: string
  /** Σ base quantity of those purchases (more than zero). */
  readonly qty: string
}

const byOrder = (a: PostedPurchaseLine, b: PostedPurchaseLine) =>
  a.businessDate < b.businessDate
    ? -1
    : a.businessDate > b.businessDate
      ? 1
      : toDec(a.seq).comparedTo(toDec(b.seq))

/** Σ value and Σ base quantity of `lines`. */
function sums(lines: readonly PostedPurchaseLine[]): { value: string; qty: string } {
  let value = toDec('0')
  let qty = toDec('0')
  for (const line of lines) {
    value = value.plus(toDec(line.value))
    qty = qty.plus(toDec(line.qty))
  }
  return { value: plain(value), qty: plain(qty) }
}

/**
 * A material's D-115 average as of `day` (see above), from `purchases` (its posted purchase lines):
 * the 90 days ending that day; else its last purchase on or before it; else its first after it. Null
 * when none stands. Throws RangeError for a malformed day or a negative value.
 */
export function averageAsOf(
  day: string,
  purchases: readonly PostedPurchaseLine[],
): DayAverage | null {
  const today = dayNumber(day)
  const standing: PostedPurchaseLine[] = []
  for (const line of purchases) {
    dayNumber(line.businessDate)
    if (toDec(line.value).lt(0)) {
      throw new RangeError(`A purchase's value must not be negative: "${line.value}"`)
    }
    if (toDec(line.qty).gt(0)) standing.push(line)
  }
  const window = standing.filter((line) => {
    const at = dayNumber(line.businessDate)
    return at > today - PURCHASE_AVERAGE_DAYS && at <= today
  })
  if (window.length > 0) return { basis: 'purchases_90_days', ...sums(window) }
  const ordered = [...standing].sort(byOrder)
  const before = ordered.filter((line) => line.businessDate <= day)
  const pick = before.length > 0 ? before.at(-1)! : ordered[0]
  if (pick === undefined) return null
  const document = standing.filter((line) => line.purchaseId === pick.purchaseId)
  return { basis: before.length > 0 ? 'last_purchase' : 'first_purchase', ...sums(document) }
}

/** What one unit sold uses (the product's recipe, its resale material, or nothing). */
export type SaleItemMaterials =
  | {
      readonly basis: 'recipe'
      /** What the recipe makes (recipes.yield_qty, more than zero). */
      readonly yieldQty: string
      /** Each recipe line: its material and the base quantity the whole recipe uses. */
      readonly lines: readonly { readonly materialId: string; readonly baseQty: string }[]
    }
  | {
      readonly basis: 'resale'
      readonly materialId: string
      /** Base units of the material in one unit sold. */
      readonly baseQty: string
    }
  /** No materials: Materials off, a service without a recipe, delivery, a charge, a typed line. */
  | { readonly basis: 'none' }

/** One material of a sold line: a `sale_line_materials` row. */
export interface SaleMaterialCost {
  readonly materialId: string
  /** What the line uses, in the material's base unit (6 decimals; negative on a refund). */
  readonly baseQty: string
  /** The average per base unit it was costed at (Σ value ÷ Σ base quantity); null: no price yet. */
  readonly unitCost: UnitCost | null
  /** baseQty × the average, divided once (12 decimals); null: no price yet. */
  readonly cost: CostAmount | null
  /** Which purchases priced it; null: no price yet. */
  readonly basis: SaleMaterialBasis | null
}

/** The owner's time of a sold line (D-119): `team` and `none` have none. */
export type SaleTimeCost =
  | { readonly state: 'team' }
  | { readonly state: 'none' }
  /** Minutes without an hourly rate yet: filled once when it is set. */
  | { readonly state: 'rate_not_set'; readonly minutes: string }
  | {
      readonly state: 'applied'
      /** The line's minutes: minutes for one unit × qty (exact). */
      readonly minutes: string
      readonly hourlyRate: string
      /** minutes × hourly rate ÷ 60, divided once (12 decimals). */
      readonly cost: CostAmount
    }

/** The snapshot a sold line's posting stores. */
export interface SaleLineCost {
  readonly basis: SaleCostBasis
  /** One per recipe line (one for an item bought ready to sell; none for `none`). */
  readonly materials: readonly SaleMaterialCost[]
  /** Σ of the materials' costs once every one has a price; null until then, and with none. */
  readonly cost: CostAmount | null
  readonly time: SaleTimeCost
}

export interface SaleLineCostInput {
  /** The line's quantity, not zero (negative on a refund). */
  readonly qty: string
  /** The sale's business date (YYYY-MM-DD). */
  readonly day: string
  readonly materials: SaleItemMaterials
  /** Each material's posted purchase lines when the sale is finalized (missing: never bought). */
  readonly purchases: ReadonlyMap<string, readonly PostedPurchaseLine[]>
  /** The product's minutes and the owner's hourly rate, or a team (product-cost.ts). */
  readonly ownerTime: OwnerTimePart
}

/** A material's cost from its usage and the average as of the day (null: no price yet). */
function priced(materialId: string, baseQty: string, average: DayAverage | null): SaleMaterialCost {
  if (average === null) return { materialId, baseQty, unitCost: null, cost: null, basis: null }
  const divisor = toDec(average.qty)
  return {
    materialId,
    baseQty,
    unitCost: plain(roundHalfUp(toDec(average.value).dividedBy(divisor), COST_SCALE)) as UnitCost,
    cost: plain(
      roundHalfUp(
        exactProduct([toDec(baseQty), toDec(average.value)]).dividedBy(divisor),
        COST_SCALE,
      ),
    ) as CostAmount,
    basis: average.basis,
  }
}

/** Σ of the materials' costs when every one is priced; null otherwise (or with none). */
function lineCostOf(materials: readonly SaleMaterialCost[]): CostAmount | null {
  if (materials.length === 0 || materials.some((m) => m.cost === null)) return null
  return plain(materials.reduce((acc, m) => acc.plus(toDec(m.cost!)), toDec('0'))) as CostAmount
}

/** minutes × rate ÷ 60, divided once and rounded once to 12 decimals. */
function timeCostOf(minutes: string, hourlyRate: string): CostAmount {
  return plain(
    roundHalfUp(exactProduct([toDec(minutes), toDec(hourlyRate)]).dividedBy(60), COST_SCALE),
  ) as CostAmount
}

/** The owner's time of a line of `qty` units. */
function timeOf(qty: string, time: OwnerTimePart): SaleTimeCost {
  if (time.state === 'team') return { state: 'team' }
  if (time.minutes === null) return { state: 'none' }
  if (toDec(time.minutes).lt(0)) {
    throw new RangeError(`Minutes must not be negative: "${time.minutes}"`)
  }
  const minutes = plain(exactProduct([toDec(time.minutes), toDec(qty)]))
  if (time.hourlyRate === null) return { state: 'rate_not_set', minutes }
  if (toDec(time.hourlyRate).lt(0)) {
    throw new RangeError(`A rate must not be negative: "${time.hourlyRate}"`)
  }
  return {
    state: 'applied',
    minutes,
    hourlyRate: time.hourlyRate,
    cost: timeCostOf(minutes, time.hourlyRate),
  }
}

/** qty × baseQty ÷ yieldQty, rounded once to 6 decimals (a base quantity). */
function usage(qty: string, baseQty: string, yieldQty: string): string {
  const base = toDec(baseQty)
  if (base.lt(0)) throw new RangeError(`A quantity must not be negative: "${baseQty}"`)
  return plain(
    roundHalfUp(exactProduct([toDec(qty), base]).dividedBy(toDec(yieldQty)), QUANTITY_SCALE),
  )
}

/**
 * A sold line's cost, shaped as the snapshot its posting stores (see above). Pure: the caller reads
 * the recipe, the purchases posted when the sale is finalized and the owner's time. Throws RangeError
 * for a zero quantity, a yield not more than zero, negative quantities, values, minutes or rates.
 */
export function saleLineCost(input: SaleLineCostInput): SaleLineCost {
  const qty = toDec(input.qty)
  if (qty.isZero()) throw new RangeError('A sold quantity must not be zero')
  dayNumber(input.day)
  const time = timeOf(input.qty, input.ownerTime)
  const parts = input.materials
  const costOf = (materialId: string, baseQty: string) =>
    priced(materialId, baseQty, averageAsOf(input.day, input.purchases.get(materialId) ?? []))
  let basis: SaleCostBasis = parts.basis
  let materials: SaleMaterialCost[] = []
  if (parts.basis === 'recipe') {
    if (!toDec(parts.yieldQty).gt(0)) {
      throw new RangeError(`A yield must be more than zero: "${parts.yieldQty}"`)
    }
    materials = parts.lines.map((line) =>
      costOf(line.materialId, usage(input.qty, line.baseQty, parts.yieldQty)),
    )
    // A recipe with no line uses nothing that can be costed.
    if (materials.length === 0) basis = 'none'
  } else if (parts.basis === 'resale') {
    materials = [costOf(parts.materialId, usage(input.qty, parts.baseQty, '1'))]
  }
  return { basis, materials, cost: lineCostOf(materials), time }
}

export interface SaleCostFill {
  /** The sale's business date (YYYY-MM-DD). */
  readonly day: string
  /** Each material's posted purchase lines now. */
  readonly purchases: ReadonlyMap<string, readonly PostedPurchaseLine[]>
  /** businesses.owner_hourly_rate now; null: still not set. */
  readonly hourlyRate: string | null
}

/**
 * Fills what a posted line's snapshot still lacks, once (Q5): each material with no price yet takes
 * the average as of the sale's day from the purchases posted now (averageAsOf: the first purchase
 * that prices it), the line's cost follows once every material has one, and minutes without an hourly
 * rate take the rate once it is set. A value that is set is never changed (the same object is
 * returned when nothing is filled).
 */
export function fillSaleLineCost(snapshot: SaleLineCost, fill: SaleCostFill): SaleLineCost {
  dayNumber(fill.day)
  let changed = false
  const materials = snapshot.materials.map((material) => {
    if (material.cost !== null) return material
    const average = averageAsOf(fill.day, fill.purchases.get(material.materialId) ?? [])
    if (average === null) return material
    changed = true
    return priced(material.materialId, material.baseQty, average)
  })
  let time = snapshot.time
  if (time.state === 'rate_not_set' && fill.hourlyRate !== null) {
    if (toDec(fill.hourlyRate).lt(0)) {
      throw new RangeError(`A rate must not be negative: "${fill.hourlyRate}"`)
    }
    changed = true
    time = {
      state: 'applied',
      minutes: time.minutes,
      hourlyRate: fill.hourlyRate,
      cost: timeCostOf(time.minutes, fill.hourlyRate),
    }
  }
  if (!changed) return snapshot
  return {
    basis: snapshot.basis,
    materials,
    cost: snapshot.cost ?? lineCostOf(materials),
    time,
  }
}
