import { dayNumber } from '../costing/cost-share'
import { exactProduct, plain, roundHalfUp, toDec } from '../numbers/decimal'
import { COST_SCALE, type CostAmount, type Percent, type Quantity } from '../numbers/kinds'

// Usage between two counts of one material in one branch (M4 Step 1; PRODUCT.md §13; the owner's
// answers Q6, Q9 and Q10 of D-339). Quantities are base units.
// - Actual usage = the stock at the earlier count + what came in (purchases less what went back to
//   suppliers, transfers in less transfers out, items made) − the stock at the later count.
// - Expected usage = what its sales took by their recipes (net of refunds that came back to stock),
//   what production took and what was taken out for work.
// - Waste = what was recorded as waste in the period + what was explained at the later count.
// - Unexplained usage = actual − expected − waste: below zero when less was used than expected.
// Its value is the later count's difference value (with the offsets of entries posted after it,
// D-339 Q5) less what the reasons explained, so it agrees with what real profit takes off on the
// count's day (Q9). The headline compares actual with expected ("18% more than expected"); the
// tolerance flags the usage nobody explained: |unexplained| more than tolerance % of expected (any
// unexplained usage is flagged when nothing was expected). Impact: the period's daily rate × 7 for a
// week and × 365 for a yearly estimate, each one product divided once and rounded once to 12
// decimals. Nothing here is rounded to the currency. When reasons given at the count explain more
// than is now missing (an entry posted late, Q5, made the loss smaller), the period asks for its
// reasons to be looked at again (reviewReasons); it never changes them by itself.

export interface UsagePeriodInput {
  /** The earlier count's day (YYYY-MM-DD). */
  readonly from: string
  /** The later count's day, after `from`. */
  readonly to: string
  /** The stock the earlier count found. */
  readonly opening: Quantity
  /** The stock the later count found. */
  readonly closing: Quantity
  /** What came in, signed: purchases − supplier returns + transfers in − transfers out + made. */
  readonly inflow: Quantity
  /** Sales by recipe (net of refunds back to stock), production and work. */
  readonly expected: Quantity
  readonly expectedValue: CostAmount
  /** Waste recorded as it happened. */
  readonly recordedWaste: Quantity
  readonly recordedWasteValue: CostAmount
  /** Explained by reasons at the later count. */
  readonly explained: Quantity
  readonly explainedValue: CostAmount
  /** The later count's difference value, offsets of late entries included (a loss is below zero). */
  readonly differenceValue: CostAmount
  /** The tolerance in % (the material's, else the business's). */
  readonly tolerance: Percent
}

export interface Impact {
  /** For the period. */
  readonly period: CostAmount
  /** ÷ days × 7. */
  readonly perWeek: CostAmount
  /** ÷ days × 365: a yearly estimate. */
  readonly perYear: CostAmount
}

export interface UsagePeriod {
  readonly days: number
  readonly actual: Quantity
  readonly expected: Quantity
  /** Recorded + explained at the count. */
  readonly waste: Quantity
  /** actual − expected − waste (below zero: less than expected). */
  readonly unexplained: Quantity
  /** (actual − expected) ÷ expected × 100, to 2 decimals; null when nothing was expected. */
  readonly overExpected: string | null
  readonly withinTolerance: boolean
  /** Reasons were given at the count and now explain more than is missing (unexplained below zero). */
  readonly reviewReasons: boolean
  readonly wasteValue: Impact
  readonly unexplainedValue: Impact
}

function impact(value: string, days: number): Impact {
  const v = toDec(value)
  const at = (times: number) =>
    plain(
      roundHalfUp(exactProduct([v, toDec(String(times))]).dividedBy(days), COST_SCALE),
    ) as CostAmount
  return { period: plain(v) as CostAmount, perWeek: at(7), perYear: at(365) }
}

/** The usage of one period between two counts; see the rules at the top. */
export function usagePeriod(input: UsagePeriodInput): UsagePeriod {
  const days = dayNumber(input.to) - dayNumber(input.from)
  if (days <= 0) throw new RangeError(`A period ends after it starts: ${input.from} → ${input.to}`)
  const actual = toDec(input.opening).plus(toDec(input.inflow)).minus(toDec(input.closing))
  const expected = toDec(input.expected)
  const waste = toDec(input.recordedWaste).plus(toDec(input.explained))
  const unexplained = actual.minus(expected).minus(waste)
  const tolerance = toDec(input.tolerance)
  if (tolerance.lt(0))
    throw new RangeError(`A tolerance must not be negative: "${input.tolerance}"`)
  const withinTolerance = expected.gt(0)
    ? !unexplained.abs().gt(exactProduct([expected, tolerance]).dividedBy(100))
    : unexplained.isZero()
  const overExpected = expected.gt(0)
    ? plain(roundHalfUp(actual.minus(expected).times(100).dividedBy(expected), 2))
    : null
  const wasteValue = toDec(input.recordedWasteValue).plus(toDec(input.explainedValue))
  const unexplainedValue = toDec(input.differenceValue).negated().minus(toDec(input.explainedValue))
  return {
    days,
    actual: plain(actual) as Quantity,
    expected: plain(expected) as Quantity,
    waste: plain(waste) as Quantity,
    unexplained: plain(unexplained) as Quantity,
    overExpected,
    withinTolerance,
    reviewReasons: toDec(input.explained).gt(0) && unexplained.lt(0),
    wasteValue: impact(plain(wasteValue), days),
    unexplainedValue: impact(plain(unexplainedValue), days),
  }
}
