'use client'

import { useTRPC } from '@bizcost/app-core'
import type { MinePayableDto } from '@bizcost/contracts'
import { compareDecimal } from '@bizcost/domain'
import { formatList } from '@bizcost/i18n'
import { useInfiniteQuery } from '@tanstack/react-query'
import { HandCoinsIcon } from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useTranslation } from 'react-i18next'
import { isolate } from '@/components/form/use-message'
import { LoadError } from '@/components/states/query-state'
import { Button } from '@/components/ui/button'
import { ListEmpty, ListSkeleton } from '@/features/catalog/catalog-list'
import { Money, useBusinessDate, useMoney } from '@/features/documents/amounts'
import { can } from '@/features/settings/sections'
import { useLocale } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { hasModule } from './data'

// "Owed to me" (the owner's answers of 2026-09-29, A4; D-181): what the business owes a member for
// the purchases and expenses they paid from their own money, and what it paid them back, with the
// amounts even when their role hides supplier prices (payable.mine returns only their own). A tab of
// Amounts owed, open to every member while Purchases or Expenses is on (the Expenses page's "My
// expenses" sums it up in a card). A row opens its purchase or expense only for a member who may see it.

/** Where a row opens: the expense or purchase page, when the member may see it. */
function useDocumentHref() {
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  return (item: MinePayableDto): string | null => {
    if (!context) return null
    if (item.kind === 'expense') {
      return hasModule(context, 'expenses') && can(context, 'expenses.documents.view')
        ? `/b/${businessId}/expenses/${item.documentId}`
        : null
    }
    return hasModule(context, 'purchases') && can(context, 'purchases.documents.view')
      ? `/b/${businessId}/purchases/${item.documentId}`
      : null
  }
}

/** One purchase or expense the member paid: its amounts and what was paid back, when. */
function OwedRow({ item, href }: { item: MinePayableDto; href: string | null }) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const title = t(
    item.kind === 'expense' ? 'purchasing.payables.expenseTitle' : 'purchasing.view.title',
    { date: businessDate(item.businessDate) },
  )
  const what =
    item.kind === 'expense'
      ? [item.categoryName, ...item.itemNames]
          .filter((name): name is string => Boolean(name))
          .map((name) => isolate(name))
          .join(' · ')
      : formatList(
          locale,
          item.itemNames.filter(Boolean).map((name) => isolate(name)),
        )
  const returned = compareDecimal(item.returned, '0') > 0
  const settled = compareDecimal(item.outstanding, '0') === 0
  return (
    <li
      data-owed-item={item.documentId}
      className="grid gap-x-4 gap-y-2 px-4 py-3 sm:px-5 xl:grid-cols-[minmax(0,1fr)_repeat(4,8.5rem)] xl:items-start"
    >
      <div className="min-w-0">
        {href ? (
          <Link
            href={href}
            className="font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring"
          >
            {title}
          </Link>
        ) : (
          <p className="font-medium">{title}</p>
        )}
        <p className="mt-0.5 text-sm text-muted-foreground">
          {item.reference ? (
            <>
              <bdi dir="auto">{item.reference}</bdi>
              {what ? ' · ' : null}
            </>
          ) : null}
          {what}
          {item.supplierName ? (
            <>
              {item.reference || what ? ' · ' : null}
              {t('purchasing.payables.mine.supplier', { name: isolate(item.supplierName) })}
            </>
          ) : null}
        </p>
        {item.payments.length > 0 ? (
          <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
            {item.payments.map((payment) => (
              <li key={payment.id} data-paid-back>
                {t('purchasing.payables.mine.paidBackOn', {
                  date: businessDate(payment.businessDate),
                  amount: isolate(money(payment.amount, item.currency)),
                })}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <dl
        className={cn(
          'grid gap-2 text-sm xl:contents',
          returned ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3',
        )}
      >
        <div
          data-amount="total"
          className={cn('min-w-0 xl:text-end', !returned && 'xl:col-start-3')}
        >
          <dt className="text-xs text-muted-foreground">{t('purchasing.payments.total')}</dt>
          <dd>
            <Money value={item.total} currency={item.currency} />
          </dd>
        </div>
        {returned ? (
          <div data-amount="returned" className="min-w-0 xl:col-start-3 xl:text-end">
            <dt className="text-xs text-muted-foreground">{t('purchasing.payments.returned')}</dt>
            <dd>
              <Money value={item.returned} currency={item.currency} />
            </dd>
          </div>
        ) : null}
        <div data-amount="paid" className="min-w-0 xl:col-start-4 xl:text-end">
          <dt className="text-xs text-muted-foreground">
            {t('purchasing.payables.mine.paidBack')}
          </dt>
          <dd>
            <Money value={item.paid} currency={item.currency} />
          </dd>
        </div>
        <div data-amount="outstanding" className="min-w-0 xl:col-start-5 xl:text-end">
          <dt className="text-xs text-muted-foreground">{t('purchasing.payments.outstanding')}</dt>
          <dd className="font-semibold">
            {settled ? (
              <span className="font-medium text-success">
                {t('purchasing.payables.mine.settled')}
              </span>
            ) : (
              <Money value={item.outstanding} currency={item.currency} />
            )}
          </dd>
        </div>
      </dl>
    </li>
  )
}

/** Amounts owed → "Owed to me": the totals, then every purchase and expense the member paid. */
export function OwedToMeList() {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const hrefOf = useDocumentHref()
  const list = useInfiniteQuery(
    trpc.payable.mine.infiniteQueryOptions({}, { getNextPageParam: (page) => page.nextCursor }),
  )
  const first = list.data?.pages[0]
  const items = list.data?.pages.flatMap((page) => page.items) ?? []
  if (list.isPending) return <ListSkeleton />
  if (list.isError && !first) {
    return <LoadError error={list.error} onRetry={() => void list.refetch()} />
  }
  if (!first || items.length === 0) {
    return (
      <ListEmpty
        icon={HandCoinsIcon}
        title={t('purchasing.payables.mine.empty')}
        body={t('purchasing.payables.mine.emptyBody')}
      />
    )
  }
  return (
    <>
      <dl
        data-owed-to-me-total
        className="grid grid-cols-2 gap-3 rounded-2xl bg-card px-4 py-3 shadow-sm ring-1 ring-foreground/[0.06] sm:px-5"
      >
        <div className="min-w-0">
          <dt className="text-sm text-muted-foreground">{t('purchasing.payables.mine.total')}</dt>
          <dd className="text-lg font-semibold">
            <Money value={first.outstanding} currency={first.currency} />
          </dd>
        </div>
        <div className="min-w-0 text-end">
          <dt className="text-sm text-muted-foreground">
            {t('purchasing.payables.mine.paidBack')}
          </dt>
          <dd className="text-lg font-semibold">
            <Money value={first.paidBack} currency={first.currency} />
          </dd>
        </div>
      </dl>
      <ul
        aria-label={t('purchasing.payables.toMe')}
        className="divide-y overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]"
      >
        {items.map((item) => (
          <OwedRow key={`${item.kind}:${item.documentId}`} item={item} href={hrefOf(item)} />
        ))}
      </ul>
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
    </>
  )
}
