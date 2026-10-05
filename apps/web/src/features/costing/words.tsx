'use client'

import type { MonthCostsDto } from '@bizcost/contracts'
import {
  costRate,
  costShare,
  hoursAndMinutes,
  type IncompleteReason,
  type ProductType,
  type TerminologyProfile,
} from '@bizcost/domain'
import {
  formatDecimal,
  formatList,
  formatPercent,
  formatWholeCurrency,
  type I18nKey,
} from '@bizcost/i18n'
import { useTranslation } from 'react-i18next'
import { useUnitQuantity } from '@/features/catalog/unit-parts'
import { useMoney, useUnitCost } from '@/features/documents/amounts'
import { useLocale, useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'

// How the product-cost screens say their numbers in words (M2 Step 6; D-119, D-186, D-202): how
// running costs reach what the business sells (by its price, worked out once sales are recorded,
// with the owner's example), the owner's hourly rate and time, and why a cost is incomplete. Amounts
// are rounded only here (the API keeps 12 decimals); totals quoted in a sentence are whole.

/** A percentage: margins with one decimal ("75.0%"), a rate as a fraction ({ ratio: true }). */
export function usePercent() {
  const { locale } = useLocale()
  return (value: string, options?: Parameters<typeof formatPercent>[2]) =>
    formatPercent(locale, value, options)
}

/** A round figure in the business currency ("AED 15,000"), for totals said in a sentence. */
export function useWholeMoney() {
  const { locale } = useLocale()
  const { data: context } = useBusinessContext()
  return (amount: string) => formatWholeCurrency(locale, amount, context?.currency ?? 'AED')
}

/**
 * The owner's example of the rule (D-202): costs of 20,000 and sales of 80,000 make 25%, so an item
 * priced 400 carries 100 and one priced 18 carries 4.50. Worked out by the domain's own rule.
 */
const RULE_EXAMPLE = { costs: '20000', sales: '80000', price: '400', small: '18' } as const

/**
 * The rule's example in words, in the business currency: the month's totals whole, the division
 * that gives the percentage, and both prices and what they carry alike (with the currency's decimals).
 */
export function useRuleExample() {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const whole = useWholeMoney()
  const money = useMoney()
  const percent = usePercent()
  return (): string => {
    const { costs, sales, price, small } = RULE_EXAMPLE
    const rate = costRate({ state: 'on', costs, sales }).rate ?? '0'
    return t('costing.rate.example', {
      costs: whole(costs),
      sales: whole(sales),
      costsNumber: formatDecimal(locale, costs, 0),
      salesNumber: formatDecimal(locale, sales, 0),
      percent: percent(rate, { ratio: true, minDigits: 0 }),
      price: money(price),
      share: money(costShare(price, costs, sales) ?? '0'),
      small: money(small),
      smallShare: money(costShare(small, costs, sales) ?? '0'),
    })
  }
}

/** How running costs reach what the business sells, in words, and what it asks the reader to do. */
export interface RateWords {
  /** The rule (one sentence). */
  readonly rule: string
  /** The owner's example of it. */
  readonly example: string
  /** Worked out once sales are recorded, and what the costs shown are until then (none once shared). */
  readonly awaiting: string | null
  /** No running cost was ever entered: they are what will be shared, so the page asks for them. */
  readonly nudge: string | null
  /** The rule in a few words, for a phone's folded panel. */
  readonly short: string
  /** Something is missing for it: said in the warning tone, with the way to add it. */
  readonly action: 'runningCosts' | null
}

/**
 * How running costs reach what the business sells (D-202): by its price, worked out once sales are
 * recorded. None when neither Running Costs nor Expenses is on, or the member may not see costs.
 * `runningCostsOn`: the Running Costs module is on (only then are running costs asked for; never
 * entered is not a product's reason, D-202).
 */
export function useRateWords() {
  const { t } = useTranslation()
  const example = useRuleExample()
  return (costs: MonthCostsDto | undefined, runningCostsOn: boolean): RateWords | null => {
    if (!costs || costs.state === undefined || costs.state === 'off') return null
    const missing = runningCostsOn && costs.runningCostsEntered === false
    return {
      rule: t('costing.rate.byPrice'),
      example: example(),
      awaiting: costs.state === 'awaiting_sales' ? t('costing.rate.awaiting') : null,
      nudge: missing ? t('costing.rate.not_entered') : null,
      short: t('costing.rate.short'),
      action: missing ? 'runningCosts' : null,
    }
  }
}

/** The owner's hourly rate in a sentence ("Your time: AED 45.00 an hour."); none when hidden. */
export function useHourlyRateSentence() {
  const { t } = useTranslation()
  const unitCost = useUnitCost()
  return (hourlyRate: string | null | undefined): string | null => {
    if (hourlyRate === undefined) return null
    return hourlyRate === null
      ? t('costing.time.rateNotSet')
      : t('costing.time.rate', { amount: unitCost(hourlyRate) })
  }
}

/** A time in words: minutes under an hour, else hours and minutes ("10 hours", "1 hour and 15 minutes"). */
export function useDuration() {
  const { locale } = useLocale()
  const unitQuantity = useUnitQuantity()
  return (minutes: string): string => {
    const split = hoursAndMinutes(minutes)
    if (split.hours === '0') return unitQuantity(minutes, 'min')
    const parts = [unitQuantity(split.hours, 'h')]
    if (split.minutes !== '0') parts.push(unitQuantity(split.minutes, 'min'))
    return formatList(locale, parts)
  }
}

/** Why a cost is incomplete: a few words each (the list), or a sentence (the breakdown). */
export function useReasonWords() {
  const term = useTerminology()
  // A service may use no materials: its recipe is asked for as optional.
  const optional = (reason: IncompleteReason, type: ProductType) =>
    reason === 'no_recipe' && type === 'service'
  return {
    short: (reason: IncompleteReason, profile: TerminologyProfile, type: ProductType) =>
      optional(reason, type)
        ? term('costing.reasons.short.no_recipe_service', profile)
        : reason === 'no_recipe'
          ? term('catalog.products.cost.noRecipe', profile)
          : term(`costing.reasons.short.${reason}` as I18nKey, profile),
    long: (reason: IncompleteReason, profile: TerminologyProfile, type: ProductType) =>
      optional(reason, type)
        ? term('costing.reasons.long.no_recipe_service', profile)
        : term(`costing.reasons.long.${reason}` as I18nKey, profile),
  }
}
