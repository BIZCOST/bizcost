import type Decimal from 'decimal.js'
import { Dec, exactProduct, fixed, roundHalfUp, toDec } from '../numbers/decimal'
import type { Money, Percent } from '../numbers/kinds'
import { currencyMinorUnit, type CurrencyCode } from '../numbers/rounding'

// What a document has billed and has left, and how a total is shared between payment stages (M3 Step
// 7; the owner's answer Q22 = A of D-218, and his request of 2026-10-16 for a quotation's payment
// terms). Pure decimal maths on the document's amounts, decimal.js only:
//
//   - **Billing** (`billingState`, `billPart`): an accepted quotation or an order is billed in parts
//     (Step 8's stage and deposit invoices), each a % of the total or an amount, never above what is
//     left (so never above 100 %), and the last bills exactly the rest. A % part is the total × % ÷
//     100 rounded once, half away from zero, to the currency's minor unit; a part that comes to all
//     that is left is the last one.
//   - **Payment stages** (`paymentStageAmounts`): a quotation's schedule ("Upon signing 50 %, upon
//     delivery 35 %, after handover 15 %") shares its payable total: the stages' % add up to exactly
//     100; each stage but the last is the total × its % rounded once, half away from zero (what a
//     calculator shows), and the last takes exactly the rest, so the amounts add up to the total
//     (16,100.00 at 50/35/15: 8,050.00, 5,635.00, 2,415.00; 100.00 in thirds: 33.33, 33.33, 33.34).
//     Only when those roundings would pass the total (a total of a few fils over many stages) is each
//     stage the rounded running total less the one before it, so no stage is ever below zero.
//
// Totals here are of positive documents (a quotation, an order); a credit is never billed in parts.

/** How much of a document one bill takes: a % of its total, an amount, or all that is left. */
export type BillingPart =
  { readonly percent: Percent } | { readonly amount: Money } | { readonly rest: true }

export interface BillingState {
  readonly total: Money
  /** Σ of what was billed so far. */
  readonly billed: Money
  /** total − billed (zero once everything is billed). */
  readonly left: Money
  /**
   * billed × 100 ÷ total, to 2 decimals towards zero: "100.00" only once nothing is left, and at least
   * "0.01" once anything is billed (D-296); "100.00" for a total of zero.
   */
  readonly billedPercent: string
  /** Nothing is left to bill. */
  readonly done: boolean
}

/** Why a bill is refused (a form message). */
export type BillingErrorCode =
  'nothing_left' | 'not_positive' | 'over_100_percent' | 'over_left' | 'too_many_decimals'

export interface BillPlan {
  /** What this bill takes, with the currency's minor-unit digits. */
  readonly amount: Money
  /** It takes all that was left: the last bill. */
  readonly last: boolean
  /** The state once it is billed. */
  readonly after: BillingState
}

const ZERO = '0'

function amountOf(value: string, digits: number, what: string): Decimal {
  const amount = toDec(value)
  if (amount.lt(0)) throw new RangeError(`${what} must not be negative: "${value}"`)
  if (amount.decimalPlaces() > digits) {
    throw new RangeError(`${what} has more than ${digits} decimals: "${value}"`)
  }
  return amount
}

/** billed × 100 ÷ total, never rounded up to 100 while something is left nor down to 0 once billed. */
function percentOf(total: Decimal, billed: Decimal, done: boolean): string {
  if (total.isZero() || done) return '100.00'
  const exact = billed.times(100).dividedBy(total)
  const down = exact.toDecimalPlaces(2, Dec.ROUND_DOWN)
  return fixed(down.isZero() && billed.gt(0) ? toDec('0.01') : down, 2)
}

function stateOf(total: Decimal, billed: Decimal, digits: number): BillingState {
  const left = total.minus(billed)
  const done = left.lte(0)
  return {
    total: fixed(total, digits) as Money,
    billed: fixed(billed, digits) as Money,
    left: fixed(left, digits) as Money,
    billedPercent: percentOf(total, billed, done),
    done,
  }
}

function billedSum(total: Decimal, billed: readonly string[], digits: number): Decimal {
  const sum = billed.reduce(
    (acc, value) => acc.plus(amountOf(value, digits, 'A billed amount')),
    toDec(ZERO),
  )
  if (sum.gt(total)) throw new RangeError('What was billed passes the total')
  return sum
}

/**
 * What a document of `total` has billed (`billed`: each bill's amount) and has left. Throws RangeError
 * for a negative amount, more decimals than the currency has, or bills that pass the total.
 */
export function billingState(
  total: Money,
  billed: readonly Money[],
  currency: CurrencyCode,
): BillingState {
  const digits = currencyMinorUnit(currency)
  const whole = amountOf(total, digits, 'A total')
  return stateOf(whole, billedSum(whole, billed, digits), digits)
}

