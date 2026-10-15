'use client'

import { useTRPC } from '@bizcost/app-core'
import type { OrderListItemDto } from '@bizcost/contracts'
import { compareDecimal, ORDER_STATUSES, type OrderStatus } from '@bizcost/domain'
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import { ClipboardListIcon, PlusIcon, SearchXIcon } from 'lucide-react'
import Link from 'next/link'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslation } from 'react-i18next'
import { ModuleGate } from '@/components/shell/module-gate'
import { PageContainer } from '@/components/shell/page-container'
import { LoadError } from '@/components/states/query-state'
import { Button } from '@/components/ui/button'
import { ListEmpty, ListSkeleton } from '@/features/catalog/catalog-list'
import { NBSP } from '@/features/catalog/units'
import { useBusinessDate, useBusinessWeekday, useMoney } from '@/features/documents/amounts'
import { SearchBox } from '@/features/documents/search-box'
import { useBooks } from '@/features/sales/data'
import { useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { CustomerRef, OrderStatusBadge, PaymentBadge } from './badges'
import { mayEnterOrders } from './data'

// Orders (M3 Step 5; Q16, Q19 "Orders / الطلبات" in every wording; D-265): those still waiting first,
// by when they are due (late ones said so), then delivered and cancelled ones, newest first. Each with
// its number, customer, what was ordered, its total and, apart from its status, how it is paid. The
// search finds an order's number, the customer's LPO and the customer's name; the status and the
// search live in the address. A member without "see every order" sees only their own (the API).

type StatusFilter = 'all' | OrderStatus
const STATUS_FILTERS: readonly StatusFilter[] = ['all', ...ORDER_STATUSES]

function useFilters() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const statusParam = params.get('status')
  const status: StatusFilter = (STATUS_FILTERS as readonly (string | null)[]).includes(statusParam)
    ? (statusParam as StatusFilter)
    : 'all'
  const search = (params.get('q') ?? '').trim()
  const set = (next: { status?: StatusFilter; search?: string }) => {
    const query = new URLSearchParams(params.toString())
    if (next.status !== undefined) {
      if (next.status === 'all') query.delete('status')
      else query.set('status', next.status)
    }
    if (next.search !== undefined) {
      if (next.search.trim()) query.set('q', next.search.trim())
      else query.delete('q')
    }
    const text = query.toString()
    router.replace(text ? `${pathname}?${text}` : pathname, { scroll: false })
  }
  return { status, search, set }
}

/** What an order holds: "Chocolate cake", "Wardrobe and 2 more". */
export function useOrderItems() {
  const { t } = useTranslation()
  return (order: Pick<OrderListItemDto, 'itemNames' | 'lineCount'>) => {
    const names = order.itemNames.filter(Boolean)
    const more = order.lineCount - names.length
    if (names.length === 0) return t('orders.list.noItems')
    const joined = names.join(t('sales.list.namesSeparator'))
    return more > 0 ? t('sales.list.moreItems', { names: joined, count: more }) : joined
  }
}

/** One order in the list. */
export function OrderRow({
  order,
  href,
  today,
}: {
  order: OrderListItemDto
  href: string
  today: string | undefined
}) {
  const { t } = useTranslation()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const weekday = useBusinessWeekday()
  const itemsOf = useOrderItems()
  const late =
    order.status === 'pending' &&
    order.dueDate !== null &&
    today !== undefined &&
    order.dueDate < today
  const owes = order.owed !== null && compareDecimal(order.owed, '0') > 0
  return (
    <Link
      href={href}
      data-order-row={order.status}
      className="flex items-start gap-3 px-4 py-3.5 transition-colors outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset sm:px-5"
    >
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-xl',
          order.status === 'cancelled'
            ? 'bg-muted text-muted-foreground'
            : 'bg-accent text-primary',
        )}
      >
        <ClipboardListIcon aria-hidden className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 font-medium break-words">
            <bdi dir="ltr">{order.number}</bdi>
            {order.customerName ? (
              <>
                {' · '}
                <bdi>{order.customerName}</bdi>
              </>
            ) : null}
          </span>
          <OrderStatusBadge status={order.status} />
          {order.paymentState ? (
            <PaymentBadge
              state={order.paymentState}
              pending={order.status === 'pending'}
              cancelled={order.status === 'cancelled'}
            />
          ) : null}
        </span>
        <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
          <bdi>{itemsOf(order)}</bdi>
          {order.status === 'pending' && order.dueDate ? (
            <>
              {' · '}
              <span className={late ? 'font-medium text-destructive' : undefined}>
                {t(late ? 'orders.list.late' : 'orders.list.due', {
                  date: weekday(order.dueDate, today).replaceAll(' ', NBSP),
                })}
              </span>
            </>
          ) : order.status === 'delivered' && order.deliveredOn ? (
            <>
              {' · '}
              {t('orders.list.deliveredOn', { date: businessDate(order.deliveredOn) })}
            </>
          ) : null}
          {order.customerRef ? (
            <>
              {' · '}
              <CustomerRef value={order.customerRef} />
            </>
          ) : null}
          {order.enteredByName ? (
            <>
              {' · '}
              <bdi>{order.enteredByName}</bdi>
            </>
          ) : null}
        </span>
      </span>
      <span
        className={cn(
          'shrink-0 pt-0.5 text-end font-medium',
          order.status === 'cancelled' && 'text-muted-foreground line-through',
        )}
      >
        <bdi className="tabular-nums">{money(order.total, order.currency)}</bdi>
        {owes ? (
          <span className="block text-xs font-normal text-muted-foreground no-underline">
            {t('orders.list.owes', { amount: money(order.owed!, order.currency) })}
          </span>
        ) : null}
      </span>
    </Link>
  )
}

