'use client'

import { useTRPC } from '@bizcost/app-core'
import type { CountListItemDto } from '@bizcost/contracts'
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import { ClipboardListIcon, PlusIcon, SearchXIcon } from 'lucide-react'
import Link from 'next/link'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ModuleGate } from '@/components/shell/module-gate'
import { PageContainer } from '@/components/shell/page-container'
import { LoadError } from '@/components/states/query-state'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { ListEmpty, ListSkeleton } from '@/features/catalog/catalog-list'
import { useBusinessDate } from '@/features/documents/amounts'
import { StatusBadge } from '@/features/documents/status-badge'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import {
  COUNT_STATUS_FILTERS,
  countListInput,
  countsFiltered,
  readCountFilters,
  writeFilters,
  type CountFilters,
} from './count-filters'
import {
  hasBranches,
  mayManageCounts,
  maySeeStock,
  mayStartTracking,
  useBooks,
  useStockBranches,
  type StockBranch,
} from './data'
import { NewCountSheet, StartTrackingSheet } from './pick-sheets'
import { StockHeader } from './stock-header'

// Counts (M4 Step 2; D-339 Q5, Q6): drafts, finalized and reversed counts and first counts, newest day
// first, with filters kept in the address (status, kind, branch). Drafts are listed to whoever fills
// or manages counts, finalized and reversed ones to whoever sees stock (the API lists only those). A
// row opens the count: a draft's sheet, or the count as it was finalized. A member who only counts
// has no filters (the address's are left alone: never "No counts match" with nothing to clear).

/** No filter: every count the member may see. */
const NO_FILTERS: CountFilters = { status: 'all', kind: null, locationId: null }

function useFilters() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const filters = readCountFilters(params)
  const set = (next: Partial<CountFilters>) => {
    const query = writeFilters(params, next)
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }
  return { filters, set }
}

function FilterBar({
  filters,
  branches,
  onChange,
}: {
  filters: CountFilters
  branches: readonly StockBranch[]
  onChange: (next: Partial<CountFilters>) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  return (
    <div className="mb-4 space-y-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
        <fieldset className="flex shrink-0 rounded-lg bg-muted p-1">
          <legend className="sr-only">{t('stock.counts.filters.status')}</legend>
          {COUNT_STATUS_FILTERS.map((value) => (
            <label key={value} className="relative flex-1 lg:flex-none">
              <input
                type="radio"
                name={`${id}-status`}
                value={value}
                checked={filters.status === value}
                onChange={() => onChange({ status: value })}
                className="peer sr-only"
              />
              <span
                className={cn(
                  'flex h-9 cursor-pointer items-center justify-center rounded-md px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors',
                  'peer-checked:bg-card peer-checked:text-foreground peer-checked:shadow-sm',
                  'peer-focus-visible:ring-3 peer-focus-visible:ring-ring',
                )}
              >
                {t(`stock.counts.filters.${value}`)}
              </span>
            </label>
          ))}
        </fieldset>
        <div className="grid grid-cols-2 gap-3 lg:flex lg:flex-1 lg:justify-end">
          <div className="flex min-w-0 flex-col gap-1 lg:w-48">
            <label htmlFor={`${id}-kind`} className="text-sm text-muted-foreground">
              {t('stock.counts.filters.kind')}
            </label>
            <NativeSelect
              id={`${id}-kind`}
              value={filters.kind ?? ''}
              onChange={(event) =>
                onChange({ kind: (event.target.value || null) as CountFilters['kind'] })
              }
            >
              <option value="">{t('stock.counts.filters.anyKind')}</option>
              <option value="opening">{t('stock.kinds.opening')}</option>
              <option value="count">{t('stock.kinds.count')}</option>
            </NativeSelect>
          </div>
          {branches.length > 1 ? (
            <div className="flex min-w-0 flex-col gap-1 lg:w-56">
              <label htmlFor={`${id}-branch`} className="text-sm text-muted-foreground">
                {t('stock.counts.filters.branch')}
              </label>
              <NativeSelect
                id={`${id}-branch`}
                value={filters.locationId ?? ''}
                onChange={(event) => onChange({ locationId: event.target.value || null })}
              >
                <option value="">{t('stock.counts.filters.anyBranch')}</option>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ) : null}
        </div>
      </div>
      {countsFiltered(filters) ? (
        <Button
          variant="link"
          className="h-auto px-0"
          onClick={() => onChange({ status: 'all', kind: null, locationId: null })}
        >
          {t('stock.counts.filters.clear')}
        </Button>
      ) : null}
    </div>
  )
}

/** One count: its kind and day, its branch (with branches), how far a draft got, its status. */
function CountRow({
  count,
  href,
  branches,
}: {
  count: CountListItemDto
  href: string
  branches: boolean
}) {
  const { t } = useTranslation()
  const businessDate = useBusinessDate()
  const where = count.kind === 'opening' ? t('stock.counts.everyBranch') : count.locationName
  return (
    <Link
      href={href}
      data-count-row={count.id}
      className="flex items-start gap-3 px-4 py-3.5 transition-colors outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset sm:px-5"
    >
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-xl',
          count.status === 'reversed' ? 'bg-muted text-muted-foreground' : 'bg-accent text-primary',
        )}
      >
        <ClipboardListIcon aria-hidden className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 font-medium">
            {t(`stock.kinds.${count.kind}`)} · {businessDate(count.businessDate)}
          </span>
          <StatusBadge status={count.status} kind="count" />
        </span>
        <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
          {branches && where ? (
            <>
              <bdi>{where}</bdi>
              {' · '}
            </>
          ) : null}
          {t('stock.counts.progress', { counted: count.countedCount, total: count.lineCount })}
          {count.note ? (
            <>
              {' · '}
              <bdi dir="auto">{count.note}</bdi>
            </>
          ) : null}
        </span>
      </span>
    </Link>
  )
}

