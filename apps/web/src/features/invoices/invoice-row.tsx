'use client'

import type { InvoiceListItemDto } from '@bizcost/contracts'
import { compareDecimal } from '@bizcost/domain'
import { ReceiptTextIcon } from 'lucide-react'
import Link from 'next/link'
import { useTranslation } from 'react-i18next'
import { isolate } from '@/components/form/use-message'
import { NBSP } from '@/features/catalog/units'
import { useBusinessDate, useMoney } from '@/features/documents/amounts'
import { cn } from '@/lib/utils'
import { InvoiceStateBadge } from './badges'
import { invoiceKindKey, invoiceStateOf } from './data'

// An invoice in a list (M3 Step 8): Invoices, a customer's page, a quotation's or an order's
// invoices. Its number (a draft: "Draft Tax Invoice"), customer, state, what it bills, its date, LPO,
// the order or quotation it comes from (unless what it bills names it already), its due date (in red
// once overdue), and its amount with what it still owes when that is not its amount (a part paid, or
// a credit note took part of it back). A number or an LPO is never broken at its hyphen.

/** A number's hyphens made non-breaking, so "Q-0002" or "DEMO-FO-118" never splits on a line. */
export function keepNumbersWhole(text: string): string {
  return text.replace(/(?<=[\p{L}\p{N}#])-(?=[\p{L}\p{N}])/gu, '\u2011')
}

/** What an invoice bills: "Wardrobe", "Wardrobe and 2 more". */
export function useInvoiceItems() {
  const { t } = useTranslation()
  return (invoice: Pick<InvoiceListItemDto, 'lineTitles' | 'lineCount'>) => {
    const names = invoice.lineTitles.filter(Boolean)
    const more = invoice.lineCount - names.length
    if (names.length === 0) return t('documents.invoices.list.noLines')
    const joined = keepNumbersWhole(names.join(t('sales.list.namesSeparator')))
    return more > 0
      ? t('documents.invoices.list.moreLines', { names: joined, count: more })
      : joined
  }
}

export function InvoiceRow({
  invoice,
  href,
  showCustomer = true,
  showSource = true,
}: {
  invoice: InvoiceListItemDto
  href: string
  /** On a customer's page their name is said once, above. */
  showCustomer?: boolean
  /** On a quotation's or an order's page, it isn't named again. */
  showSource?: boolean
}) {
  const { t } = useTranslation()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const itemsOf = useInvoiceItems()
  const state = invoiceStateOf(invoice)
  const closed = state === 'credited' || state === 'paid'
  const date = (day: string) => businessDate(day).replaceAll(' ', NBSP)
  const owes = invoice.owed !== null && compareDecimal(invoice.owed, '0') > 0
  // What it still owes, said when it is not its amount (a part paid, or a credit note took part back).
  const owedApart = owes && compareDecimal(invoice.owed ?? '0', invoice.payable) !== 0
  // What it bills names its quotation or order already ("Payment 1 of 3 – quotation Q-0002").
  const sourceNumber = invoice.orderNumber ?? invoice.quotationNumber
  const named =
    sourceNumber !== null && invoice.lineTitles.some((title) => title.includes(sourceNumber))
  return (
    <Link
      href={href}
      data-invoice-row={state}
      className="flex items-start gap-3 px-4 py-3.5 transition-colors outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset sm:px-5"
    >
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-xl',
          closed ? 'bg-muted text-muted-foreground' : 'bg-accent text-primary',
        )}
      >
        <ReceiptTextIcon aria-hidden className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 font-medium break-words">
            {invoice.number ? (
              <bdi dir="ltr">{invoice.number}</bdi>
            ) : (
              t('documents.invoices.list.draftOf', { kind: t(invoiceKindKey(invoice.kind)) })
            )}
            {showCustomer ? (
              <>
                {' · '}
                <bdi>{invoice.customerName}</bdi>
              </>
            ) : null}
          </span>
          <InvoiceStateBadge state={state} creditState={invoice.creditState} />
          {invoice.isDeposit ? (
            <span className="text-xs text-muted-foreground">
              {t('documents.invoices.list.deposit')}
            </span>
          ) : null}
        </span>
        <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
          <bdi>{itemsOf(invoice)}</bdi>
          {invoice.issueDate ? <> · {date(invoice.issueDate)}</> : null}
          {invoice.lpoReference ? (
            <>
              {' · '}
              <span className="whitespace-nowrap">
                {t('documents.invoices.list.lpo', {
                  lpo: isolate(keepNumbersWhole(invoice.lpoReference)),
                })}
              </span>
            </>
          ) : null}
          {!showSource || named ? null : invoice.orderNumber ? (
            <>
              {' · '}
              <span className="whitespace-nowrap">
                {t('documents.invoices.list.ofOrder', { number: isolate(invoice.orderNumber) })}
              </span>
            </>
          ) : invoice.quotationNumber ? (
            <>
              {' · '}
              <span className="whitespace-nowrap">
                {t('documents.invoices.list.ofQuotation', {
                  number: isolate(invoice.quotationNumber),
                })}
              </span>
            </>
          ) : null}
          {invoice.dueDate && owes ? (
            <>
              {' · '}
              {invoice.overdue ? (
                <span className="font-medium text-destructive">
                  {t('documents.invoices.list.overdueSince', { date: date(invoice.dueDate) })}
                </span>
              ) : (
                t('documents.invoices.list.dueOn', { date: date(invoice.dueDate) })
              )}
            </>
          ) : null}
          {invoice.enteredByName ? (
            <>
              {' · '}
              <bdi>{invoice.enteredByName}</bdi>
            </>
          ) : null}
        </span>
      </span>
      <span
        className={cn('shrink-0 pt-0.5 text-end font-medium', closed && 'text-muted-foreground')}
      >
        <bdi className="block tabular-nums">{money(invoice.payable, invoice.currency)}</bdi>
        {owedApart ? (
          <span data-invoice-owed className="block text-xs font-normal text-muted-foreground">
            {t('documents.invoices.list.owed', {
              amount: money(invoice.owed ?? '0', invoice.currency),
            })}
          </span>
        ) : null}
      </span>
    </Link>
  )
}