function OrdersList() {
  const { t } = useTranslation()
  const term = useTerminology()
  const trpc = useTRPC()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const { status, search, set } = useFilters()
  const books = useBooks()
  const list = useInfiniteQuery(
    trpc.order.list.infiniteQueryOptions(
      { status, search: search || undefined },
      { getNextPageParam: (page) => page.nextCursor, placeholderData: keepPreviousData },
    ),
  )
  if (!context) return null
  const canEnter = mayEnterOrders(context)
  const profile = context.terminologyProfile
  const items = list.data?.pages.flatMap((page) => page.items) ?? []
  const filtered = status !== 'all' || search !== ''
  const firstTime = !filtered && list.isSuccess && !list.isPlaceholderData && items.length === 0
  const base = `/b/${businessId}/orders`
  const today = books.data?.today
  const waiting = items.filter((order) => order.status === 'pending')
  const done = items.filter((order) => order.status !== 'pending')
  const sections =
    status === 'all'
      ? [
          { id: 'waiting', title: t('orders.list.waiting'), orders: waiting },
          { id: 'done', title: t('orders.list.done'), orders: done },
        ].filter((section) => section.orders.length > 0)
      : [{ id: status, title: null, orders: items }]

  const newButton = canEnter ? (
    <Button asChild size="lg">
      <Link href={`${base}/new`}>
        <PlusIcon aria-hidden />
        {t('common.nav.new_order')}
      </Link>
    </Button>
  ) : null

  return (
    <PageContainer>
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {t('common.nav.orders')}
          </h1>
          <p className="mt-1.5 max-w-2xl text-muted-foreground">
            {term('orders.list.intro', profile)}
          </p>
        </div>
        {firstTime ? null : newButton}
      </header>
      {firstTime ? null : (
        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
          <SearchBox
            value={search}
            placeholder={term('orders.list.searchPlaceholder', profile)}
            onChange={(next) => set({ search: next })}
          />
          <fieldset className="flex shrink-0 rounded-lg bg-muted p-1">
            <legend className="sr-only">{t('orders.list.statusLabel')}</legend>
            {STATUS_FILTERS.map((value) => (
              <label key={value} className="relative flex-1 lg:flex-none">
                <input
                  type="radio"
                  name="order-status"
                  value={value}
                  checked={status === value}
                  onChange={() => set({ status: value })}
                  className="peer sr-only"
                />
                <span
                  className={cn(
                    'flex h-9 cursor-pointer items-center justify-center rounded-md px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors',
                    'peer-checked:bg-card peer-checked:text-foreground peer-checked:shadow-sm',
                    'peer-focus-visible:ring-3 peer-focus-visible:ring-ring',
                    'after:absolute after:inset-x-0 after:-inset-y-1 after:content-[""]',
                  )}
                >
                  {t(`orders.list.filters.${value}`)}
                </span>
              </label>
            ))}
          </fieldset>
        </div>
      )}
      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError && !list.data ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        filtered ? (
          <ListEmpty
            icon={SearchXIcon}
            title={t('orders.list.noMatches')}
            body={t('orders.list.noMatchesHint')}
          />
        ) : (
          <ListEmpty
            icon={ClipboardListIcon}
            title={t('orders.list.empty.title')}
            body={
              canEnter ? term('orders.list.empty.body', profile) : t('orders.list.empty.viewer')
            }
          >
            {newButton}
          </ListEmpty>
        )
      ) : (
        <div className="space-y-5">
          {sections.map((section) => (
            <section key={section.id} aria-labelledby={`orders-${section.id}`}>
              {section.title ? (
                <h2 id={`orders-${section.id}`} className="mb-2 px-1 font-semibold">
                  {section.title}
                </h2>
              ) : null}
              <ul
                aria-labelledby={section.title ? `orders-${section.id}` : undefined}
                aria-label={section.title ? undefined : t('common.nav.orders')}
                className="divide-y overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]"
              >
                {section.orders.map((order) => (
                  <li key={order.id}>
                    <OrderRow order={order} href={`${base}/${order.id}`} today={today} />
                  </li>
                ))}
              </ul>
            </section>
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
    </PageContainer>
  )
}

/** The Orders page: the list inside the module's gate. */
export function OrdersPage() {
  return (
    <ModuleGate moduleId="orders" entryId="orders">
      <OrdersList />
    </ModuleGate>
  )
}
