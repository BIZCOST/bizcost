'use client'

import type { OwedDocumentDto } from '@bizcost/contracts'
import { useTranslation } from 'react-i18next'
import { isolate } from '@/components/form/use-message'
import { useBusinessDate } from '@/features/documents/amounts'

/**
 * How an order, a sale "they'll pay later" or an invoice (M3 Step 8) is named where what customers owe
 * is listed: "Order #1001 · Chocolate cake", "Sale of 8 Oct 2026 · Logo design", "Invoice INV-0003 ·
 * Partitions".
 */
export function useOwedTitle() {
  const { t } = useTranslation()
  const businessDate = useBusinessDate()
  return (
    document: Pick<OwedDocumentDto, 'kind' | 'number' | 'businessDate' | 'itemNames'>,
  ): string => {
    const name =
      document.kind === 'order'
        ? t('orders.receivables.order', { number: isolate(document.number ?? '') })
        : document.kind === 'invoice'
          ? t('orders.receivables.invoice', { number: isolate(document.number ?? '') })
          : t('orders.receivables.sale', { date: businessDate(document.businessDate) })
    const items = document.itemNames.filter(Boolean).join(t('sales.list.namesSeparator'))
    return items ? `${name} · ${items}` : name
  }
}
