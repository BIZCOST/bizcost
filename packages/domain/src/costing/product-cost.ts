import type { ProductType, VatCategory } from '../catalog/keys'
import { exactProduct, plain, roundHalfUp, toDec } from '../numbers/decimal'
import { checkDecimal, COST_SCALE, type CostAmount, type Percent } from '../numbers/kinds'
import { costRate, costShare, type RunningCostsPart } from './cost-share'

// A product's cost for one unit sold, and its margin (ROADMAP.md M2 Step 6; D-115, D-119, D-121,
// D-178, D-202). Each part is its own line:
//   - materials: what its recipe uses at the materials' averages (rollUpRecipe's perUnit: the total ÷
//     what the recipe makes), or for an item bought ready to sell its material's average (D-117);
//   - running costs, by its price (D-202, which replaces D-116's share of the material cost): its
//     price before VAT × the month's costs ÷ the month's sales (cost-share.ts), an exact product
//     divided once. Sales arrive in Phase 3: until then the share is "awaiting sales" and the total
//     and margin are before running costs (`beforeRunningCosts`), which is nothing the member can add
//     (never a reason the cost is incomplete). A product or service without a price cannot carry a
//     share by its price: that is a reason (`no_price`, "add its price");
//   - the owner's time, for a business without a team (D-119): minutes × hourly rate ÷ 60.
// The total is their exact sum. Nothing is rounded to the currency (D-107): each division is
// rounded once, half away from zero, to 12 decimals, and screens round what they show.
//
// Nothing missing is ever 0: a material with no price, a price missing for the share, minutes
// without an hourly rate each leave their part out (null) and say why (`reasons`), so the total is
// marked incomplete. The margin is worked out on what is known and carries the same flags.
//
// The price the margin is taken from is before VAT: VAT is never revenue (D-114, D-121). A price that
// includes VAT loses it only when the business is VAT-registered (the product's VAT category gives
// the rate: 5 % standard in the UAE, 0 for zero-rated and exempt); otherwise it is the price as is.

/** The UAE standard VAT rate, in percent: the rate of the `standard` VAT category (D-121). */
export const STANDARD_VAT_RATE = '5' as Percent

/** The VAT rate a sale in `category` charges, in percent (D-121). */
export function saleVatRate(category: VatCategory): Percent {
  return category === 'standard' ? STANDARD_VAT_RATE : ('0' as Percent)
}

/** The price a margin is taken from (see above). */
export interface SalePrice {
  /** products_services.default_price; null while not set. */
  readonly price: string | null
  readonly priceIncludesVat: boolean
  readonly vatCategory: VatCategory
  /** businesses.vat_registered. */
  readonly vatRegistered: boolean
}

/** The VAT rate to take out of the price: the category's when it includes VAT and applies, else 0. */
function strippedVatRate(sale: SalePrice): string {
  return sale.vatRegistered && sale.priceIncludesVat ? saleVatRate(sale.vatCategory) : '0'
}

/**
 * The price before VAT: price × 100 ÷ (100 + rate), one division rounded once to 12 decimals (the
 * price itself when no VAT is taken out). 18 with 5 % VAT in it: 17.142857142857. Null without a
 * price. Throws RangeError for a negative price.
 */
export function priceBeforeVat(sale: SalePrice): CostAmount | null {
  if (sale.price === null) return null
  const price = toDec(sale.price)
  if (price.lt(0)) throw new RangeError(`A price must not be negative: "${sale.price}"`)
  const rate = strippedVatRate(sale)
  if (toDec(rate).isZero()) return plain(price) as CostAmount
  return plain(
    roundHalfUp(exactProduct([price, toDec('100')]).dividedBy(toDec(rate).plus(100)), COST_SCALE),
  ) as CostAmount
}

/** A value that fits a cost amount (numeric(28,12)), else null. */
function fitting(value: CostAmount): CostAmount | null {
  return checkDecimal(value, 'costAmount') === null ? value : null
}

/**
 * The owner's time for one unit (D-119): minutes × hourly rate ÷ 60, an exact product divided once
 * and rounded once to 12 decimals. 10 minutes at AED 45 an hour = 7.5. Throws RangeError for negative
 * inputs.
 */
