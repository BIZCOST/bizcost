'use client'

import type { MonthCostCategoryDto, MonthCostsDto } from '@bizcost/contracts'
import { useTranslation } from 'react-i18next'
import { NBSP } from '@/features/catalog/units'
import { useBusinessMonth, useMoney } from '@/features/purchasing/amounts'

// The business's costs of the last full calendar month (D-202, D-203), in "How your costs are worked
// out": what running costs will be shared over what it sold that month once sales are recorded. The
// total, then each category with where its amount comes from: its bills of the month (in place of its
// regular amount, never both), a quarter's or a year's bills spread over its months, its running
// costs' regular amount, and what a reversal of an earlier month's bill takes back in it. For a
// VAT-registered business it says the amounts are before the VAT it gets back. The API withholds the
// amounts from a member who may not see running costs and expenses (`amountsShown: false`): then
// only that is said.

/** An amount that never breaks inside ("AED 12,000.00"). */
function Amount({ value, className }: { value: string; className?: string }) {
  const money = useMoney()
  return <bdi className={className}>{money(value).replaceAll(' ', NBSP)}</bdi>
}

/** Where a category's amount comes from, in words. */
function useSourceWords() {
  const { t } = useTranslation()
  const money = useMoney()
  const monthName = useBusinessMonth()
  const amount = (value: string) => money(value).replaceAll(' ', NBSP)
  const month = (value: string) => monthName(value).replaceAll(' ', NBSP)
  return (category: MonthCostCategoryDto): string => {
    const { period, regular } = category
    if (category.source === 'regular') return t('costing.pool.regular')
    if (category.source === 'taken_back') return t('costing.pool.takenBackOnly')
    if (period) {
      const kind = period.months === 3 ? 'quarter' : 'year'
      const values = { from: month(period.from), to: month(period.to), bills: amount(period.bills) }
      return regular === null
        ? t(`costing.pool.period.${kind}`, values)
        : t(`costing.pool.period.${kind}Instead`, { ...values, regular: amount(regular) })
    }
    return regular === null
      ? t('costing.pool.bills')
      : t('costing.pool.billsInstead', { regular: amount(regular) })
  }
}

/**
 * The month's costs by category (none when off, or hidden with costs). `materialsOn`: the Materials
 * module is on (then it says material purchases are each item's own line, not here).
 * `vatRegistered`: the amounts are said to be before the VAT the business gets back.
 */
export function MonthCosts({
  costs,
  materialsOn,
  vatRegistered,
}: {
  costs: MonthCostsDto
  materialsOn: boolean
  vatRegistered: boolean
}) {
  const { t } = useTranslation()
  const money = useMoney()
  const monthName = useBusinessMonth()
  const source = useSourceWords()
  if (costs.state === undefined || costs.state === 'off') return null
  // The month and its year stay together («سبتمبر 2026»).
  const month = monthName(costs.month).replaceAll(' ', NBSP)
  if (!costs.amountsShown || typeof costs.total !== 'string' || !Array.isArray(costs.categories)) {
    return (
      <p data-month-hidden className="text-muted-foreground">
        {t('costing.pool.hidden', { month })}
      </p>
    )
  }
  if (costs.categories.length === 0) {
    return (
      <p data-month-none className="text-muted-foreground">
        {t('costing.pool.none', { month })}
      </p>
    )
  }
  const notes = [
    t('costing.pool.note'),
    materialsOn ? t('costing.pool.noPurchases') : null,
    vatRegistered ? t('costing.pool.vat') : null,
  ].filter(Boolean)
  return (
    <div data-month-costs className="space-y-2">
      <div>
        <p className="flex items-baseline justify-between gap-3 font-medium">
          <span className="min-w-0">{t('costing.pool.title', { month })}</span>
          <Amount
            value={costs.total}
            className="shrink-0 font-semibold whitespace-nowrap tabular-nums"
          />
        </p>
        <p data-month-shared className="text-muted-foreground">
          {t('costing.pool.shared', { month })}
        </p>
      </div>
      <ul className="divide-y divide-foreground/[0.06] border-y border-foreground/[0.06]">
        {costs.categories.map((category) => (
          <li
            key={category.categoryId}
            data-month-category={category.name}
            data-source={category.source}
            className="flex items-baseline justify-between gap-3 py-1.5"
          >
            <span className="min-w-0">
              <span dir="auto" className="break-words">
                {category.name}
              </span>
              <span className="block text-xs text-muted-foreground">{source(category)}</span>
              {category.takenBack !== null && category.source !== 'taken_back' ? (
                <span data-taken-back className="block text-xs text-muted-foreground">
                  {t('costing.pool.takenBack', {
                    amount: money(category.takenBack).replaceAll(' ', NBSP),
                  })}
                </span>
              ) : null}
            </span>
            <Amount value={category.amount} className="shrink-0 whitespace-nowrap tabular-nums" />
          </li>
        ))}
      </ul>
      <p data-month-note className="text-xs text-muted-foreground">
        {notes.join(' ')}
      </p>
    </div>
  )
}
