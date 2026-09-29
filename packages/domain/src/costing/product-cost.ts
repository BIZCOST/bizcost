import type { ProductType, VatCategory } from '../catalog/keys'
import { exactProduct, plain, roundHalfUp, toDec } from '../numbers/decimal'
import { checkDecimal, COST_SCALE, type CostAmount, type Percent } from '../numbers/kinds'

// A product's cost for one unit sold, and its margin (ROADMAP.md M2 Step 6; D-115, D-116, D-119,
// D-121, D-178). Each part is its own line:
//   - materials: what its recipe uses at the materials' averages (rollUpRecipe's perUnit: the total ÷
//     what the recipe makes), or for an item bought ready to sell its material's average (D-117);
//   - running costs, as a share of the material cost (D-116, method "a share of the material cost"):
//     materials × monthly running costs ÷ monthly material purchases, an exact product divided once.
//     The rate (running costs ÷ purchases) is what "each dirham of materials carries";
//   - the owner's time, for a business without a team (D-119): minutes × hourly rate ÷ 60.
// The total is their exact sum. Nothing is rounded to the currency (D-107): each division is
// rounded once, half away from zero, to 12 decimals, and screens round what they show.
//
// Nothing missing is ever 0: a material with no price, running costs with nothing to divide them by,
// minutes without an hourly rate each leave their part out (null) and say why (`reasons`), so the
// total is marked incomplete. The margin is worked out on what is known and carries the same flag.
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

/** Full calendar months of purchases the monthly average counts (D-116). */
export const PURCHASE_MONTHS = 3

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

/** Divides once and rounds once to 12 decimals: the exact product of `numerators` ÷ `divisor`. */
function divideOnce(numerators: readonly string[], divisor: string): CostAmount {
  return plain(
    roundHalfUp(exactProduct(numerators.map(toDec)).dividedBy(toDec(divisor)), COST_SCALE),
  ) as CostAmount
}

/** A value that fits a cost amount (numeric(28,12)), else null. */
function fitting(value: CostAmount): CostAmount | null {
  return checkDecimal(value, 'costAmount') === null ? value : null
}

/**
 * The monthly material purchases from the last full months (D-116): their total ÷ the months, one
 * division rounded once to 12 decimals. Throws RangeError for a negative total.
 */
export function monthlyPurchasesAverage(total: string, months = PURCHASE_MONTHS): CostAmount {
  if (toDec(total).lt(0)) throw new RangeError(`Purchases must not be negative: "${total}"`)
  return divideOnce([total], String(months))
}

/**
 * The running-cost rate (D-116): monthly running costs ÷ monthly material purchases, rounded once to
 * 12 decimals: what each unit of currency of materials carries. 15 000 ÷ 30 000 = 0.5. Null when
 * there are no purchases to divide by (not more than zero). Throws RangeError for negative inputs.
 */
export function runningCostRate(
  monthlyRunningCosts: string,
  monthlyPurchases: string,
): CostAmount | null {
  if (toDec(monthlyRunningCosts).lt(0)) {
    throw new RangeError(`Running costs must not be negative: "${monthlyRunningCosts}"`)
  }
  if (!toDec(monthlyPurchases).gt(0)) return null
  return divideOnce([monthlyRunningCosts], monthlyPurchases)
}

/**
 * A product's running-cost share (D-116): its material cost × monthly running costs ÷ monthly
 * purchases, an exact product divided once and rounded once to 12 decimals (never the rounded rate ×
 * the materials). AED 4 of materials at 15 000 ÷ 30 000 carries AED 2. Null when there are no
 * purchases to divide by. Throws RangeError for negative inputs.
 */
export function runningCostShare(
  materials: string,
  monthlyRunningCosts: string,
  monthlyPurchases: string,
): CostAmount | null {
  if (toDec(materials).lt(0)) throw new RangeError(`A cost must not be negative: "${materials}"`)
  if (toDec(monthlyRunningCosts).lt(0)) {
    throw new RangeError(`Running costs must not be negative: "${monthlyRunningCosts}"`)
  }
  if (!toDec(monthlyPurchases).gt(0)) return null
  return divideOnce([materials, monthlyRunningCosts], monthlyPurchases)
}

