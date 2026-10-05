'use client'

import { compareDecimal } from '@bizcost/domain'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Locked } from './amounts'

/**
 * The totals of a document (a purchase, an expense, a sale): the subtotal and discounts when there
 * are discounts, then for a VAT-registered business always the total before VAT, the VAT and the
 * total (whether its prices were typed before VAT or with it: the owner's request of 2026-09-29), for
 * any other business the total. A value the server removed shows a lock (a purchase's amounts are
 * supplier prices; a sale's are never hidden).
 */
export function Totals({
  subtotal,
  discount,
  net,
  vat,
  total,
  vatRegistered,
  money,
}: {
  subtotal: string | undefined
  discount: string | undefined
  /** The total before VAT (after discounts). */
  net: string | undefined
  vat: string | undefined
  total: string | undefined
  vatRegistered: boolean
  money: (amount: string) => string
}) {
  const { t } = useTranslation()
  const rows: { key: string; label: string; value: string | undefined; strong?: boolean }[] = []
  if (discount === undefined || compareDecimal(discount, '0') > 0) {
    rows.push({ key: 'subtotal', label: t('purchasing.totals.subtotal'), value: subtotal })
    rows.push({
      key: 'discount',
      label: t('purchasing.totals.discount'),
      value: discount === undefined ? undefined : `-${discount}`,
    })
  }
  if (vatRegistered || (vat !== undefined && compareDecimal(vat, '0') > 0)) {
    rows.push({ key: 'net', label: t('purchasing.totals.net'), value: net })
    rows.push({ key: 'vat', label: t('purchasing.totals.vat'), value: vat })
  }
  rows.push({ key: 'total', label: t('purchasing.totals.total'), value: total, strong: true })
  return (
    <dl className="space-y-1.5 text-sm">
      {rows.map((row) => (
        <div
          key={row.key}
          data-total={row.key}
          className={cn(
            'flex items-baseline justify-between gap-4',
            row.strong && 'text-base font-semibold',
            // The total alone (no VAT, no discounts) has nothing above it to rule off.
            row.strong && rows.length > 1 && 'border-t pt-2',
          )}
        >
          <dt className={row.strong ? undefined : 'text-muted-foreground'}>{row.label}</dt>
          <dd className="tabular-nums">
            {row.value === undefined ? (
              <Locked category="supplier_price" />
            ) : (
              <bdi>{money(row.value)}</bdi>
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}
