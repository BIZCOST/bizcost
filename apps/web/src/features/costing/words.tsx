'use client'

import type { RunningCostRateDto } from '@bizcost/contracts'
import {
  hoursAndMinutes,
  type IncompleteReason,
  type ProductType,
  type TerminologyProfile,
} from '@bizcost/domain'
import { formatList, formatPercent, formatWholeCurrency, type I18nKey } from '@bizcost/i18n'
import { useTranslation } from 'react-i18next'
import { useUnitQuantity } from '@/features/catalog/unit-parts'
import { useBusinessDate, useUnitCost } from '@/features/purchasing/amounts'
import { useLocale, useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'

// How the product-cost screens say their numbers in words (M2 Step 6; D-116, D-119, D-186): how
// running costs reach products, the rule first and then why ("Every AED 1 you spend on materials adds
// AED 0.50 of running costs (50% of the materials). Why: your running costs are AED 15,000 a month
// and you buy about AED 30,000 of materials a month."), which purchases it is worked out from, the
// owner's hourly rate and time, and why a cost is incomplete. Amounts are rounded only here (the API
// keeps 12 decimals); the monthly totals in a sentence are whole.

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

/** How running costs reach what the business sells, in words, and what it asks the reader to do. */
export interface RateWords {
  /** The rule, or what stands in its way (one sentence). */
  readonly rule: string
  /** Why the rule is what it is: the monthly totals (none when withheld or not worked out). */
  readonly why: string | null
  /** The rule in a few words, for a phone's folded panel. */
  readonly short: string
  /** Something is missing for it: said in the warning tone, with the way to add it. */
  readonly action: 'estimate' | 'runningCosts' | null
}

/**
 * How running costs reach what the business sells (none when Running Costs is off or the member may
 * not see costs). `materialsOn`: the Materials module is on; without it (a business of services)
 * running costs cannot reach anything yet, and asking for purchases would not help.
 */
export function useRateWords() {
  const { t } = useTranslation()
  const whole = useWholeMoney()
  const unitCost = useUnitCost()
  const percent = usePercent()
  const businessDate = useBusinessDate()
  return (rate: RunningCostRateDto | undefined, materialsOn: boolean): RateWords | null => {
    if (!rate || rate.state === undefined || rate.state === 'off') return null
    const running =
      rate.totalsShown && rate.monthlyRunningCosts ? whole(rate.monthlyRunningCosts) : null
    const said = (rule: string, action: RateWords['action'] = null): RateWords => ({
      rule,
      why: null,
      short: rule,
      action,
    })
    if (rate.state === 'not_entered') return said(t('costing.rate.not_entered'), 'runningCosts')
    if (rate.state === 'none') return said(t('costing.rate.none'))
    if (!materialsOn) {
      return said(
        running ? t('costing.rate.noMaterials', { running }) : t('costing.rate.noMaterials_hidden'),
      )
    }
    if (rate.state === 'not_set') {
      return said(
        running ? t('costing.rate.not_set', { running }) : t('costing.rate.not_set_hidden'),
        'estimate',
      )
    }
    const { source, monthly } = rate.purchases
    const purchases = rate.totalsShown && monthly ? whole(monthly) : null
    if (!rate.rate) {
      return said(
        running && purchases
          ? t('costing.rate.tooLarge', { running, purchases })
          : t('costing.rate.tooLarge_hidden'),
      )
    }
    const share = percent(rate.rate, { ratio: true, minDigits: 0 })
    return {
      rule: t('costing.rate.rule', {
        one: whole('1'),
        rate: unitCost(rate.rate),
        percent: share,
      }),
      why:
        running && purchases && source
          ? t(`costing.rate.why.${source}`, {
              running,
              purchases,
              from: businessDate(rate.purchases.from),
              to: businessDate(rate.purchases.to),
            })
          : null,
      short: t('costing.rate.short', { percent: share }),
      action: null,
    }
  }
}

/**
 * Which monthly purchases BizCost divides by, and why (D-116, D-186): what was really bought once 3
 * full months count; otherwise the owner's estimate, until `countsFrom`, while a month of the 3 has
 * no purchase, or when what was bought comes to nothing. None when hidden or not in use.
 */
export function useEstimateNote() {
  const { t } = useTranslation()
  const businessDate = useBusinessDate()
  return (rate: RunningCostRateDto | undefined, today: string): string | null => {
    if (!rate || rate.state === undefined || rate.purchases.source === undefined) return null
    const { source, countsFrom, ready, from, to } = rate.purchases
    if (source === 'last_3_months') return t('costing.rate.fromPurchases')
    if (source !== 'estimate') return null
    const months = { from: businessDate(from), to: businessDate(to) }
    if (ready) return t('costing.rate.estimateNothingBought', months)
    if (countsFrom === null) return t('costing.rate.estimateUntilUnknown')
    if (countsFrom > today) {
      return t('costing.rate.estimateUntil', { date: businessDate(countsFrom) })
    }
    return t('costing.rate.estimateMonthsMissing', months)
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
