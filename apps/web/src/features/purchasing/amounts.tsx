'use client'

import type { SensitivityCategory } from '@bizcost/domain'
import { formatCurrency, formatDate, formatUnitCost } from '@bizcost/i18n'
import { LockKeyholeIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLocale } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'

// Amounts on the purchasing screens (M2 Step 3): money in the document's or the business's currency,
// costs per unit with enough digits to read (AED 0.0067 per ml), business days, and the lock that
// takes the place of a value the server removed for this member (redaction, D-026: a hidden field is
// absent, never 0).

/** A document amount in `currency` (the business's by default): "AED 1,250.00". */
export function useMoney() {
  const { locale } = useLocale()
  const { data: context } = useBusinessContext()
  return (amount: string, currency?: string) =>
    formatCurrency(locale, amount, currency ?? context?.currency ?? 'AED')
}

/** A cost or price per unit: "AED 6.67", "AED 0.0067". */
export function useUnitCost() {
  const { locale } = useLocale()
  const { data: context } = useBusinessContext()
  return (amount: string, currency?: string) =>
    formatUnitCost(locale, amount, currency ?? context?.currency ?? 'AED')
}

/** A business day (YYYY-MM-DD) as the page's language writes it: "28 Sep 2026". */
export function useBusinessDate() {
  const { locale } = useLocale()
  return (day: string) =>
    formatDate(locale, `${day}T00:00:00Z`, { dateStyle: 'medium', timeZone: 'UTC' })
}

/**
 * In place of a value this member may not see: a lock and "Hidden", with the reason for screen
 * readers and on hover.
 */
export function Locked({
  category,
  className,
}: {
  category: Extract<SensitivityCategory, 'cost' | 'supplier_price' | 'profit_margin'>
  className?: string
}) {
  const { t } = useTranslation()
  return (
    <span
      data-locked={category}
      title={t(`common.locked.${category}`)}
      className={cn(
        'inline-flex items-center gap-1 align-middle font-normal whitespace-nowrap text-muted-foreground',
        className,
      )}
    >
      <LockKeyholeIcon aria-hidden className="size-3.5 shrink-0" />
      <span>{t('common.locked.label')}</span>
      <span className="sr-only">{t(`common.locked.${category}`)}</span>
    </span>
  )
}

/** A document amount, or the lock when the server removed it. */
export function Money({
  value,
  currency,
  category = 'supplier_price',
  className,
}: {
  value: string | null | undefined
  currency?: string
  category?: 'cost' | 'supplier_price'
  className?: string
}) {
  const money = useMoney()
  if (value === undefined) return <Locked category={category} className={className} />
  if (value === null) return null
  return <bdi className={cn('tabular-nums', className)}>{money(value, currency)}</bdi>
}
