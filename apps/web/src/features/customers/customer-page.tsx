'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { CustomerDto, CustomerPaymentDto, SaleListItemDto } from '@bizcost/contracts'
import { compareDecimal } from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query'
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  FileSpreadsheetIcon,
  HandCoinsIcon,
  PencilIcon,
  SearchXIcon,
} from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { isolate } from '@/components/form/use-message'
import { ModuleGate } from '@/components/shell/module-gate'
import { PageContainer } from '@/components/shell/page-container'
import { LoadError, SectionSkeleton } from '@/components/states/query-state'
import { StatePanel } from '@/components/states/state-panel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ArchiveDialog } from '@/features/catalog/catalog-list'
import { useBusinessDate, useMoney } from '@/features/documents/amounts'
import { maySeeStatements, mayViewInvoices } from '@/features/invoices/data'
import { InvoiceRow } from '@/features/invoices/invoice-row'
import { Panel } from '@/features/documents/panel'
import { StatusBadge } from '@/features/documents/status-badge'
import { maySeePayments, mayRecordPayments } from '@/features/orders/data'
import { OrderRow, useOrderItems } from '@/features/orders/orders-page'
import { hasModule } from '@/features/purchasing/data'
import { OwedRow, owedHref } from '@/features/receivables/receivables-page'
import { PayManySheet } from '@/features/receivables/pay-many-sheet'
import { PaymentRow, ReversePaymentDialog } from '@/features/receivables/payments-panel'
import { useBooks } from '@/features/sales/data'
import { can } from '@/features/settings/sections'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { CustomerSheet } from './customer-sheet'
import { KIND_ICONS } from './customers-page'
import { mayChangeCustomers, useRefreshCustomers } from './data'

// A customer's page (M3 Step 5; Q2, Q17, D-263, D-267): who they are (their phone, email, TRN and,
// for a business or a government body, its trade licence), what they still owe with "Record a payment"
// (one amount over several of their orders and sales at once, oldest first), and their orders, sales
// and payments. M3 Step 8: their invoices, and their statement for a period (Q27). Each part shows only
// with its module on and the member's keys for it.

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium break-words">{children}</dd>
    </div>
  )
}

/** One of their sales: its day, what was sold and what it came to. */
function SaleRow({ sale, href }: { sale: SaleListItemDto; href: string }) {
  const { t } = useTranslation()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const itemsOf = useOrderItems()
  const refund = sale.refundOfId !== null
  return (
    <li>
      <Link
        href={href}
        data-customer-sale
        className="flex items-start justify-between gap-3 py-3 outline-none first:pt-0 last:pb-0 hover:underline focus-visible:ring-3 focus-visible:ring-ring"
      >
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2 font-medium">
            {refund
              ? t('orders.customers.page.refundOf', { date: businessDate(sale.businessDate) })
              : sale.orderNumber
                ? t('orders.customers.page.orderSale', {
                    number: isolate(sale.orderNumber),
                    date: businessDate(sale.businessDate),
                  })
                : t('sales.view.title', { date: businessDate(sale.businessDate) })}
            <StatusBadge status={sale.status} kind="sale" />
            {sale.payLater ? <Badge tone="primary">{t('orders.payLater.badge')}</Badge> : null}
          </span>
          <span className="mt-0.5 block text-sm text-muted-foreground">
            <bdi>{itemsOf(sale)}</bdi>
          </span>
        </span>
        <bdi
          className={cn(
            'shrink-0 font-medium tabular-nums',
            sale.status === 'reversed' && 'text-muted-foreground line-through',
          )}
        >
          {money(sale.total, sale.currency)}
        </bdi>
      </Link>
    </li>
  )
}