/** The counts list (the Counts page, and the Stock page of a member who only counts). */
export function CountsList() {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const address = useFilters()
  const books = useBooks()
  const { branches, anyTracked } = useStockBranches(context)
  const [sheet, setSheet] = useState<'start' | 'count' | null>(null)
  const sees = context !== undefined && maySeeStock(context)
  const filters = sees ? address.filters : NO_FILTERS
  const list = useInfiniteQuery({
    ...trpc.count.list.infiniteQueryOptions(countListInput(filters), {
      getNextPageParam: (page) => page.nextCursor,
      placeholderData: keepPreviousData,
    }),
    enabled: context !== undefined,
  })
  if (!context) return null
  const manages = mayManageCounts(context)
  const items = list.data?.pages.flatMap((page) => page.items) ?? []
  const filtered = countsFiltered(filters)
  const base = `/b/${businessId}/stock/counts`
  const actions =
    manages && books.data ? (
      anyTracked ? (
        <Button onClick={() => setSheet('count')}>
          <ClipboardListIcon aria-hidden />
          {t('stock.counts.new')}
        </Button>
      ) : anyTracked === false && mayStartTracking(context) ? (
        <Button onClick={() => setSheet('start')}>
          <PlusIcon aria-hidden />
          {t('stock.onHand.empty.action')}
        </Button>
      ) : null
    ) : null

  return (
    <PageContainer>
      <StockHeader
        current="counts"
        intro={sees ? t('stock.counts.intro') : t('stock.counts.introCounter')}
        actions={actions}
      />
      {sees ? <FilterBar filters={filters} branches={branches} onChange={address.set} /> : null}
      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError && !list.data ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        filtered ? (
          <ListEmpty
            icon={SearchXIcon}
            title={t('stock.counts.filters.noMatches')}
            body={t('stock.counts.filters.noMatchesHint')}
          />
        ) : (
          <ListEmpty
            icon={ClipboardListIcon}
            title={t('stock.counts.empty.title')}
            body={manages ? t('stock.counts.empty.body') : t('stock.counts.empty.counter')}
          >
            {actions}
          </ListEmpty>
        )
      ) : (
        <div className="space-y-4">
          <ul
            aria-label={t('stock.tabs.counts')}
            className="divide-y overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]"
          >
            {items.map((count) => (
              <li key={count.id}>
                <CountRow
                  count={count}
                  href={`${base}/${count.id}`}
                  branches={hasBranches(context)}
                />
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

/** The Counts page, inside the module's gate. */
export function CountsPage() {
  return (
    <ModuleGate moduleId="inventory" entryId="stock">
      <CountsList />
    </ModuleGate>
  )
}
