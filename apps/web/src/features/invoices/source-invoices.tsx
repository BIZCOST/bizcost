'use client'

import { useTRPC } from '@bizcost/app-core'
import { compareDecimal, sumDecimals } from '@bizcost/domain'
import { useQuery } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { LoadError } from '@/components/states/query-state'
import { useMoney } from '@/features/documents/amounts'
import { Panel } from '@/features/documents/panel'
import { InvoiceRow } from './invoice-row'

// The invoices of a quotation or an order (M3 Step 8; Q22): each one (drafts too) with its state, and
// what the issued ones bill in all, so stage invoices can be seen adding up to the quotation.

/**
 * Whether a quotation or an order of `payable` is invoiced in full (its issued invoices bill all of
 * it, and no credit note took any back: then only the API knows what is left). Nothing more to invoice
 * then: "Make an invoice" goes.
 */
export function useInvoicedInFull(
  filter: { quotationId: string } | { orderId: string },
  payable: string,
  enabled: boolean,
): boolean {
  const trpc = useTRPC()
  const issued = useQuery({
    ...trpc.invoice.list.queryOptions({ ...filter, status: 'issued', limit: 50 }),
    enabled,
  })
  const items = issued.data?.items ?? []
  return (
    enabled &&
    items.length > 0 &&
    items.every((invoice) => invoice.creditState === 'none') &&
    compareDecimal(sumDecimals(items.map((invoice) => invoice.payable)), payable) >= 0
  )
}

export function SourceInvoices({
  filter,
  currency,
  action,
}: {
  filter: { quotationId: string } | { orderId: string }
  currency: string
  /** "Invoice this quotation" at the title's end. */
  action?: ReactNode
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const money = useMoney()
  const { businessId } = useParams<{ businessId: string }>()
  const list = useQuery(trpc.invoice.list.queryOptions({ ...filter, limit: 50 }))
  const items = list.data?.items ?? []
  const issued = items.filter((invoice) => invoice.status === 'issued')
  if (list.isSuccess && items.length === 0 && !action) return null
  return (
    <Panel title={t('common.nav.invoices')} action={action}>
      {list.isError && !list.data ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} />
      ) : !list.data ? (
        <p className="text-sm text-muted-foreground">{t('status.loading')}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('documents.invoices.links.none')}</p>
      ) : (
        <>
          <ul className="-mx-4 -my-1 divide-y sm:-mx-5" data-source-invoices>
            {items.map((invoice) => (
              <li key={invoice.id}>
                <InvoiceRow
                  invoice={invoice}
                  href={`/b/${businessId}/invoices/${invoice.id}`}
                  showCustomer={false}
                  showSource={false}
                />
              </li>
            ))}
          </ul>
          {issued.length > 0 ? (
            <p
              data-source-invoiced
              className="mt-3 flex justify-between gap-3 border-t pt-3 text-sm font-medium"
            >
              <span>{t('documents.invoices.links.invoiced')}</span>
              <bdi className="tabular-nums">
                {money(sumDecimals(issued.map((invoice) => invoice.payable)), currency)}
              </bdi>
            </p>
          ) : null}
        </>
      )}
    </Panel>
  )
}