function CustomerView({ customer }: { customer: CustomerDto }) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const money = useMoney()
  const refreshCustomers = useRefreshCustomers()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const books = useBooks()
  const paymentsShown = context !== undefined && maySeePayments(context)
  const ordersShown =
    context !== undefined &&
    hasModule(context, 'orders') &&
    (can(context, 'orders.documents.view') || can(context, 'orders.documents.manage'))
  const salesShown =
    context !== undefined && hasModule(context, 'sales') && can(context, 'sales.documents.view')
  const owed = useQuery({
    ...trpc.receivable.list.queryOptions({ customerId: customer.id }),
    enabled: paymentsShown,
  })
  const orders = useQuery({
    ...trpc.order.list.queryOptions({ customerId: customer.id, limit: 20 }),
    enabled: ordersShown,
  })
  const sales = useQuery({
    ...trpc.sale.list.queryOptions({ customerId: customer.id, limit: 20 }),
    enabled: salesShown,
  })
  const invoicesShown = context !== undefined && mayViewInvoices(context)
  const invoices = useQuery({
    ...trpc.invoice.list.queryOptions({ customerId: customer.id, limit: 20 }),
    enabled: invoicesShown,
  })
  const payments = useInfiniteQuery({
    ...trpc.customerPayment.list.infiniteQueryOptions(
      { customerId: customer.id },
      { getNextPageParam: (page) => page.nextCursor },
    ),
    enabled: paymentsShown,
  })
  const archive = useMutation(trpc.customer.archive.mutationOptions())
  const unarchive = useMutation(trpc.customer.unarchive.mutationOptions())
  const [editing, setEditing] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [archiveError, setArchiveError] = useState<I18nKey | null>(null)
  const [paying, setPaying] = useState(false)
  const [reversing, setReversing] = useState<CustomerPaymentDto | null>(null)
  if (!context) return null
  const canChange = mayChangeCustomers(context)
  const canRecord = mayRecordPayments(context)
  const archived = customer.archivedAt !== null
  const Icon = KIND_ICONS[customer.kind]
  const group = owed.data?.groups[0]
  const owes = group !== undefined && compareDecimal(group.owed, '0') > 0
  const today = books.data?.today

  async function confirmArchive() {
    setArchiveError(null)
    try {
      await archive.mutateAsync({ id: customer.id })
      toast.success(t('catalog.list.archived', { name: isolate(customer.name) }))
      setArchiving(false)
    } catch (error) {
      setArchiveError(apiErrorKey(error))
    } finally {
      await refreshCustomers()
    }
  }

  async function bringBack() {
    try {
      await unarchive.mutateAsync({ id: customer.id })
      toast.success(t('catalog.list.unarchived', { name: isolate(customer.name) }))
    } catch (error) {
      toast.error(t(apiErrorKey(error)))
    } finally {
      await refreshCustomers()
    }
  }

  const paymentItems = payments.data?.pages.flatMap((page) => page.items) ?? []

  return (
    <PageContainer>
      <Link
        href={`/b/${businessId}/customers`}
        className="-ms-2 -mt-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
        {t('common.nav.customers')}
      </Link>
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={cn(
              'flex size-12 shrink-0 items-center justify-center rounded-2xl',
              archived ? 'bg-muted text-muted-foreground' : 'bg-accent text-primary',
            )}
          >
            <Icon aria-hidden className="size-6" />
          </span>
          <div className="min-w-0">
            <h1
              dir="auto"
              className="text-2xl font-semibold tracking-tight break-words sm:text-3xl"
            >
              {customer.name}
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground">
              {t(`orders.customers.kinds.${customer.kind}`)}
              {archived ? <Badge>{t('catalog.list.archivedBadge')}</Badge> : null}
            </p>
          </div>
        </div>
        {canChange || maySeeStatements(context) ? (
          <div className="flex flex-wrap gap-2">
            {maySeeStatements(context) ? (
              <Button asChild variant="outline">
                <Link href={`/b/${businessId}/customers/${customer.id}/statement`}>
                  <FileSpreadsheetIcon aria-hidden />
                  {t('documents.invoices.statement.button')}
                </Link>
              </Button>
            ) : null}
            {canChange ? (
              <>
                <Button variant="outline" onClick={() => setEditing(true)}>
                  <PencilIcon aria-hidden />
                  {t('catalog.list.edit')}
                </Button>
                {archived ? (
                  <Button variant="ghost" onClick={() => void bringBack()}>
                    <ArchiveRestoreIcon aria-hidden />
                    {t('catalog.list.unarchive')}
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setArchiveError(null)
                      setArchiving(true)
                    }}
                  >
                    <ArchiveIcon aria-hidden />
                    {t('catalog.list.archive')}
                  </Button>
                )}
              </>
            ) : null}
          </div>
        ) : null}
      </header>

      <div className="space-y-5">
        <Panel title={t('orders.customers.page.details')}>
          <dl className="grid grid-cols-2 gap-4 lg:grid-cols-3">
            <Detail label={t('orders.customers.form.phone')}>
              {customer.phone ? (
                <bdi dir="ltr">{customer.phone}</bdi>
              ) : (
                <span className="font-normal text-muted-foreground">—</span>
              )}
            </Detail>
            <Detail label={t('orders.customers.form.email')}>
              {customer.email ? (
                <bdi dir="ltr">{customer.email}</bdi>
              ) : (
                <span className="font-normal text-muted-foreground">—</span>
              )}
            </Detail>
            {customer.trn ? (
              <Detail label={t('orders.customers.form.trn')}>
                <bdi dir="ltr" className="tabular-nums">
                  {customer.trn}
                </bdi>
              </Detail>
            ) : null}
            {customer.tradeLicenceNo ? (
              <Detail label={t('orders.customers.form.licence')}>
                <bdi dir="ltr">{customer.tradeLicenceNo}</bdi>
              </Detail>
            ) : null}
          </dl>
          {customer.notes ? (
            <p dir="auto" className="mt-4 text-sm whitespace-pre-line">
              {customer.notes}
            </p>
          ) : null}
        </Panel>

        {paymentsShown ? (
          <Panel
            title={t('orders.customers.page.owes')}
            action={
              canRecord && owes && today ? (
                <Button variant="outline" onClick={() => setPaying(true)}>
                  <HandCoinsIcon aria-hidden />
                  {t('orders.payments.record')}
                </Button>
              ) : null
            }
          >
            {owed.isError && !owed.data ? (
              <LoadError error={owed.error} onRetry={() => void owed.refetch()} />
            ) : !owed.data ? (
              <p className="text-sm text-muted-foreground">{t('status.loading')}</p>
            ) : !group ? (
              <p data-owes-nothing className="text-sm text-muted-foreground">
                {t('orders.customers.page.owesNothing')}
              </p>
            ) : (
              <>
                <p data-customer-owes className="text-2xl font-semibold tracking-tight">
                  <bdi className="tabular-nums">{money(group.owed, owed.data.currency)}</bdi>
                </p>
                {compareDecimal(group.overpaid, '0') > 0 ? (
                  <p className="mt-1 text-sm text-warning">
                    {t('orders.receivables.owedBack', {
                      amount: money(group.overpaid, owed.data.currency),
                    })}
                  </p>
                ) : null}
                <ul className="-mx-4 mt-3 divide-y border-t sm:-mx-5">
                  {group.documents.map((document) => (
                    <OwedRow
                      key={`${document.kind}:${document.id}`}
                      document={document}
                      href={owedHref(businessId, document)}
                      today={today}
                    />
                  ))}
                </ul>
              </>
            )}
          </Panel>
        ) : null}

        {ordersShown ? (
          <Panel title={t('common.nav.orders')}>
            {orders.isError && !orders.data ? (
              <LoadError error={orders.error} onRetry={() => void orders.refetch()} />
            ) : !orders.data ? (
              <p className="text-sm text-muted-foreground">{t('status.loading')}</p>
            ) : orders.data.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('orders.customers.page.noOrders')}</p>
            ) : (
              <ul className="-mx-4 -my-1 divide-y sm:-mx-5">
                {orders.data.items.map((order) => (
                  <li key={order.id}>
                    <OrderRow
                      order={order}
                      href={`/b/${businessId}/orders/${order.id}`}
                      today={today}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        ) : null}

        {invoicesShown ? (
          <Panel title={t('common.nav.invoices')}>
            {invoices.isError && !invoices.data ? (
              <LoadError error={invoices.error} onRetry={() => void invoices.refetch()} />
            ) : !invoices.data ? (
              <p className="text-sm text-muted-foreground">{t('status.loading')}</p>
            ) : invoices.data.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('documents.invoices.links.noneForCustomer')}
              </p>
            ) : (
              <ul className="-mx-4 -my-1 divide-y sm:-mx-5">
                {invoices.data.items.map((invoice) => (
                  <li key={invoice.id}>
                    <InvoiceRow
                      invoice={invoice}
                      href={`/b/${businessId}/invoices/${invoice.id}`}
                      showCustomer={false}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        ) : null}

        {salesShown ? (
          <Panel title={t('common.nav.sales')}>
            {sales.isError && !sales.data ? (
              <LoadError error={sales.error} onRetry={() => void sales.refetch()} />
            ) : !sales.data ? (
              <p className="text-sm text-muted-foreground">{t('status.loading')}</p>
            ) : sales.data.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('orders.customers.page.noSales')}</p>
            ) : (
              <ul className="divide-y">
                {sales.data.items.map((sale) => (
                  <SaleRow key={sale.id} sale={sale} href={`/b/${businessId}/sales/${sale.id}`} />
                ))}
              </ul>
            )}
          </Panel>
        ) : null}

        {paymentsShown ? (
          <Panel title={t('orders.payments.title')}>
            {payments.isError && !payments.data ? (
              <LoadError error={payments.error} onRetry={() => void payments.refetch()} />
            ) : !payments.data ? (
              <p className="text-sm text-muted-foreground">{t('status.loading')}</p>
            ) : paymentItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('orders.payments.none')}</p>
            ) : (
              <>
                <ul aria-label={t('orders.payments.title')} className="-my-3 divide-y">
                  {paymentItems.map((payment) => (
                    <PaymentRow
                      key={payment.id}
                      payment={payment}
                      showDocument
                      onReverse={canRecord ? () => setReversing(payment) : undefined}
                    />
                  ))}
                </ul>
                {payments.hasNextPage ? (
                  <Button
                    variant="outline"
                    className="mt-4"
                    disabled={payments.isFetchingNextPage}
                    onClick={() => void payments.fetchNextPage()}
                  >
                    {payments.isFetchingNextPage ? t('status.loading') : t('catalog.list.showMore')}
                  </Button>
                ) : null}
              </>
            )}
          </Panel>
        ) : null}
      </div>

      {editing ? <CustomerSheet customer={customer} onClose={() => setEditing(false)} /> : null}
      <ArchiveDialog
        name={archiving ? customer.name : null}
        busy={archive.isPending}
        error={archiveError}
        onConfirm={() => void confirmArchive()}
        onClose={() => setArchiving(false)}
      />
      <ReversePaymentDialog payment={reversing} onClose={() => setReversing(null)} />
      {paying && group && books.data ? (
        <PayManySheet
          customer={{ id: customer.id, name: customer.name }}
          documents={group.documents}
          currency={owed.data?.currency ?? context.currency}
          today={books.data.today}
          closedThrough={books.data.closedThrough}
          onClose={() => setPaying(false)}
        />
      ) : null}
    </PageContainer>
  )
}

