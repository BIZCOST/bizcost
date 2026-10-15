'use client'

import { useTRPC } from '@bizcost/app-core'
import type { OwedDocumentDto, ReceivableGroupDto } from '@bizcost/contracts'
import { compareDecimal } from '@bizcost/domain'
import { useInfiniteQuery } from '@tanstack/react-query'
import { HandCoinsIcon, WalletIcon } from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ModuleGate } from '@/components/shell/module-gate'
import { PageContainer } from '@/components/shell/page-container'
import { LoadError } from '@/components/states/query-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ListEmpty, ListSkeleton } from '@/features/catalog/catalog-list'
import { useBusinessDate, useMoney } from '@/features/documents/amounts'
import { PaymentBadge } from '@/features/orders/badges'
import { hasModule } from '@/features/purchasing/data'
import { mayRecordPayments } from '@/features/orders/data'
import { useBooks } from '@/features/sales/data'
import { useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { useOwedTitle } from './owed-title'
import { PayManySheet } from './pay-many-sheet'
import { CustomerPaymentSheet, type PaidDocument } from './payment-sheet'

// What customers owe («مستحقات العملاء», M3 Step 5; Q17, D-267; one figure per obligation, A2): the
// orders and sales "they'll pay later" still owed, by customer, oldest first, with what each owes;
// and those paid beyond what they come to ("money back to the customer"). A customer's payment is
// recorded here: one amount over several of their orders and sales at once, oldest first ("Pay
// several at once"), or money given back on one. payments.customers.view sees it; .record records.
// A business without Orders (a designer's One sale "they'll pay later") reads of sales only (D-274).

const positive = (value: string) => compareDecimal(value, '0') > 0

/** Where an order or a sale opens. */
export function owedHref(businessId: string, document: Pick<OwedDocumentDto, 'kind' | 'id'>) {
  return `/b/${businessId}/${document.kind === 'order' ? 'orders' : 'sales'}/${document.id}`
}

/** One order or sale: what it is, its days, its state and what it owes (or is owed back). */
export function OwedRow({
  document,
  href,
  today,
  onPay,
  onGiveBack,
}: {
  document: OwedDocumentDto
  href: string
  today: string | undefined
  onPay?: () => void
  onGiveBack?: () => void
}) {
  const { t } = useTranslation()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const titleOf = useOwedTitle()
  const overpaid = positive(document.overpaid)
  const late =
    document.orderStatus === 'pending' &&
    document.dueDate !== null &&
    today !== undefined &&
    document.dueDate < today
  return (
    <li
      data-owed-document={document.kind}
      className="grid gap-x-4 gap-y-2 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5"
    >
      <div className="min-w-0">
        <Link
          href={href}
          className="font-medium break-words text-primary underline-offset-4 hover:underline"
        >
          <bdi>{titleOf(document)}</bdi>
        </Link>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span>{businessDate(document.businessDate)}</span>
          {document.dueDate && document.orderStatus === 'pending' ? (
            <span className={late ? 'font-medium text-destructive' : undefined}>
              {t(late ? 'orders.list.late' : 'orders.list.due', {
                date: businessDate(document.dueDate),
              })}
            </span>
          ) : null}
          {document.orderStatus === 'cancelled' ? (
            <Badge tone="neutral">{t('orders.status.cancelled')}</Badge>
          ) : null}
          <PaymentBadge
            state={document.state}
            pending={document.orderStatus === 'pending'}
            cancelled={document.orderStatus === 'cancelled'}
          />
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 sm:justify-end">
        <p className="text-sm">
          <span className="text-muted-foreground">
            {t(overpaid ? 'orders.payments.overpaid' : 'orders.payments.owed')}{' '}
          </span>
          <bdi data-owed-amount className="font-semibold tabular-nums">
            {money(overpaid ? document.overpaid : document.owed, document.currency)}
          </bdi>
        </p>
        {overpaid && onGiveBack ? (
          <Button variant="outline" size="sm" onClick={onGiveBack}>
            {t('orders.payments.giveBack')}
          </Button>
        ) : !overpaid && onPay ? (
          <Button variant="outline" size="sm" onClick={onPay}>
            {t('orders.payments.record')}
          </Button>
        ) : null}
      </div>
    </li>
  )
}

/** A customer and their orders and sales still owed (or paid beyond). */
function GroupCard({
  group,
  businessId,
  today,
  canRecord,
  onPayMany,
  onOne,
  salesOnly,
}: {
  group: ReceivableGroupDto
  businessId: string
  today: string | undefined
  canRecord: boolean
  onPayMany: () => void
  onOne: (document: OwedDocumentDto, mode: 'payment' | 'refund') => void
  /** Without Orders, only sales "they'll pay later" are owed: said so. */
  salesOnly: boolean
}) {
  const { t } = useTranslation()
  const money = useMoney()
  const id = useId()
  const named = group.customerId !== null
  return (
    <section
      data-receivable-group
      aria-labelledby={id}
      className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b bg-muted/30 px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <h2 id={id} className="flex min-w-0 flex-wrap items-center gap-2 font-semibold">
            {named ? (
              <>
                <bdi className="min-w-0 [overflow-wrap:anywhere]">{group.name}</bdi>
                {group.phoneLast4 ? (
                  <bdi dir="ltr" className="text-sm font-normal text-muted-foreground tabular-nums">
                    …{group.phoneLast4}
                  </bdi>
                ) : null}
              </>
            ) : (
              t('orders.receivables.noCustomer')
            )}
            {group.active ? null : <Badge tone="neutral">{t('orders.customers.archived')}</Badge>}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t(salesOnly ? 'orders.receivables.salesCount' : 'orders.receivables.documents', {
              count: group.documentCount,
            })}
            {positive(group.owed) ? (
              <>
                {' · '}
                <span className="text-foreground">
                  {t('orders.receivables.owes', { amount: money(group.owed) })}
                </span>
              </>
            ) : null}
            {positive(group.overpaid) ? (
              <>
                {' · '}
                <span className="text-warning">
                  {t('orders.receivables.owedBack', { amount: money(group.overpaid) })}
                </span>
              </>
            ) : null}
          </p>
        </div>
        {named && canRecord && positive(group.owed) ? (
          <Button onClick={onPayMany}>
            <HandCoinsIcon aria-hidden />
            {t('orders.payments.record')}
          </Button>
        ) : null}
      </div>
      <ul aria-label={group.name ?? t('orders.receivables.noCustomer')} className="divide-y">
        {group.documents.map((document) => (
          <OwedRow
            key={`${document.kind}:${document.id}`}
            document={document}
            href={owedHref(businessId, document)}
            today={today}
            // A customer's payments go through "Pay several at once"; orders without a customer one
            // by one.
            onPay={canRecord && !named ? () => onOne(document, 'payment') : undefined}
            onGiveBack={canRecord ? () => onOne(document, 'refund') : undefined}
          />
        ))}
      </ul>
      {group.documentCount > group.documents.length ? (
        <p className="border-t px-4 py-3 text-sm text-muted-foreground sm:px-5">
          {t('orders.receivables.more', {
            shown: group.documents.length,
            count: group.documentCount,
          })}
        </p>
      ) : null}
    </section>
  )
}

