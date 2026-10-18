'use client'

import { compareDecimal, subtractDecimals } from '@bizcost/domain'
import { useTranslation } from 'react-i18next'
import { useFormatQuantity } from '@/features/catalog/unit-parts'
import { cn } from '@/lib/utils'
import type { QuotationTotalsValues } from './totals'

// A quotation's totals (M3 Step 7; D-220, D-221), as its PDF prints them: what the lines add up to
// and, when something comes off it, the discount and the "Round the total" adjustment, in one basis
// with the total before VAT (before VAT when a price includes VAT, D-296), so the rows add up;
// for a VAT-registered business the total before VAT and the VAT of each rate; the total; and when
// no VAT rate could reach the total wanted, the rounding difference and the amount to pay.

const zero = (value: string) => compareDecimal(value, '0') === 0

export function QuotationTotals({
  values,
  vatRegistered,
  money,
}: {
  values: QuotationTotalsValues
  vatRegistered: boolean
  money: (amount: string) => string
}) {
  const { t } = useTranslation()
  const quantity = useFormatQuantity()
  const rows: { key: string; label: string; value: string; strong?: boolean }[] = []
  const hasDiscount = !zero(values.discount)
  const hasAdjustment = !zero(values.adjustment)
  const hasDifference = !zero(values.difference)
  if (hasDiscount || hasAdjustment) {
    rows.push({ key: 'lines', label: t('documents.quotations.totals.lines'), value: values.lines })
  }
  if (hasDiscount) {
    rows.push({
      key: 'discount',
      label: t('documents.quotations.totals.discount'),
      value: subtractDecimals('0', values.discount),
    })
  }
  if (hasAdjustment) {
    rows.push({
      key: 'adjustment',
      label: t('documents.quotations.totals.adjustment'),
      value: values.adjustment,
    })
  }
  if (vatRegistered) {
    rows.push({ key: 'net', label: t('documents.quotations.totals.net'), value: values.net })
    for (const rate of values.rates) {
      const taxable = money(rate.net)
      rows.push({
        key: `vat-${rate.vatCategory ?? 'none'}-${rate.vatRate ?? ''}`,
        label:
          rate.vatCategory === 'exempt'
            ? t('documents.quotations.totals.exempt', { taxable })
            : rate.vatCategory === 'zero_rated'
              ? t('documents.quotations.totals.zeroRated', { taxable })
              : t('documents.quotations.totals.vat', {
                  rate: quantity(rate.vatRate ?? '0'),
                  taxable,
                }),
        value: rate.vat,
      })
    }
  }
  rows.push({
    key: 'total',
    label: t('documents.quotations.totals.total'),
    value: values.total,
    strong: !hasDifference,
  })
  if (hasDifference) {
    rows.push({
      key: 'difference',
      label: t('documents.quotations.totals.difference'),
      value: values.difference,
    })
    rows.push({
      key: 'payable',
      label: t('documents.quotations.totals.payable'),
      value: values.payable,
      strong: true,
    })
  }
  return (
    <dl className="space-y-1.5 text-sm">
      {rows.map((row) => (
        <div
          key={row.key}
          data-total={row.key}
          className={cn(
            'flex items-baseline justify-between gap-4',
            row.strong && 'border-t pt-2 text-base font-semibold',
          )}
        >
          <dt className={row.strong ? undefined : 'min-w-0 text-muted-foreground'}>{row.label}</dt>
          <dd className="shrink-0 tabular-nums">
            <bdi>{money(row.value)}</bdi>
          </dd>
        </div>
      ))}
    </dl>
  )
}