export function ownerTimeCost(minutes: string, hourlyRate: string): CostAmount {
  if (toDec(minutes).lt(0)) throw new RangeError(`Minutes must not be negative: "${minutes}"`)
  if (toDec(hourlyRate).lt(0)) throw new RangeError(`A rate must not be negative: "${hourlyRate}"`)
  return plain(
    roundHalfUp(exactProduct([toDec(minutes), toDec(hourlyRate)]).dividedBy(60), COST_SCALE),
  ) as CostAmount
}

/**
 * Minutes as whole hours and the minutes left, for saying a long time in words: "75" → 1 hour and
 * "15"; "600" → 10 and "0"; "12.5" → 0 and "12.5" (exact). Throws RangeError for a negative time.
 */
export function hoursAndMinutes(minutes: string): { hours: string; minutes: string } {
  const value = toDec(minutes)
  if (value.lt(0)) throw new RangeError(`Minutes must not be negative: "${minutes}"`)
  const hours = value.dividedToIntegerBy(60)
  return { hours: plain(hours), minutes: plain(value.minus(hours.times(60))) }
}

// ---------------------------------------------------------------------------------------------------
// The whole cost of one unit sold
// ---------------------------------------------------------------------------------------------------

/** What its materials cost, as rollUpRecipe (or an item bought ready to sell) gives it. */
export type MaterialsPart =
  /** The Materials module is off: the product has no materials part. */
  | { readonly state: 'off' }
  | {
      readonly state: 'on'
      /** One unit sold (the recipe's total ÷ its yield); null: none priced, or too large. */
      readonly perUnit: string | null
      /** Recipe lines (1 for an item bought ready to sell; 0: no recipe yet). */
      readonly lineCount: number
      /** Lines whose material has no price yet. */
      readonly unpricedLines: number
      /** One unit's cost does not fit a cost amount. */
      readonly tooLarge: boolean
    }

/** The owner's own time (D-119): only for a business without a team. */
export type OwnerTimePart =
  | { readonly state: 'team' }
  | {
      readonly state: 'solo'
      /** products_services.owner_minutes for one unit; null: no time line. */
      readonly minutes: string | null
      /** businesses.owner_hourly_rate; null: not set yet. */
      readonly hourlyRate: string | null
    }

export interface ProductCostInput {
  readonly materials: MaterialsPart
  /** The month's costs and sales the share is worked out from (D-202). */
  readonly runningCosts: RunningCostsPart
  readonly ownerTime: OwnerTimePart
  readonly sale: SalePrice
}

/**
 * The running-cost line (D-202):
 * - `off`: neither Running Costs nor Expenses is on (no line: nothing to share);
 * - `no_price`: it has no price, so no share can be worked out by it ("add its price");
 * - `awaiting_sales`: worked out automatically once sales are recorded; until then the total and the
 *   margin are before running costs;
 * - `before_running_costs`: sales are recorded, but the rate worked out so far shows only once 7 days
 *   of sales exist (a first month's first days, Q6, M3 Step 3); until then, as awaiting sales;
 * - `none`: the month's costs come to zero or less: the share is 0;
 * - `applied`: the share is worked out.
 */
export const RUNNING_SHARE_STATES = [
  'off',
  'no_price',
  'awaiting_sales',
  'before_running_costs',
  'none',
  'applied',
] as const
export type RunningShareState = (typeof RUNNING_SHARE_STATES)[number]

/**
 * The owner's time line: `team` (a business with a team: none, D-119), `none` (no minutes for this
 * product), `rate_not_set` (minutes without the hourly rate: never 0), `applied`.
 */
export type OwnerTimeState = 'team' | 'none' | 'rate_not_set' | 'applied'

/**
 * Why a product's cost is incomplete: something the member can add (each is a line the screen says
 * in words):
 * - `no_recipe`: nothing entered for what it uses (Materials on, no recipe lines; optional for a
 *   service);
 * - `unpriced_materials`: some of its materials were never bought;
 * - `no_price`: it has no price, and running costs are shared by the price (D-202);
 * - `hourly_rate_not_set`: minutes for it and no hourly rate;
 * - `nothing_counted`: no part of it is counted at all, and none awaits sales.
 * A share awaiting sales is not one of them (D-202): nothing can be added for it before Phase 3, and
 * when it is the only line, nothing is missing (D-203).
 */