function planOf(
  total: Money,
  billed: readonly Money[],
  part: BillingPart,
  currency: CurrencyCode,
): BillPlan | BillingErrorCode {
  const digits = currencyMinorUnit(currency)
  const whole = amountOf(total, digits, 'A total')
  const done = billedSum(whole, billed, digits)
  const left = whole.minus(done)
  if (left.lte(0)) return 'nothing_left'
  let amount: Decimal
  if ('rest' in part) {
    amount = left
  } else if ('percent' in part) {
    const percent = toDec(part.percent)
    if (percent.lte(0)) return 'not_positive'
    if (percent.gt(100)) return 'over_100_percent'
    amount = roundHalfUp(exactProduct([whole, percent]).dividedBy(100), digits)
    if (amount.lte(0)) return 'not_positive'
  } else {
    amount = toDec(part.amount)
    if (amount.lte(0)) return 'not_positive'
    if (amount.decimalPlaces() > digits) return 'too_many_decimals'
  }
  if (amount.gt(left)) return 'over_left'
  return {
    amount: fixed(amount, digits) as Money,
    last: amount.eq(left),
    after: stateOf(whole, done.plus(amount), digits),
  }
}

/** The first problem with billing `part` of the document, or null (see billPart). */
export function billingError(
  total: Money,
  billed: readonly Money[],
  part: BillingPart,
  currency: CurrencyCode,
): BillingErrorCode | null {
  const plan = planOf(total, billed, part, currency)
  return typeof plan === 'string' ? plan : null
}

/**
 * The next bill of a document of `total` that has billed `billed`: `part` of it (a % of the total, an
 * amount, or the rest), never more than is left. Throws RangeError when billingError finds a problem.
 */
export function billPart(
  total: Money,
  billed: readonly Money[],
  part: BillingPart,
  currency: CurrencyCode,
): BillPlan {
  const plan = planOf(total, billed, part, currency)
  if (typeof plan === 'string') throw new RangeError(`Cannot bill: ${plan}`)
  return plan
}

// ---------------------------------------------------------------------------------------------------
// Payment stages
// ---------------------------------------------------------------------------------------------------

/** Most stages a quotation's payment terms list. */
export const PAYMENT_STAGES_MAX = 10

/** Most decimals a stage's % may have (33.3333). */
export const PAYMENT_STAGE_PERCENT_DECIMALS = 4

export type PaymentStagesErrorCode =
  'too_many_stages' | 'not_positive' | 'over_100_percent' | 'too_many_decimals' | 'not_100_percent'

/** The first problem with a schedule of stages (each a %), or null. No stage at all is fine. */
export function paymentStagesError(
  percents: readonly Percent[],
): { readonly code: PaymentStagesErrorCode; readonly stage?: number } | null {
  if (percents.length > PAYMENT_STAGES_MAX) return { code: 'too_many_stages' }
  let sum = toDec(ZERO)
  for (const [stage, value] of percents.entries()) {
    const percent = toDec(value)
    if (percent.lte(0)) return { code: 'not_positive', stage }
    if (percent.gt(100)) return { code: 'over_100_percent', stage }
    if (percent.decimalPlaces() > PAYMENT_STAGE_PERCENT_DECIMALS) {
      return { code: 'too_many_decimals', stage }
    }
    sum = sum.plus(percent)
  }
  if (percents.length > 0 && !sum.eq(100)) return { code: 'not_100_percent' }
  return null
}

/**
 * Each stage's amount of `total` (the document's payable total), in the stages' order: each but the
 * last rounded on its own, the last exactly the rest (see above), never below zero. Throws RangeError when paymentStagesError finds a problem, for a
 * negative total or one with more decimals than the currency has.
 */
export function paymentStageAmounts(
  total: Money,
  percents: readonly Percent[],
  currency: CurrencyCode,
): Money[] {
  const error = paymentStagesError(percents)
  if (error) throw new RangeError(`Invalid payment stages: ${error.code}`)
  const digits = currencyMinorUnit(currency)
  const whole = amountOf(total, digits, 'A total')
  if (percents.length === 0) return []
  const share = (percent: Decimal) =>
    roundHalfUp(exactProduct([whole, percent]).dividedBy(100), digits)
  // Each stage but the last as a calculator gives it, the last the exact rest.
  const firsts = percents.slice(0, -1).map((value) => share(toDec(value)))
  const rest = firsts.reduce((acc, value) => acc.minus(value), whole)
  if (rest.gte(0)) {
    return [...firsts, rest].map((value) => fixed(value, digits) as Money)
  }
  // A total of a few fils over many stages: their roundings would pass it. Then each stage is the
  // rounded running total less the one before it (never below zero, each within one minor unit).
  const amounts: Money[] = []
  let running = toDec(ZERO)
  let before = toDec(ZERO)
  for (const [i, value] of percents.entries()) {
    running = running.plus(toDec(value))
    const upTo = i === percents.length - 1 ? whole : share(running)
    amounts.push(fixed(upTo.minus(before), digits) as Money)
    before = upTo
  }
  return amounts
}