function OneCustomer({ customerId }: { customerId: string }) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const { businessId } = useParams<{ businessId: string }>()
  const customer = useQuery(trpc.customer.get.queryOptions({ id: customerId }))
  if (customer.isError && apiErrorCode(customer.error) === 'not_found') {
    return (
      <PageContainer>
        <StatePanel
          icon={SearchXIcon}
          title={t('orders.customers.page.notFound')}
          body={t('orders.customers.page.notFoundBody')}
          documentTitle={`${t('orders.customers.page.notFound')} · ${t('appName')}`}
        >
          <Button asChild variant="outline" size="lg">
            <Link href={`/b/${businessId}/customers`}>
              {t('states.goTo', { section: t('common.nav.customers') })}
            </Link>
          </Button>
        </StatePanel>
      </PageContainer>
    )
  }
  if (customer.isError && !customer.data) {
    return (
      <PageContainer>
        <LoadError error={customer.error} onRetry={() => void customer.refetch()} />
      </PageContainer>
    )
  }
  if (!customer.data) {
    return (
      <PageContainer>
        <SectionSkeleton cards={3} />
      </PageContainer>
    )
  }
  return <CustomerView key={customer.data.id} customer={customer.data} />
}

/** A customer's page, inside the module's gate. */
export function CustomerPage({ customerId }: { customerId: string }) {
  return (
    <ModuleGate moduleId="customers" entryId="customers">
      <OneCustomer customerId={customerId} />
    </ModuleGate>
  )
}
