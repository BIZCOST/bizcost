import type { ProfitPartsDto } from '@bizcost/contracts'
import { compareDecimal, costRatio } from '@bizcost/domain'

// How Reports → Real profit lays out its figures (M3 Step 3): which parts of real profit a business
// has (no column or line for what it never has: app fees without a delivery app, delivery without
// deliveries, the owner's time with a team), and each part as a share of the sales. Pure, so the
// screens and their tests agree.

/** The parts of real profit between the sales and the profit, in the order they are taken off. */
export const COST_PARTS = ['materials', 'fees', 'delivery', 'running', 'time'] as const
export type CostPart = (typeof COST_PARTS)[number]

/** A part's amount in some figures (null: withheld or not known). */
export function partAmount(
  sum: Pick<ProfitPartsDto, 'materials' | 'fees' | 'deliveryCost' | 'runningCosts' | 'ownerTime'>,
  part: CostPart,
): string | null {
  const value =
    part === 'materials'
      ? sum.materials
      : part === 'fees'
        ? sum.fees
        : part === 'delivery'
          ? sum.deliveryCost
          : part === 'running'
            ? sum.runningCosts
            : sum.ownerTime
  return typeof value === 'string' ? value : null
}

/** The reasons that say a part is there though nothing is counted in it yet. */
const PART_REASONS: Readonly<Record<CostPart, readonly string[]>> = {
  materials: ['no_recipe', 'unpriced_materials'],
  fees: ['fees_not_entered'],
  delivery: ['delivery_cost_not_entered'],
  running: [],
  time: ['hourly_rate_not_set'],
}

const nonZero = (value: string | null | undefined) =>
  typeof value === 'string' && compareDecimal(value, '0') !== 0

/**
 * The parts some figures have: a part with an amount other than 0 in any of them, or a reason that
 * it is missing; delivery also when something was charged for it; running costs whenever they are
 * counted (`runningCounted`), even at 0; the owner's time only without a team (`ownerTime`).
 */
export function partsShown(
  sums: readonly Pick<
    ProfitPartsDto,
    | 'materials'
    | 'fees'
    | 'deliveryCost'
    | 'deliveryCharged'
    | 'runningCosts'
    | 'ownerTime'
    | 'reasons'
  >[],
  { runningCounted, ownerTime }: { runningCounted: boolean; ownerTime: boolean },
): CostPart[] {
  return COST_PARTS.filter((part) => {
    if (part === 'time' && !ownerTime) return false
    if (part === 'running' && runningCounted) return true
    return sums.some(
      (sum) =>
        nonZero(partAmount(sum, part)) ||
        (part === 'delivery' && nonZero(sum.deliveryCharged)) ||
        (sum.reasons ?? []).some((reason) => PART_REASONS[part].includes(reason)),
    )
  })
}

/** `amount` as a percentage of `sales` (12 decimals), or null when nothing was sold. */
export function percentOfSales(amount: string | null, sales: string): string | null {
  if (amount === null) return null
  return costRatio([amount, '100'], [sales])
}

/** Whether an amount reads as a loss (below 0). */
export function isLoss(value: string | null | undefined): boolean {
  return typeof value === 'string' && compareDecimal(value, '0') < 0
}

/** An amount without its minus (a loss is said as a loss, with its own word). */
export function withoutMinus(value: string): string {
  return value.replace(/^-/, '')
}

/**
 * How "N% of sales have complete costs" is said (D-250): rounded to a whole percent, but never 100%
 * while something is missing ("More than 99%") nor 0% while some sales are complete ("Less than 1%").
 */
export function completenessShare(
  percent: string,
  complete: boolean,
): { words: 'percent' | 'percentAlmost' | 'percentLittle'; percent: string } {
  if (!complete && compareDecimal(percent, '99.5') >= 0) {
    return { words: 'percentAlmost', percent: '99' }
  }
  if (compareDecimal(percent, '0') > 0 && compareDecimal(percent, '0.5') < 0) {
    return { words: 'percentLittle', percent: '1' }
  }
  return { words: 'percent', percent }
}
