'use client'

import { useTRPC } from '@bizcost/app-core'
import type { MineExpenseDto } from '@bizcost/contracts'
import { compareDecimal, monthOf } from '@bizcost/domain'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ArrowRightIcon, ReceiptIcon } from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useTranslation } from 'react-i18next'
import { isolate } from '@/components/form/use-message'
import { LoadError } from '@/components/states/query-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ListEmpty, ListSkeleton } from '@/features/catalog/catalog-list'
import { Money, useBusinessDate, useBusinessMonth, useMoney } from '@/features/purchasing/amounts'
import { cn } from '@/lib/utils'
import { usePaysLabel } from './pays-choice'
import { ExpenseStatusBadge } from './status-badge'

// "My expenses" (the owner's answers of 2026-09-29, A4; D-181): the expenses the member entered or
// paid from their own money, with their amounts even when their role hides supplier prices
// (expense.mine returns only their own), and, for one they paid themselves, whether it was paid back,
// and what it pays (D-216).
// What the business owes them in all sits on top ("Owed to you", with a link to Amounts owed).

/**
 * Whether it was paid back (or paid, on credit): said once it is final. A phone gives it the row's
 * whole width under the details; a wider screen puts it under the amount, wrapping within its column
 * (a long "partly paid back" never squeezes what the expense was for).
 */
function Settlement({ expense, className }: { expense: MineExpenseDto; className?: string }) {
  const { t } = useTranslation()
  const money = useMoney()
  if (expense.outstanding === null || expense.paid === null) return null
  const amount = (value: string) => isolate(money(value, expense.currency))
  const owed = compareDecimal(expense.outstanding, '0') > 0
  const partly = owed && compareDecimal(expense.paid, '0') > 0
  let text: string
  if (expense.paidByMe) {
    text = owed
      ? t('expenses.mine.owed', { amount: amount(expense.outstanding) })
      : t('expenses.mine.paidBack')
  } else {
    text = owed
      ? t('expenses.mine.stillOwed', { amount: amount(expense.outstanding) })
      : t('expenses.mine.paid')
  }
  return (
    <span
      data-settlement={owed ? 'owed' : 'settled'}
      className={cn(
        'block text-xs font-normal break-words',
        owed ? 'text-warning' : 'text-success',
        className,
      )}
    >
      {text}
      {partly && expense.paidByMe
        ? ` · ${t('expenses.mine.partlyPaidBack', {
            paid: amount(expense.paid),
            total: amount(expense.total),
          })}`
        : null}
    </span>
  )
}

function MineRow({ expense, href }: { expense: MineExpenseDto; href: string }) {
  const { t } = useTranslation()
  const businessDate = useBusinessDate()
  const monthName = useBusinessMonth()
  const paysLabel = usePaysLabel()
  // What it pays (D-216): the running cost's name only to a member who may see running costs.
  const pays = paysLabel(expense.pays)
  const parts = [
    expense.description ? <bdi key="category">{expense.categoryName}</bdi> : null,
    <span key="date">{businessDate(expense.businessDate)}</span>,
    // The month the bill is for, when it is not the bill's own month (D-194).
    expense.periodMonth !== monthOf(expense.businessDate) ? (
      <span key="month">
        {t('expenses.list.forMonth', { month: monthName(expense.periodMonth) })}
      </span>
    ) : null,
    pays ? (
      // Kept whole on its line when it fits.
      <span key="pays" data-pays={expense.pays?.kind} className="inline-block">
        {pays}
      </span>
    ) : null,
    expense.reference ? (
      // Kept whole on its line when it fits ("DEWA-118734", never "DEWA-" / "118734").
      <bdi key="reference" dir="auto" className="inline-block">
        {expense.reference}
      </bdi>
    ) : null,
  ].filter(Boolean)
  return (
    <Link
      href={href}
      data-mine-expense={expense.id}
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 px-4 py-3.5 transition-colors outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset sm:px-5"
    >
      <span
        className={cn(
          'row-span-2 flex size-10 shrink-0 items-center justify-center rounded-xl',
          expense.status === 'reversed'
            ? 'bg-muted text-muted-foreground'
            : 'bg-accent text-primary',
        )}
      >
        <ReceiptIcon aria-hidden className="size-5" />
      </span>
      <span className="col-start-2 row-start-1 min-w-0 sm:row-span-2">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span dir="auto" className="min-w-0 font-medium break-words">
            {expense.description ?? expense.categoryName}
          </span>
          <ExpenseStatusBadge status={expense.status} />
          {expense.paidByMe ? <Badge tone="neutral">{t('expenses.mine.paidByYou')}</Badge> : null}
        </span>
        <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
          {parts.map((part, index) => (
            <span key={index}>
              {index > 0 ? ' · ' : null}
              {part}
            </span>
          ))}
        </span>
      </span>
      <span className="col-start-3 row-start-1 pt-0.5 text-end font-medium whitespace-nowrap">
        <Money
          value={expense.total}
          currency={expense.currency}
          className={cn(expense.status === 'reversed' && 'text-muted-foreground line-through')}
        />
      </span>
      <Settlement
        expense={expense}
        className="col-span-2 col-start-2 row-start-2 mt-1 sm:col-span-1 sm:col-start-3 sm:max-w-64 sm:text-end"
      />
    </Link>
  )
}

