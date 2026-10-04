'use client'

import type { MonthCostCategoryDto, MonthCostLineDto, MonthCostsDto } from '@bizcost/contracts'
import { useTranslation } from 'react-i18next'
import { NBSP } from '@/features/catalog/units'
import { useBusinessMonth, useMoney } from '@/features/purchasing/amounts'
import { cn } from '@/lib/utils'

// The business's costs of the last full calendar month (D-202, D-203, D-216), in "How your costs are
// worked out": what running costs will be shared over what it sold that month once sales are recorded.
// The total, then each category, the largest first, with what is inside it: each of its running costs
// with where its amount comes from (its own bills in place of its regular amount, never both; a
// quarter's or a year's bills spread over its months; its regular amount; what a reversal of an
// earlier month's bill takes back in it), and the extra expenses that count on top ("Salaries: Staff
// salaries, its regular amount 16,000; extra expenses 300"). A category with one line says only where
// its amount comes from (its running cost's name too, unless it is the category's own). For a
// VAT-registered business it says the amounts are before the VAT it gets back. The API withholds the
// amounts from a member who may not see running costs and expenses (`amountsShown: false`): then
// only that is said.

/** An amount that never breaks inside ("AED 12,000.00"). */
function Amount({ value, className }: { value: string; className?: string }) {
  const money = useMoney()
  return <bdi className={className}>{money(value).replaceAll(' ', NBSP)}</bdi>
}

/** Where a line's amount comes from, in words. */
function useSourceWords() {
  const { t } = useTranslation()
  const money = useMoney()
  const monthName = useBusinessMonth()
  const amount = (value: string) => money(value).replaceAll(' ', NBSP)
  const month = (value: string) => monthName(value).replaceAll(' ', NBSP)
  /** `beside`: the category also has running costs (its extras count on top of them). */
  return (line: MonthCostLineDto, beside: boolean): string => {
    const { period, regular } = line
    if (line.kind === 'extra') {
      if (line.source === 'taken_back') return t('costing.pool.takenBackOnly')
      return beside ? t('costing.pool.extra') : t('costing.pool.bills')
    }
    if (line.source === 'regular') return t('costing.pool.regular')
    if (line.source === 'taken_back') return t('costing.pool.takenBackOnly')
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

/** The same name, however it is spaced or cased ("Electricity" and "electricity "). */
function sameName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()
}

/** One category of the month: its name and amount, then what is inside it. */
function Category({ category }: { category: MonthCostCategoryDto }) {
  const { t } = useTranslation()
  const money = useMoney()
  const source = useSourceWords()
  const several = category.lines.length > 1
  const beside = category.lines.some((line) => line.kind === 'running_cost')
  return (
    <li data-month-category={category.name} className="py-1.5">
      <p className="flex items-baseline justify-between gap-3">
        <span dir="auto" className="min-w-0 break-words">
          {category.name}
        </span>
        <Amount value={category.amount} className="shrink-0 whitespace-nowrap tabular-nums" />
      </p>
      <ul className={cn(several && 'mt-1 space-y-1')}>
        {category.lines.map((line) => {
          // A running cost's name, unless it is the category's only line and has its name.
          const named = line.name !== null && (several || !sameName(line.name, category.name))
          return (
            <li
              key={line.runningCostId ?? 'extra'}
              data-month-line={line.name ?? line.kind}
              data-source={line.source}
              className={cn(
                'flex items-baseline justify-between gap-3 text-xs text-muted-foreground',
                several && 'border-s-2 border-foreground/10 ps-2',
              )}
            >
              <span className="min-w-0">
                {named ? (
                  // On the page's side whatever its script: only the name itself is isolated.
                  <span className="block break-words text-foreground/80">
                    <bdi>{line.name}</bdi>
                  </span>
                ) : null}
                <span className="block">{source(line, beside)}</span>
                {line.takenBack !== null && line.source !== 'taken_back' ? (
                  <span data-taken-back className="block">
                    {t('costing.pool.takenBack', {
                      amount: money(line.takenBack).replaceAll(' ', NBSP),
                    })}
                  </span>
                ) : null}
              </span>
              {several ? (
                <Amount value={line.amount} className="shrink-0 whitespace-nowrap tabular-nums" />
              ) : null}
            </li>
          )
        })}
      </ul>
    </li>
  )
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
  const monthName = useBusinessMonth()
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
          <Category key={category.categoryId} category={category} />
        ))}
      </ul>
      <p data-month-note className="text-xs text-muted-foreground">
        {notes.join(' ')}
      </p>
    </div>
  )
}
