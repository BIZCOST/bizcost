'use client'

import { useTRPC } from '@bizcost/app-core'
import type { BusinessContextDto, DepositsWithoutInvoiceDto } from '@bizcost/contracts'
import { useQuery } from '@tanstack/react-query'
import { AlarmClockIcon } from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isolate } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import { useBusinessDate, useMoney } from '@/features/documents/amounts'
import { maySeePayments } from '@/features/orders/data'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { BillDialog } from './bill-dialog'
import { mayManageInvoices, mayViewInvoices } from './data'

// Deposits without a tax invoice (M3 Step 8, M6; Q22; VAT DL Art. 67(1)): a VAT-registered business
// issues a tax invoice for a deposit within 14 days of receiving it. Each deposit recorded on an order
// that no deposit invoice covers yet is listed with its deadline (in red once it has passed), with the
// way to its order and, for a member who prepares invoices, "Make its deposit invoice" (a draft
// billing that amount of the order as a deposit). On Invoices, and under "Needs a look".

type Deposit = DepositsWithoutInvoiceDto['items'][number]

/** Whether the member sees the deposits: Invoices on, payments seen, a VAT-registered business. */
export function maySeeDeposits(context: BusinessContextDto): boolean {
  return (
    mayViewInvoices(context) &&
    maySeePayments(context) &&
    context.capabilities.vat_registered === true
  )
}

/** The deposits waiting for their tax invoice (none for a member who may not see them). */
export function useDepositsWithoutInvoice() {
  const trpc = useTRPC()
  const { data: context } = useBusinessContext()
  const enabled = context !== undefined && maySeeDeposits(context)
  const query = useQuery({ ...trpc.invoice.depositsWithoutInvoice.queryOptions({}), enabled })
  return { items: enabled ? (query.data?.items ?? []) : [], query }
}

/** The rows: each deposit, its deadline and its actions. */
export function DepositRows({ items, compact = false }: { items: Deposit[]; compact?: boolean }) {
  const { t } = useTranslation()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const [making, setMaking] = useState<Deposit | null>(null)
  if (!context) return null
  const canMake = mayManageInvoices(context) && context.modules.some((m) => m.id === 'orders')
  return (
    <>
      <ul className={cn('space-y-2', compact && 'space-y-3')}>
        {items.map((deposit) => (
          <li
            key={deposit.paymentId}
            data-deposit-without-invoice
            className={cn(
              'flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl px-3 py-2.5 text-sm',
              compact ? 'bg-muted/50' : 'bg-card ring-1 ring-foreground/[0.06]',
            )}
          >
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                <Link
                  href={`/b/${businessId}/orders/${deposit.orderId}`}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  {t('documents.invoices.deposits.order', { number: isolate(deposit.orderNumber) })}
                </Link>
                {deposit.customerName ? (
                  <>
                    {' · '}
                    <bdi>{deposit.customerName}</bdi>
                  </>
                ) : null}
              </p>
              <p className="mt-0.5 text-muted-foreground">
                {t('documents.invoices.deposits.paid', {
                  amount: money(deposit.amount, deposit.currency),
                  date: businessDate(deposit.paidOn),
                })}
                {' · '}
                <span
                  data-deposit-due={deposit.late ? 'late' : 'due'}
                  className={cn(deposit.late && 'font-medium text-destructive')}
                >
                  {t(
                    deposit.late
                      ? 'documents.invoices.deposits.lateSince'
                      : 'documents.invoices.deposits.dueBy',
                    { date: businessDate(deposit.dueBy) },
                  )}
                </span>
              </p>
            </div>
            {canMake ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 bg-card"
                onClick={() => setMaking(deposit)}
              >
                {t('documents.invoices.deposits.make')}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {making ? (
        <BillDialog
          source={{
            kind: 'order',
            id: making.orderId,
            number: making.orderNumber,
            payable: null,
            currency: making.currency,
            stages: [],
          }}
          start={{ bills: 'part', partKind: 'amount', part: making.amount, isDeposit: true }}
          onClose={() => setMaking(null)}
        />
      ) : null}
    </>
  )
}

/** On Invoices: the deposits, when there are any. */
export function DepositsWithoutInvoice() {
  const { t } = useTranslation()
  const { items } = useDepositsWithoutInvoice()
  if (items.length === 0) return null
  return (
    <section
      aria-labelledby="deposits-without-invoice"
      data-deposits-without-invoice
      className="mb-6 rounded-2xl bg-amber-50/70 p-4 ring-1 ring-amber-200 sm:p-5 dark:bg-amber-950/30 dark:ring-amber-900"
    >
      <div className="mb-3 flex items-start gap-2.5">
        <AlarmClockIcon
          aria-hidden
          className="mt-0.5 size-5 shrink-0 text-amber-700 dark:text-amber-300"
        />
        <div className="min-w-0">
          <h2 id="deposits-without-invoice" className="font-semibold">
            {t('documents.invoices.deposits.title')}
          </h2>
          <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
            {t('documents.invoices.deposits.hint')}
          </p>
        </div>
      </div>
      <DepositRows items={items} />
    </section>
  )
}
