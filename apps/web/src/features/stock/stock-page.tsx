'use client'

import { useTRPC } from '@bizcost/app-core'
import type { StockItemDto } from '@bizcost/contracts'
import { compareDecimal } from '@bizcost/domain'
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import { ClipboardListIcon, PlusIcon, SearchXIcon, WarehouseIcon } from 'lucide-react'
import Link from 'next/link'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ModuleGate } from '@/components/shell/module-gate'
import { PageContainer } from '@/components/shell/page-container'
import { LoadError } from '@/components/states/query-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { ListEmpty, ListSkeleton } from '@/features/catalog/catalog-list'
import { Money, useBusinessDate } from '@/features/documents/amounts'
import { SearchBox } from '@/features/documents/search-box'
import { useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { CountsList } from './counts-page'
import { readStockFilters, writeFilters, type StockFilters } from './count-filters'
import {
  mayManageCounts,
  maySeeStock,
  mayStartTracking,
  useBooks,
  useStockBranches,
  type StockBranch,
} from './data'
import { NewCountSheet, StartTrackingSheet } from './pick-sheets'
import { StockQty } from './quantity'
import { StockHeader } from './stock-header'

// Stock (M4 Step 2; D-339 Q2, Q3): the materials whose stock is tracked (from their first count), with
// on hand in each of the member's branches said in words ("12 cartons + 3 bottles (147 L)"), what it
// is worth (a lock without the costs switch), and the last count; a branch filter and a search kept in
// the address. Before anything is tracked, the page says what tracking means and lets a manager who
// works in every branch start it. A member who only counts (blind, Q6) sees the counts waiting for
// them instead.

function useFilters() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const filters = readStockFilters(params)
  const set = (next: Partial<StockFilters>) => {
    const query = writeFilters(params, next)
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }
  return { filters, set }
}

/** One branch's stock of an item: on hand, and its last count there. */
function BranchLine({
  item,
  branch,
}: {
  item: StockItemDto
  branch: StockItemDto['branches'][number]
}) {
  const { t } = useTranslation()
  const businessDate = useBusinessDate()
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
      <span className="min-w-0">
        <bdi className="font-medium">{branch.locationName}</bdi>
        <span className="text-muted-foreground">: </span>
        <StockQty material={item.material} qty={branch.onHand} />
      </span>
      <span className="text-xs text-muted-foreground">
        {branch.lastCountedOn
          ? t('stock.onHand.lastCounted', { date: businessDate(branch.lastCountedOn) })
          : t('stock.onHand.notCountedHere')}
      </span>
    </li>
  )
}

