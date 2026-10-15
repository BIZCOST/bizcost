'use client'

import { useTRPC } from '@bizcost/app-core'
import type { ImportListItemDto } from '@bizcost/contracts'
import { useInfiniteQuery } from '@tanstack/react-query'
import { FileSpreadsheetIcon, FileUpIcon } from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useTranslation } from 'react-i18next'
import { LoadError } from '@/components/states/query-state'
import { Button } from '@/components/ui/button'
import { ListEmpty, ListSkeleton } from '@/features/catalog/catalog-list'
import { useBusinessDate, useMoney } from '@/features/documents/amounts'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { importHref } from './data'
import { ImportStatus } from './import-view'
import { Templates } from './import-new'

// The Imports list on the Sales page (M3 Step 4): each file imported, newest first, with its channel,
// branch (with branches), days, status and what its finalized sales came to before VAT (one's own, or
// every one's for a member who sees every sale). A draft opens where its names are settled; a
// finalized one shows its days, each reversed on its own or all together.

function ImportRow({ item, vatShown }: { item: ImportListItemDto; vatShown: boolean }) {
  const { t } = useTranslation()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  return (
    <Link
      href={importHref(businessId, item.id)}
      data-import-row={item.status}
      className="flex items-start gap-3 px-4 py-3.5 transition-colors outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset sm:px-5"
    >
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-xl',
          item.status === 'reversed' ? 'bg-muted text-muted-foreground' : 'bg-accent text-primary',
        )}
      >
        <FileSpreadsheetIcon aria-hidden className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span dir="auto" className="min-w-0 text-start font-medium break-all">
            {item.fileName}
          </span>
          <ImportStatus status={item.status} />
        </span>
        <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
          <bdi>{item.channelName}</bdi>
          {context?.capabilities.multi_location ? (
            <>
              {' · '}
              <bdi>{item.locationName}</bdi>
            </>
          ) : null}
          {' · '}
          {item.periodFrom === item.periodTo
            ? businessDate(item.periodTo)
            : t('sales.import.summary.daysRange', {
                from: businessDate(item.periodFrom),
                to: businessDate(item.periodTo),
              })}
          {item.enteredByName ? (
            <>
              {' · '}
              <bdi>{item.enteredByName}</bdi>
            </>
          ) : null}
        </span>
        {item.status !== 'draft' ? (
          <span className="mt-0.5 block text-sm text-muted-foreground">
            {t('sales.import.list.days', { count: item.daysPosted })}
            {item.daysReversed > 0 ? (
              <> · {t('sales.import.list.daysReversed', { count: item.daysReversed })}</>
            ) : null}
          </span>
        ) : (
          <span className="mt-0.5 block text-sm text-warning">
            {t('sales.import.list.continue')}
          </span>
        )}
      </span>
      {item.netTotal !== null ? (
        <span className="shrink-0 pt-0.5 text-end font-medium">
          <bdi className="tabular-nums">{money(item.netTotal)}</bdi>
          {vatShown ? (
            <span className="block text-xs font-normal text-muted-foreground">
              {t('sales.list.beforeVat')}
            </span>
          ) : null}
        </span>
      ) : null}
    </Link>
  )
}

/** The imports the member may see (theirs, or every one with "see every sale"), newest first. */
export function ImportsList() {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const list = useInfiniteQuery(
    trpc.saleImport.list.infiniteQueryOptions(
      { status: 'all' },
      { getNextPageParam: (page) => page.nextCursor },
    ),
  )
  const items = list.data?.pages.flatMap((page) => page.items) ?? []
  const vatShown = context?.capabilities.vat_registered === true
  if (list.isPending) return <ListSkeleton />
  if (list.isError && !list.data) {
    return <LoadError error={list.error} onRetry={() => void list.refetch()} />
  }
  if (items.length === 0) {
    return (
      <ListEmpty
        icon={FileUpIcon}
        title={t('sales.import.list.empty')}
        body={t('sales.import.list.emptyBody')}
      >
        <div className="flex flex-col items-center gap-4">
          <Button asChild size="lg">
            <Link href={`/b/${businessId}/sales/import`}>
              <FileUpIcon aria-hidden />
              {t('sales.import.start')}
            </Link>
          </Button>
          <Templates kinds={['daily', 'lines']} />
        </div>
      </ListEmpty>
    )
  }
  return (
    <div className="space-y-4">
      <ul
        aria-label={t('sales.import.list.title')}
        className="divide-y overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]"
      >
        {items.map((item) => (
          <li key={item.id}>
            <ImportRow item={item} vatShown={vatShown} />
          </li>
        ))}
      </ul>
      {list.hasNextPage ? (
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
  )
}