export const INCOMPLETE_REASONS = [
  'no_recipe',
  'unpriced_materials',
  'no_price',
  'hourly_rate_not_set',
  'nothing_counted',
] as const
export type IncompleteReason = (typeof INCOMPLETE_REASONS)[number]

export interface ProductCost {
  /** Materials for one unit sold; null: none priced yet, too large, or Materials off. */
  readonly materials: CostAmount | null
  readonly runningCosts: {
    readonly state: RunningShareState
    /** The month's costs ÷ its sales (0 when they come to zero or less); null until worked out. */
    readonly rate: CostAmount | null
    /** Price before VAT × costs ÷ sales; '0' with no costs; null unless `applied`/`none`. */
    readonly share: CostAmount | null
  }
  readonly ownerTime: {
    readonly state: OwnerTimeState
    readonly amount: CostAmount | null
  }
  /** Σ of the parts worked out (exact); null when none is, or when it is too large. */
  readonly total: CostAmount | null
  /**
   * The running-cost share applies but is not in the total yet (awaiting sales, or no price): the
   * total and the margin are before running costs, never final.
   */
  readonly beforeRunningCosts: boolean
  /** A part or the total does not fit a cost amount (numeric(28,12)): nothing is totalled. */
  readonly tooLarge: boolean
  /** Why it is incomplete, in the order of INCOMPLETE_REASONS; empty when complete. */
  readonly reasons: readonly IncompleteReason[]
  /** Nothing the member can add is missing, and something is counted (see beforeRunningCosts). */
  readonly complete: boolean
  /** The price before VAT (priceBeforeVat); null without a price. */
  readonly priceBeforeVat: CostAmount | null
  /** Price before VAT − total (exact); null without either. Worked out on what is known. */
  readonly margin: CostAmount | null
  /**
   * margin ÷ price before VAT × 100, from the exact price (one division, 12 decimals); null without
   * a margin, with a price of 0, or when it does not fit.
   */
  readonly marginPercent: string | null
}

function runningShareOf(
  running: RunningCostsPart,
  beforeVat: CostAmount | null,
): ProductCost['runningCosts'] {
  if (running.state === 'off') return { state: 'off', rate: null, share: null }
  if (beforeVat === null) return { state: 'no_price', rate: null, share: null }
  if (running.state === 'before_running_costs') {
    return { state: 'before_running_costs', rate: null, share: null }
  }
  const { state, rate } = costRate(running)
  if (state === 'awaiting_sales') return { state: 'awaiting_sales', rate: null, share: null }
  if (state === 'none') return { state: 'none', rate: '0' as CostAmount, share: '0' as CostAmount }
  return {
    state: 'applied',
    rate: rate === null ? null : fitting(rate),
    share: costShare(beforeVat, running.costs, running.sales),
  }
}

/** The share applies and is not worked out yet: awaiting sales, or before 7 days of sales (Q6). */
function sharePending(state: RunningShareState): boolean {
  return state === 'awaiting_sales' || state === 'before_running_costs'
}

function ownerTimeOf(time: OwnerTimePart): ProductCost['ownerTime'] {
  if (time.state === 'team') return { state: 'team', amount: null }
  if (time.minutes === null) return { state: 'none', amount: null }
  if (time.hourlyRate === null) return { state: 'rate_not_set', amount: null }
  return { state: 'applied', amount: ownerTimeCost(time.minutes, time.hourlyRate) }
}

/**
 * A product's cost for one unit sold, part by part, and its margin (see above). Pure: the caller
 * reads the sums in SQL and passes them. Throws RangeError for negative or malformed inputs.
 */