/**
 * The owner's time for one unit (D-119): minutes × hourly rate ÷ 60, an exact product divided once
 * and rounded once to 12 decimals. 10 minutes at AED 45 an hour = 7.5. Throws RangeError for negative
 * inputs.
 */
export function ownerTimeCost(minutes: string, hourlyRate: string): CostAmount {
  if (toDec(minutes).lt(0)) throw new RangeError(`Minutes must not be negative: "${minutes}"`)
  if (toDec(hourlyRate).lt(0)) throw new RangeError(`A rate must not be negative: "${hourlyRate}"`)
  return divideOnce([minutes, hourlyRate], '60')
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
// Which months of purchases count (D-116)
// ---------------------------------------------------------------------------------------------------

/** YYYY-MM-DD of the first day of the month `offset` months from the month of `day` (YYYY-MM-DD). */
function monthStart(day: string, offset: number): string {
  const year = Number.parseInt(day.slice(0, 4), 10)
  const month = Number.parseInt(day.slice(5, 7), 10) - 1 + offset
  const y = year + Math.floor(month / 12)
  const m = ((month % 12) + 12) % 12
  return `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-01`
}

/** YYYY-MM-DD of the last day of the month before the month that starts on `nextMonthStart`. */
function dayBefore(nextMonthStart: string): string {
  const date = new Date(`${nextMonthStart}T00:00:00Z`)
  date.setUTCDate(0)
  return date.toISOString().slice(0, 10)
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

export interface PurchaseMonths {
  /** The last 3 full calendar months before today's month: first and last day. */
  readonly from: string
  readonly to: string
  /**
   * The first day on which they can count: the first day of the 4th month after the month of the
   * first posted purchase (3 full months have passed after it). Null: nothing bought yet.
   */
  readonly countsFrom: string | null
  /** How many of those 3 months hold at least one posted purchase still standing (0 to 3). */
  readonly monthsBought: number
  /**
   * They count today: countsFrom is on or before today, and each of the 3 months holds a purchase
   * (old invoices typed in on the first day do not make months of almost nothing count, D-186).
   */
  readonly ready: boolean
}

/**
 * The months the monthly purchases average counts on `today` (YYYY-MM-DD, the business's day), given
 * the day of the business's first posted purchase (null: none) and how many of the 3 months hold a
 * posted purchase. On 29 September 2026 they are June to August; with a first purchase in May they
 * can count (from 1 September), with one in June not yet (from 1 October); and they count only when
 * June, July and August each hold a purchase. Until then the owner's estimate is used (D-116,
 * D-186). Throws RangeError for a malformed day or a count outside 0 to 3.
 */
export function purchaseMonths(
  today: string,
  firstPurchase: string | null,
  monthsBought: number,
): PurchaseMonths {
  if (!DAY.test(today)) throw new RangeError(`Not a day: "${today}"`)
  if (firstPurchase !== null && !DAY.test(firstPurchase)) {
    throw new RangeError(`Not a day: "${firstPurchase}"`)
  }
  if (!Number.isInteger(monthsBought) || monthsBought < 0 || monthsBought > PURCHASE_MONTHS) {
    throw new RangeError(`Not a count of months: ${String(monthsBought)}`)
  }
  const from = monthStart(today, -PURCHASE_MONTHS)
  const to = dayBefore(monthStart(today, 0))
  const countsFrom = firstPurchase === null ? null : monthStart(firstPurchase, PURCHASE_MONTHS + 1)
  const ready = countsFrom !== null && countsFrom <= today && monthsBought === PURCHASE_MONTHS
  return { from, to, countsFrom, monthsBought, ready }
}

export type MonthlyPurchasesSource = 'last_3_months' | 'estimate'

export interface MonthlyPurchases {
  /** Which figure the rate divides by; null: neither (the running-cost share is "not set yet"). */
  readonly source: MonthlyPurchasesSource | null
  /** The figure itself (more than zero), or null. */
  readonly monthly: CostAmount | null
  /** The last 3 full months' average, once they count (null before; it may be 0). */
  readonly average: CostAmount | null
}

/**
 * The monthly material purchases the running-cost rate divides by (D-116): the average of the last 3
 * full months once they count and it is more than zero, else the owner's estimate when set (more
 * than zero), else none.
 */
export function monthlyPurchases(input: {
  readonly months: Pick<PurchaseMonths, 'ready'>
  /** The value of the posted purchases dated in those months (net of returns and credit notes). */
  readonly monthsTotal: string
  /** businesses.estimated_monthly_purchases (null: not set). */
  readonly estimate: string | null
}): MonthlyPurchases {
  const average = input.months.ready ? monthlyPurchasesAverage(input.monthsTotal) : null
  if (average !== null && toDec(average).gt(0)) {
    return { source: 'last_3_months', monthly: average, average }
  }
  if (input.estimate !== null && toDec(input.estimate).gt(0)) {
    return { source: 'estimate', monthly: plain(toDec(input.estimate)) as CostAmount, average }
  }
  return { source: null, monthly: null, average }
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

/** The running costs of the business (D-116). */
export type RunningCostsPart =
  /** The Running Costs module is off: no share. */
  | { readonly state: 'off' }
  | {
      readonly state: 'on'
      /**
       * A running cost was ever entered (removed ones aside), active today or not. Without one the
       * share is "not entered yet", never 0 (D-186).
       */
      readonly entered: boolean
      /** The running costs active today, a month (monthlyTotal). */
      readonly monthlyRunningCosts: string
      /** The monthly material purchases the rate divides by (monthlyPurchases); null: neither. */
      readonly monthlyPurchases: string | null
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
  /**
   * A product or a service (default `product`). A service may use no materials: without any it
   * carries no running costs with this method (a known limit until Phase 5), while a product without
   * its recipe waits for it.
   */
  readonly type?: ProductType
  readonly materials: MaterialsPart
  readonly runningCosts: RunningCostsPart
  readonly ownerTime: OwnerTimePart
  readonly sale: SalePrice
}

/**
 * The running-cost line:
 * - `off`: the Running Costs module is off (no line);
 * - `not_entered`: no running cost was ever entered (never 0: the cost is incomplete, D-186);
 * - `none`: none is paid now (they ended, or start later): the share is 0;
 * - `no_materials`: nothing to carry them: Materials is off, or a service without materials (with
 *   this method it carries none until working time comes in Phase 5);
 * - `not_set`: neither the owner's estimate of monthly purchases nor 3 full months of purchases;
 * - `no_recipe`: a product without its recipe yet: worked out once it is in;
 * - `waiting`: its materials have no price yet;
 * - `applied`: the share is worked out.
 */
export const RUNNING_SHARE_STATES = [
  'off',
  'not_entered',
  'none',
  'no_materials',
  'not_set',
  'no_recipe',
  'waiting',
  'applied',
] as const
export type RunningShareState = (typeof RUNNING_SHARE_STATES)[number]

/**
 * The owner's time line: `team` (a business with a team: none, D-119), `none` (no minutes for this
 * product), `rate_not_set` (minutes without the hourly rate: never 0), `applied`.
 */
export type OwnerTimeState = 'team' | 'none' | 'rate_not_set' | 'applied'

/**
 * Why a product's cost is incomplete (each is a line the screen says in words):
 * - `no_recipe`: nothing entered for what it uses (Materials on, no recipe lines);
 * - `unpriced_materials`: some of its materials were never bought;
 * - `running_costs_not_entered`: Running Costs is on and no running cost was ever entered;
 * - `running_costs_not_set`: running costs to share and nothing to divide them by;
 * - `running_costs_need_materials`: running costs to share and no materials to carry them (Materials
 *   off, or a service without materials); never beside `no_recipe` for a product;
 * - `hourly_rate_not_set`: minutes for it and no hourly rate;
 * - `nothing_counted`: no part of it is counted at all.
 */
export const INCOMPLETE_REASONS = [
  'no_recipe',
  'unpriced_materials',
  'running_costs_not_entered',
  'running_costs_not_set',
  'running_costs_need_materials',
  'hourly_rate_not_set',
  'nothing_counted',
] as const
export type IncompleteReason = (typeof INCOMPLETE_REASONS)[number]

export interface ProductCost {
  /** Materials for one unit sold; null: none priced yet, too large, or Materials off. */
  readonly materials: CostAmount | null
  readonly runningCosts: {
    readonly state: RunningShareState
    /** Monthly running costs ÷ monthly purchases (0 with none); null when it cannot be worked out. */
    readonly rate: CostAmount | null
    /** materials × running ÷ purchases; '0' with no running costs; null unless `applied`/`none`. */
    readonly share: CostAmount | null
  }
  readonly ownerTime: {
    readonly state: OwnerTimeState
    readonly amount: CostAmount | null
  }
  /** Σ of the parts worked out (exact); null when none is, or when it is too large. */
  readonly total: CostAmount | null
  /** A part or the total does not fit a cost amount (numeric(28,12)): nothing is totalled. */
  readonly tooLarge: boolean
  /** Why it is incomplete, in the order of INCOMPLETE_REASONS; empty when complete. */
  readonly reasons: readonly IncompleteReason[]
  /** Every part that applies is worked out, and something is counted. */
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
  materials: MaterialsPart,
  running: RunningCostsPart,
  type: ProductType,
): ProductCost['runningCosts'] {
  if (running.state === 'off') return { state: 'off', rate: null, share: null }
  const rate =
    running.monthlyPurchases === null
      ? null
      : runningCostRate(running.monthlyRunningCosts, running.monthlyPurchases)
  if (!toDec(running.monthlyRunningCosts).gt(0)) {
    return running.entered
      ? { state: 'none', rate: '0' as CostAmount, share: '0' as CostAmount }
      : { state: 'not_entered', rate: null, share: null }
  }
  const rateOut = rate === null ? null : fitting(rate)
  const noLines = materials.state === 'off' || materials.lineCount === 0
  if (materials.state === 'off' || (noLines && type === 'service')) {
    return { state: 'no_materials', rate: rateOut, share: null }
  }
  if (running.monthlyPurchases === null || rate === null) {
    return { state: 'not_set', rate: null, share: null }
  }
  if (noLines) return { state: 'no_recipe', rate: rateOut, share: null }
  if (materials.perUnit === null) return { state: 'waiting', rate: rateOut, share: null }
  const share = runningCostShare(
    materials.perUnit,
    running.monthlyRunningCosts,
    running.monthlyPurchases,
  )
  return { state: 'applied', rate: rateOut, share }
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
  const shareOf = runningShareOf(part, input.runningCosts, input.type ?? 'product')
  const timeOf = ownerTimeOf(input.ownerTime)
  // A share or a time line that does not fit a cost amount is not given (the cost is too large).
  const shareFits = shareOf.share === null || fitting(shareOf.share) !== null
  const timeFits = timeOf.amount === null || fitting(timeOf.amount) !== null
  const runningCosts = shareFits ? shareOf : { ...shareOf, share: null }
  const ownerTime = timeFits ? timeOf : { ...timeOf, amount: null }

  const reasons = new Set<IncompleteReason>()
  if (part.state === 'on' && part.lineCount === 0) reasons.add('no_recipe')
  if (part.state === 'on' && part.unpricedLines > 0) reasons.add('unpriced_materials')
  if (runningCosts.state === 'not_entered') reasons.add('running_costs_not_entered')
  if (runningCosts.state === 'not_set') reasons.add('running_costs_not_set')
  if (runningCosts.state === 'no_materials') reasons.add('running_costs_need_materials')
  if (ownerTime.state === 'rate_not_set') reasons.add('hourly_rate_not_set')

  // What is counted: a share of 0 (no running costs) adds nothing and counts nothing by itself.
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
  if (total === null && !tooLarge && reasons.size === 0) reasons.add('nothing_counted')

  const beforeVat = priceBeforeVat(sale)
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
    tooLarge,
    reasons: ordered,
    complete: ordered.length === 0 && !tooLarge,
    priceBeforeVat: beforeVat,
    margin,
    marginPercent,
  }
}