/**
 * What the business owes the member, in one card ("My expenses"): shown once they paid something
 * themselves, with a link to the details on Amounts owed.
 */
export function OwedToMeCard() {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const { businessId } = useParams<{ businessId: string }>()
  const money = useMoney()
  const owed = useQuery(trpc.payable.mine.queryOptions({ limit: 1 }))
  const data = owed.data
  if (!data || (data.owedCount === 0 && compareDecimal(data.paidBack, '0') === 0)) return null
  return (
    <section
      data-owed-to-me-card
      className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-card px-4 py-3 shadow-sm ring-1 ring-foreground/[0.06] sm:px-5"
    >
      <div className="min-w-0">
        <h2 className="text-sm text-muted-foreground">{t('expenses.mine.owedTitle')}</h2>
        <p className="text-lg font-semibold">
          <Money value={data.outstanding} currency={data.currency} />
        </p>
        <p className="text-sm text-muted-foreground">
          {data.owedCount > 0 ? (
            <>
              {t('expenses.mine.owedCount', { count: data.owedCount })}
              {' · '}
            </>
          ) : null}
          {t('expenses.mine.paidBackSoFar', {
            amount: isolate(money(data.paidBack, data.currency)),
          })}
        </p>
      </div>
      <Button asChild variant="outline">
        <Link href={`/b/${businessId}/payables?to=me`}>
          {t('expenses.mine.details')}
          <ArrowRightIcon aria-hidden className="rtl:rotate-180" />
        </Link>
      </Button>
    </section>
  )
}

/** The Expenses page's "My expenses": what is owed to the member, then their own expenses. */
export function MineExpenses({ base }: { base: string }) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const list = useInfiniteQuery(
    trpc.expense.mine.infiniteQueryOptions({}, { getNextPageParam: (page) => page.nextCursor }),
  )
  const items = list.data?.pages.flatMap((page) => page.items) ?? []
  return (
    <div className="space-y-4">
      <OwedToMeCard />
      <p className="text-sm text-muted-foreground">{t('expenses.mine.intro')}</p>
      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError && !list.data ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        <ListEmpty
          icon={ReceiptIcon}
          title={t('expenses.mine.emptyTitle')}
          body={t('expenses.mine.emptyBody')}
        />
      ) : (
        <>
          <ul
            aria-label={t('expenses.list.tabs.mine')}
            className="divide-y overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]"
          >
            {items.map((expense) => (
              <li key={expense.id}>
                <MineRow expense={expense} href={`${base}/${expense.id}`} />
              </li>
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
      )}
    </div>
  )
}