export function productCost(input: ProductCostInput): ProductCost {
  const { materials: part, sale } = input
  const materials = part.state === 'on' ? part.perUnit : null
  if (materials !== null && toDec(materials).lt(0)) {
    throw new RangeError(`A cost must not be negative: "${materials}"`)
  }
  const beforeVat = priceBeforeVat(sale)
  const shareOf = runningShareOf(input.runningCosts, beforeVat)
  const timeOf = ownerTimeOf(input.ownerTime)
  // A share or a time line that does not fit a cost amount is not given (the cost is too large).
  const shareFits = shareOf.share === null || fitting(shareOf.share) !== null
  const timeFits = timeOf.amount === null || fitting(timeOf.amount) !== null
  const runningCosts = shareFits ? shareOf : { ...shareOf, share: null }
  const ownerTime = timeFits ? timeOf : { ...timeOf, amount: null }

  const reasons = new Set<IncompleteReason>()
  if (part.state === 'on' && part.lineCount === 0) reasons.add('no_recipe')
  if (part.state === 'on' && part.unpricedLines > 0) reasons.add('unpriced_materials')
  if (runningCosts.state === 'no_price') reasons.add('no_price')
  if (ownerTime.state === 'rate_not_set') reasons.add('hourly_rate_not_set')

  // What is counted: a share of 0 (no costs) adds nothing and counts nothing by itself.
  const parts = [
    materials,
    runningCosts.state === 'applied' ? runningCosts.share : null,
    ownerTime.amount,
  ].filter((value): value is string => value !== null)
  const partsFit = shareFits && timeFits
  const sum =
    parts.length === 0
      ? null
      : (plain(parts.reduce((acc, value) => acc.plus(toDec(value)), toDec('0'))) as CostAmount)
  const tooLarge =
    (part.state === 'on' && part.tooLarge) || !partsFit || (sum !== null && fitting(sum) === null)
  const total = tooLarge ? null : sum
  // Nothing counted and nothing to add: incomplete, unless its share awaits sales (D-203) or 7 days of
  // sales (Q6), the line that will count (with a team and without materials it is the only one).
  if (total === null && !tooLarge && reasons.size === 0 && !sharePending(runningCosts.state)) {
    reasons.add('nothing_counted')
  }

  const margin =
    beforeVat === null || total === null
      ? null
      : fitting(plain(toDec(beforeVat).minus(toDec(total))) as CostAmount)
  let marginPercent: string | null = null
  if (margin !== null && sale.price !== null && toDec(sale.price).gt(0)) {
    // (price × 100 − total × (100 + rate)) ÷ price: the exact margin ÷ the exact price before VAT,
    // × 100, divided once.
    const kept = toDec(strippedVatRate(sale)).plus(100)
    const numerator = toDec(sale.price)
      .times(100)
      .minus(exactProduct([toDec(total!), kept]))
    marginPercent = fitting(
      plain(roundHalfUp(numerator.dividedBy(toDec(sale.price)), COST_SCALE)) as CostAmount,
    )
  }

  const ordered = INCOMPLETE_REASONS.filter((reason) => reasons.has(reason))
  return {
    materials: materials as CostAmount | null,
    runningCosts,
    ownerTime,
    total,
    beforeRunningCosts: runningCosts.state === 'no_price' || sharePending(runningCosts.state),
    tooLarge,
    reasons: ordered,
    complete: ordered.length === 0 && !tooLarge,
    priceBeforeVat: beforeVat,
    margin,
    marginPercent,
  }
}

/**
 * A service whose cost is complete but for its optional materials (D-186, D-200, D-202, D-203): it
 * uses no materials (its recipe is optional), nothing else is missing, and something is counted (the
 * owner's time) or will be (its share awaits sales), so its cost is not empty. The screens say it has
 * no materials as a hint, not as something missing.
 */
export function missesOnlyOptionalMaterials(type: ProductType, cost: ProductCost): boolean {
  return (
    type === 'service' &&
    cost.materials === null &&
    (cost.total !== null || sharePending(cost.runningCosts.state)) &&
    cost.reasons.length === 1 &&
    cost.reasons[0] === 'no_recipe'
  )
}

/**
 * Whether a product's or service's cost is complete as the screens and counts say it (D-203): nothing
 * missing that can be added (`complete`), or a service that misses only its optional materials. It
 * puts nothing under "incomplete" or "Needs a look", and holds no checklist step back.
 */
export function costCompleteFor(type: ProductType, cost: ProductCost): boolean {
  return cost.complete || missesOnlyOptionalMaterials(type, cost)
}
