'use client'

import { useTRPC } from '@bizcost/app-core'
import type { QuotationListItemDto } from '@bizcost/contracts'
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import { FileTextIcon, PlusIcon, SearchXIcon } from 'lucide-react'
import Link from 'next/link'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslation } from 'react-i18next'
import { ModuleGate } from '@/components/shell/module-gate'
import { PageContainer } from '@/components/shell/page-container'
import { LoadError } from '@/components/states/query-state'
import { Button } from '@/components/ui/button'
import { ListEmpty, ListSkeleton } from '@/features/catalog/catalog-list'
import { NBSP } from '@/features/catalog/units'
import { useBusinessDate, useMoney } from '@/features/documents/amounts'
import { SearchBox } from '@/features/documents/search-box'
import { useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { QuotationStatusBadge } from './badges'
import { mayManageQuotations } from './data'

// Quotations (M3 Step 7; Q21–Q25): the latest revision of each, newest first, with its number, the
// customer, what it holds, its amount to pay and its status (a sent one past its validity shows as
// expired). The status filter and the search (a number, the customer's reference or name) live in the
// address, so a list can be shared or reopened as it was.

const STATUS_FILTERS = ['all', 'draft', 'sent', 'expired', 'accepted', 'declined'] as const
type StatusFilter = (typeof STATUS_FILTERS)[number]

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

/** What a quotation holds: "Wardrobe", "Wardrobe and 2 more". */
function useQuotationItems() {
  const { t } = useTranslation()
  return (quotation: Pick<QuotationListItemDto, 'lineTitles' | 'lineCount'>) => {
    const names = quotation.lineTitles.filter(Boolean)
    const more = quotation.lineCount - names.length
    if (names.length === 0) return t('documents.quotations.list.noLines')
    const joined = names.join(t('sales.list.namesSeparator'))
    return more > 0
      ? t('documents.quotations.list.moreLines', { names: joined, count: more })
      : joined
  }
}

function QuotationRow({ quotation, href }: { quotation: QuotationListItemDto; href: string }) {
  const { t } = useTranslation()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const itemsOf = useQuotationItems()
  const closed = quotation.listStatus === 'declined' || quotation.listStatus === 'superseded'
  return (
    <Link
      href={href}
      data-quotation-row={quotation.listStatus}
      className="flex items-start gap-3 px-4 py-3.5 transition-colors outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset sm:px-5"
    >
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-xl',
          closed ? 'bg-muted text-muted-foreground' : 'bg-accent text-primary',
        )}
      >
        <FileTextIcon aria-hidden className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 font-medium break-words">
            <bdi dir="ltr">{quotation.number}</bdi>
            {' · '}
            <bdi>{quotation.customerName}</bdi>
          </span>
          <QuotationStatusBadge status={quotation.listStatus} />
          {quotation.revision > 1 ? (
            <span className="text-xs text-muted-foreground">
              {t('documents.quotations.list.revision', { n: quotation.revision })}
            </span>
          ) : null}
        </span>
        <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
          <bdi>{itemsOf(quotation)}</bdi>
          {quotation.site ? (
            <>
              {' · '}
              <bdi>{quotation.site}</bdi>
            </>
          ) : null}
          {' · '}
          {businessDate(quotation.businessDate).replaceAll(' ', NBSP)}
          {quotation.validUntil && quotation.listStatus === 'sent' ? (
            <>
              {' · '}
              {t('documents.quotations.list.validUntil', {
                date: businessDate(quotation.validUntil).replaceAll(' ', NBSP),
              })}
            </>
          ) : null}
          {quotation.validUntil && quotation.listStatus === 'expired' ? (
            <>
              {' · '}
              <span className="font-medium text-destructive">
                {t('documents.quotations.list.expiredOn', {
                  date: businessDate(quotation.validUntil).replaceAll(' ', NBSP),
                })}
              </span>
            </>
          ) : null}
          {quotation.orderId ? <> · {t('documents.quotations.list.ordered')}</> : null}
          {quotation.enteredByName ? (
            <>
              {' · '}
              <bdi>{quotation.enteredByName}</bdi>
            </>
          ) : null}
        </span>
      </span>
      <span
        className={cn('shrink-0 pt-0.5 text-end font-medium', closed && 'text-muted-foreground')}
      >
        <bdi className="tabular-nums">{money(quotation.payable, quotation.currency)}</bdi>
      </span>
    </Link>
  )
}

function QuotationsList() {
  const { t } = useTranslation()
  const term = useTerminology()
  const trpc = useTRPC()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const { status, search, set } = useFilters()
  const list = useInfiniteQuery(
    trpc.quotation.list.infiniteQueryOptions(
      { status, search: search || undefined },
      { getNextPageParam: (page) => page.nextCursor, placeholderData: keepPreviousData },
    ),
  )
  if (!context) return null
  const canManage = mayManageQuotations(context)
  const profile = context.terminologyProfile
  const items = list.data?.pages.flatMap((page) => page.items) ?? []
  const filtered = status !== 'all' || search !== ''
  const firstTime = !filtered && list.isSuccess && !list.isPlaceholderData && items.length === 0
  const base = `/b/${businessId}/quotations`

  const newButton = canManage ? (
    <Button asChild size="lg">
      <Link href={`${base}/new`}>
        <PlusIcon aria-hidden />
        {t('documents.quotations.list.new')}
      </Link>
    </Button>
  ) : null

  return (
    <PageContainer>
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {t('common.nav.quotations')}
          </h1>
          <p className="mt-1.5 max-w-2xl text-muted-foreground">
            {term('documents.quotations.list.intro', profile)}
          </p>
        </div>
        {firstTime ? null : newButton}
      </header>
      {firstTime ? null : (
        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
          <SearchBox
            value={search}
            placeholder={t('documents.quotations.list.searchPlaceholder')}
            onChange={(next) => set({ search: next })}
          />
          {/* A fieldset is never narrower than its content unless told so (min-w-0): on a phone
              the six filters scroll sideways inside it instead of widening the page. */}
          <fieldset className="-mx-1 flex min-w-0 shrink-0 overflow-x-auto px-1 pb-1 lg:mx-0 lg:overflow-visible lg:px-0 lg:pb-0">
            <legend className="sr-only">{t('documents.quotations.list.statusLabel')}</legend>
            <div className="flex min-w-full rounded-lg bg-muted p-1">
              {STATUS_FILTERS.map((value) => (
                <label key={value} className="relative flex-1 lg:flex-none">
                  <input
                    type="radio"
                    name="quotation-status"
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
                    {t(`documents.quotations.list.filters.${value}`)}
                  </span>
                </label>
              ))}
            </div>
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
            title={t('documents.quotations.list.noMatches')}
            body={t('documents.quotations.list.noMatchesHint')}
          />
        ) : (
          <ListEmpty
            icon={FileTextIcon}
            title={t('documents.quotations.list.empty.title')}
            body={
              canManage
                ? term('documents.quotations.list.empty.body', profile)
                : t('documents.quotations.list.empty.viewer')
            }
          >
            {newButton}
          </ListEmpty>
        )
      ) : (
        <div className="space-y-5">
          <ul
            aria-label={t('common.nav.quotations')}
            className="divide-y overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]"
          >
            {items.map((quotation) => (
              <li key={quotation.id}>
                <QuotationRow quotation={quotation} href={`${base}/${quotation.id}`} />
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
        </div>
      )}
    </PageContainer>
  )
}

/** The Quotations page: the list inside the module's gate. */
export function QuotationsPage() {
  return (
    <ModuleGate moduleId="quotations" entryId="quotations">
      <QuotationsList />
    </ModuleGate>
  )
}