/** One tracked item: on hand in words, what it is worth, and per branch with branches. */
function StockRow({
  item,
  href,
  perBranch,
}: {
  item: StockItemDto
  href: string
  /** Say each branch's stock (a member who sees more than one). */
  perBranch: boolean
}) {
  const { t } = useTranslation()
  const businessDate = useBusinessDate()
  const below = compareDecimal(item.onHand, '0') < 0
  const lastCounted = item.branches
    .map((branch) => branch.lastCountedOn)
    .filter((day): day is string => day !== null)
    .sort()
    .at(-1)
  return (
    <div data-stock-row={item.material.id} className="px-4 py-3.5 sm:px-5">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-primary">
          <WarehouseIcon aria-hidden className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link
              href={href}
              className="min-w-0 font-medium break-words text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring"
            >
              <bdi>{item.material.name}</bdi>
            </Link>
            {below ? <Badge tone="danger">{t('stock.onHand.belowZero')}</Badge> : null}
          </div>
          <p className="mt-1 text-sm leading-relaxed">
            <StockQty material={item.material} qty={item.onHand} />
          </p>
          {!perBranch ? (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {lastCounted
                ? t('stock.onHand.lastCounted', { date: businessDate(lastCounted) })
                : t('stock.onHand.trackedFrom', { date: businessDate(item.trackedFrom) })}
            </p>
          ) : null}
        </div>
        <div className="shrink-0 text-end">
          <p className="text-xs text-muted-foreground">{t('stock.onHand.worth')}</p>
          <p data-stock-value className="font-medium">
            {item.value === null ? (
              <span className="text-sm font-normal text-muted-foreground">
                {t('stock.onHand.noPrice')}
              </span>
            ) : (
              <Money value={item.value} category="cost" />
            )}
          </p>
        </div>
      </div>
      {perBranch ? (
        <ul className="mt-2 space-y-1 border-t pt-2 sm:ms-13" aria-label={item.material.name}>
          {item.branches.map((branch) => (
            <BranchLine key={branch.locationId} item={item} branch={branch} />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** Nothing tracked yet: what tracking means, and the way to start it (or who can). */
function StartTracking({ onStart }: { onStart: () => void }) {
  const { t } = useTranslation()
  const term = useTerminology()
  const { data: context } = useBusinessContext()
  if (!context) return null
  const manages = mayManageCounts(context)
  const starts = mayStartTracking(context)
  return (
    <ListEmpty
      icon={WarehouseIcon}
      title={t('stock.onHand.empty.title')}
      body={
        manages
          ? term('stock.onHand.empty.body', context.terminologyProfile)
          : t('stock.onHand.empty.viewer')
      }
    >
      {manages ? (
        <div className="flex max-w-md flex-col items-center gap-4">
          <p className="text-sm text-muted-foreground">
            {term('stock.onHand.empty.untracked', context.terminologyProfile)}
          </p>
          {starts ? (
            <Button size="lg" onClick={onStart}>
              <PlusIcon aria-hidden />
              {t('stock.onHand.empty.action')}
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">{t('stock.onHand.empty.everyBranch')}</p>
          )}
        </div>
      ) : null}
    </ListEmpty>
  )
}

function FilterBar({
  filters,
  branches,
  onChange,
}: {
  filters: StockFilters
  branches: readonly StockBranch[]
  onChange: (next: Partial<StockFilters>) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
      <SearchBox
        value={filters.search}
        placeholder={t('stock.onHand.searchPlaceholder')}
        onChange={(search) => onChange({ search })}
      />
      {branches.length > 1 ? (
        <div className="flex flex-col gap-1 sm:w-64">
          <label htmlFor={`${id}-branch`} className="text-sm text-muted-foreground">
            {t('stock.onHand.branch')}
          </label>
          <NativeSelect
            id={`${id}-branch`}
            value={filters.locationId ?? ''}
            onChange={(event) => onChange({ locationId: event.target.value || null })}
          >
            <option value="">{t('stock.onHand.allBranches')}</option>
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : null}
    </div>
  )
}

function OnHand() {
  const { t } = useTranslation()
  const term = useTerminology()
  const trpc = useTRPC()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const { filters, set } = useFilters()
  const books = useBooks()
  const { branches } = useStockBranches(context)
  const [sheet, setSheet] = useState<'start' | 'count' | null>(null)
  const list = useInfiniteQuery(
    trpc.stock.list.infiniteQueryOptions(
      { locationId: filters.locationId ?? undefined, search: filters.search || undefined },
      { getNextPageParam: (page) => page.data.nextCursor, placeholderData: keepPreviousData },
    ),
  )
  if (!context) return null
  const items = list.data?.pages.flatMap((page) => page.data.items) ?? []
  const filtered = filters.locationId !== null || filters.search !== ''
  const nothingTracked =
    !filtered && list.isSuccess && !list.isPlaceholderData && items.length === 0
  const manages = mayManageCounts(context)
  const base = `/b/${businessId}/stock`
  const perBranch = branches.length > 1 && filters.locationId === null
  const today = books.data?.today
  const actions =
    manages && !nothingTracked && today ? (
      <>
        {mayStartTracking(context) ? (
          <Button variant="outline" onClick={() => setSheet('start')}>
            <PlusIcon aria-hidden />
            {t('stock.onHand.startMore')}
          </Button>
        ) : null}
        <Button onClick={() => setSheet('count')}>
          <ClipboardListIcon aria-hidden />
          {t('stock.onHand.newCount')}
        </Button>
      </>
    ) : null

  return (
    <PageContainer>
      <StockHeader
        current="onHand"
        intro={term('stock.onHand.intro', context.terminologyProfile)}
        actions={actions}
      />
      {nothingTracked ? null : <FilterBar filters={filters} branches={branches} onChange={set} />}
      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError && !list.data ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        filtered ? (
          <ListEmpty
            icon={SearchXIcon}
            title={t('stock.onHand.noMatches')}
            body={t('stock.onHand.noMatchesHint')}
          />
        ) : (
          <StartTracking onStart={() => setSheet('start')} />
        )
      ) : (
        <div className="space-y-4">
          {list.data?.pages.some((page) => page.meta.redacted.length > 0) ? (
            <p className="text-sm text-muted-foreground">{t('stock.onHand.lockedNote')}</p>
          ) : null}
          <ul
            aria-label={t('common.nav.stock')}
            className="divide-y overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]"
          >
            {items.map((item) => (
              <li key={item.material.id}>
                <StockRow item={item} href={`${base}/${item.material.id}`} perBranch={perBranch} />
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
      {sheet === 'start' && books.data ? (
        <StartTrackingSheet
          today={books.data.today}
          closedThrough={books.data.closedThrough}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === 'count' && books.data ? (
        <NewCountSheet
          today={books.data.today}
          closedThrough={books.data.closedThrough}
          initialBranch={filters.locationId}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </PageContainer>
  )
}

/** The Stock page: on hand for a member who sees stock; the counts waiting for one who only counts. */
function Stock() {
  const { data: context } = useBusinessContext()
  if (!context) return null
  return maySeeStock(context) ? <OnHand /> : <CountsList />
}

/** The Stock page, inside the module's gate (turned off, or not open to the member). */
export function StockPage() {
  return (
    <ModuleGate moduleId="inventory" entryId="stock">
      <Stock />
    </ModuleGate>
  )
}
