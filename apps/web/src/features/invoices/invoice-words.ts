'use client'

import type { InvoiceDto } from '@bizcost/contracts'
import { useTranslation } from 'react-i18next'
import { isolate } from '@/components/form/use-message'
import { useFormatQuantity } from '@/features/catalog/unit-parts'
import { useMoney } from '@/features/documents/amounts'

// How an invoice made from a source says what it bills (M3 Step 8; Q22): "Bills 30% of quotation
// Q-0003", "A deposit of AED 5,000.00 on order #1004", "The final invoice of order #1004: the work
// less its deposits", "Bills the sale you recorded".

type Source = Pick<
  InvoiceDto,
  | 'quotationId'
  | 'quotationNumber'
  | 'orderId'
  | 'orderNumber'
  | 'saleId'
  | 'bills'
  | 'part'
  | 'isDeposit'
  | 'lines'
  | 'currency'
>

/** "quotation Q-0003", "order #1004"; null for a sale or from scratch. */
export function useSourceName() {
  const { t } = useTranslation()
  return (invoice: Pick<Source, 'quotationId' | 'quotationNumber' | 'orderId' | 'orderNumber'>) =>
    invoice.quotationId
      ? t('documents.invoices.bill.ofQuotation', { number: isolate(invoice.quotationNumber ?? '') })
      : invoice.orderId
        ? t('documents.invoices.bill.ofOrder', { number: isolate(invoice.orderNumber ?? '') })
        : null
}

export function useBillsSummary() {
  const { t } = useTranslation()
  const money = useMoney()
  const quantity = useFormatQuantity()
  const sourceName = useSourceName()
  return (invoice: Source): string | null => {
    if (invoice.saleId) return t('documents.invoices.bills.sale')
    const source = sourceName(invoice)
    if (source === null) return null
    if (invoice.bills === 'everything') return t('documents.invoices.bills.everything', { source })
    if (invoice.bills === 'rest') {
      return invoice.lines.some((line) => line.kind === 'deduction')
        ? t('documents.invoices.bills.final', { source })
        : t('documents.invoices.bills.rest', { source })
    }
    const share =
      invoice.part && 'percent' in invoice.part
        ? `${quantity(invoice.part.percent)}%`
        : invoice.part && 'amount' in invoice.part
          ? money(invoice.part.amount, invoice.currency)
          : ''
    return t(
      invoice.isDeposit ? 'documents.invoices.bills.deposit' : 'documents.invoices.bills.part',
      {
        share: isolate(share),
        source,
      },
    )
  }
}