function Receivables() {
  const { t } = useTranslation()
  const term = useTerminology()
  const trpc = useTRPC()
  const money = useMoney()
  const titleOf = useOwedTitle()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const books = useBooks()
  const list = useInfiniteQuery(
    trpc.receivable.list.infiniteQueryOptions({}, { getNextPageParam: (page) => page.nextCursor }),
  )
  const [many, setMany] = useState<ReceivableGroupDto | null>(null)
  const [one, setOne] = useState<{
    document: PaidDocument
    mode: 'payment' | 'refund'
    max: string
    currency: string
  } | null>(null)
  if (!context) return null
  const canRecord = mayRecordPayments(context)
  const first = list.data?.pages[0]
  const groups = list.data?.pages.flatMap((page) => page.groups) ?? []
  const today = books.data?.today
  const title = t('common.nav.receivables')
  const ordersOn = hasModule(context, 'orders')
  const salesOnly = (documents: readonly OwedDocumentDto[]) =>
    !ordersOn && documents.every((document) => document.kind === 'sale')
  return (
    <PageContainer>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        <p className="mt-1.5 max-w-2xl text-muted-foreground">
          {ordersOn
            ? term('orders.receivables.intro', context.terminologyProfile)
            : t('orders.receivables.introSales')}
        </p>
      </header>
      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError && !list.data ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} />
      ) : groups.length === 0 ? (
        <ListEmpty
          icon={WalletIcon}
          title={t('orders.receivables.empty.title')}
          body={t(
            ordersOn ? 'orders.receivables.empty.body' : 'orders.receivables.empty.bodySales',
          )}
        />
      ) : (
        <div className="space-y-4">
          {first ? (
            <section
              aria-label={t('orders.receivables.totalLabel')}
              data-receivables-total
              className="flex flex-wrap items-end justify-between gap-4 rounded-2xl bg-card p-5 shadow-sm ring-1 ring-foreground/[0.06]"
            >
              <div>
                <p className="text-sm text-muted-foreground">{t('orders.receivables.total')}</p>
                <p className="mt-1 text-3xl font-semibold tracking-tight">
                  <bdi className="tabular-nums">{money(first.owed, first.currency)}</bdi>
                </p>
              </div>
              {positive(first.overpaid) ? (
                <p className="text-sm text-warning">
                  {t('orders.receivables.totalBack', {
                    amount: money(first.overpaid, first.currency),
                  })}
                </p>
              ) : null}
            </section>
          ) : null}
          {groups.map((group) => (
            <GroupCard
              key={group.customerId ?? 'none'}
              group={group}
              businessId={businessId}
              today={today}
              canRecord={canRecord && today !== undefined}
              onPayMany={() => setMany(group)}
              salesOnly={salesOnly(group.documents)}
              onOne={(document, mode) =>
                setOne({
                  document: {
                    kind: document.kind,
                    id: document.id,
                    businessDate: document.businessDate,
                    label: titleOf(document),
                  },
                  mode,
                  max: mode === 'refund' ? document.overpaid : document.owed,
                  currency: document.currency,
                })
              }
            />
          ))}
          {list.isError ? (
            <LoadError error={list.error} onRetry={() => void list.fetchNextPage()} />
          ) : list.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                variant="outline"
                disabled={list.isFetchingNextPage}
                onClick={() => void list.fetchNextPage()}
              >
                {list.isFetchingNextPage ? t('status.loading') : t('catalog.list.showMore')}
              </Button>
            </div>
          ) : null}
        </div>
      )}
      {many && many.customerId && books.data ? (
        <PayManySheet
          customer={{ id: many.customerId, name: many.name ?? '' }}
          documents={many.documents}
          currency={first?.currency ?? context.currency}
          today={books.data.today}
          closedThrough={books.data.closedThrough}
          onClose={() => setMany(null)}
        />
      ) : null}
      {one && books.data ? (
        <CustomerPaymentSheet
          document={one.document}
          mode={one.mode}
          max={one.max}
          currency={one.currency}
          today={books.data.today}
          closedThrough={books.data.closedThrough}
          onClose={() => setOne(null)}
        />
      ) : null}
    </PageContainer>
  )
}

/** What customers owe: inside the Payments module's gate. */
export function ReceivablesPage() {
  return (
    <ModuleGate moduleId="payments" entryId="receivables">
      <Receivables />
    </ModuleGate>
  )
}
