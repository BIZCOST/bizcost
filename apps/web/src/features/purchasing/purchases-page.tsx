'use client'

import { useTRPC } from '@bizcost/app-core'
import type { PurchaseListItemDto } from '@bizcost/contracts'
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  ChevronDownIcon,
  PlusIcon,
  ReceiptTextIcon,
  SearchXIcon,
  SlidersHorizontalIcon,
} from 'lucide-react'
import Link from 'next/link'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FormAlert } from '@/components/form/form-alert'
import { ModuleGate } from '@/components/shell/module-gate'
import { PageContainer } from '@/components/shell/page-container'
import { LoadError } from '@/components/states/query-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { ListEmpty, ListSkeleton } from '@/features/catalog/catalog-list'
import { NBSP } from '@/features/catalog/units'
import { Money, useBusinessDate } from '@/features/documents/amounts'
import { SearchBox } from '@/features/documents/search-box'
import { StatusBadge } from '@/features/documents/status-badge'
import { can } from '@/features/settings/sections'
import { useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { useSupplierOptions } from './data'
import {
  isFiltered,
  listInput,
  PURCHASE_STATUS_FILTERS,
  readPurchaseFilters,
  writePurchaseFilters,
  type PurchaseFilters,
} from './purchase-filters'

// Purchases (M2 Step 3; D-114, D-134): the business's purchases, newest day first, with filters kept
// in the address (status, supplier, days, a search in the reference or the supplier's name). A row
// opens the purchase: a draft in its editor, a final or reversed one as it was recorded. Everyone
// with purchases.documents.view sees the list; purchases.documents.manage adds purchases. Totals are
// supplier prices: a member who may not see them sees a lock (redaction).

function useFilters() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const filters = readPurchaseFilters(params)
  const set = (next: Partial<PurchaseFilters>) => {
    const query = writePurchaseFilters(params, next)
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }
  return { filters, set }
}

/** The filters: a search, the status, the supplier (for members who see suppliers) and the days. */
function FilterBar({
  filters,
  onChange,
}: {
  filters: PurchaseFilters
  onChange: (next: Partial<PurchaseFilters>) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const { data: context } = useBusinessContext()
  const { enabled: canSeeSuppliers, suppliers } = useSupplierOptions(context)
  // On a phone the supplier and the days fold away under one button (open while one is set).
  const narrowing = [filters.supplierId, filters.from, filters.to].filter(Boolean).length
  const [open, setOpen] = useState(narrowing > 0)
  return (
    <div className="mb-4 space-y-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <SearchBox
          value={filters.search}
          placeholder={t('purchasing.purchases.searchPlaceholder')}
          onChange={(search) => onChange({ search })}
        />
        <fieldset className="flex shrink-0 rounded-lg bg-muted p-1">
          <legend className="sr-only">{t('purchasing.purchases.filters.status')}</legend>
          {PURCHASE_STATUS_FILTERS.map((value) => (
            <label key={value} className="relative flex-1 lg:flex-none">
              <input
                type="radio"
                name="purchase-status"
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
                  'after:absolute after:inset-x-0 after:-inset-y-1 after:content-[""]',
                )}
              >
                {t(`purchasing.purchases.filters.${value}`)}
              </span>
            </label>
          ))}
        </fieldset>
      </div>
      <Button
        type="button"
        variant="outline"
        aria-expanded={open}
        aria-controls={`${id}-more`}
        onClick={() => setOpen((value) => !value)}
        className="sm:hidden"
      >
        <SlidersHorizontalIcon aria-hidden />
        {t('purchasing.purchases.filters.more')}
        {narrowing > 0 ? (
          <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground tabular-nums">
            {narrowing}
          </span>
        ) : null}
        <ChevronDownIcon aria-hidden className={cn('transition-transform', open && 'rotate-180')} />
      </Button>
      <div
        id={`${id}-more`}
        className={cn(
          'grid grid-cols-2 items-end gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]',
          !open && 'max-sm:hidden',
        )}
      >
        {canSeeSuppliers ? (
          <div className="col-span-2 flex flex-col gap-1 sm:col-span-1">
            <label htmlFor={`${id}-supplier`} className="text-sm text-muted-foreground">
              {t('purchasing.purchases.filters.supplier')}
            </label>
            <NativeSelect
              id={`${id}-supplier`}
              value={filters.supplierId ?? ''}
              onChange={(event) => onChange({ supplierId: event.target.value || null })}
            >
              <option value="">{t('purchasing.purchases.filters.anySupplier')}</option>
              {suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : null}
        <label className="flex min-w-0 flex-col gap-1 text-sm text-muted-foreground">
          <span>{t('purchasing.purchases.filters.from')}</span>
          <Input
            type="date"
            value={filters.from ?? ''}
            max={filters.to ?? undefined}
            onChange={(event) => onChange({ from: event.target.value || null })}
            className="min-w-0 text-foreground"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm text-muted-foreground">
          <span>{t('purchasing.purchases.filters.to')}</span>
          <Input
            type="date"
            value={filters.to ?? ''}
            min={filters.from ?? undefined}
            onChange={(event) => onChange({ to: event.target.value || null })}
            className="min-w-0 text-foreground"
          />
        </label>
      </div>
      {isFiltered(filters) ? (
        <Button
          variant="link"
          className="h-auto px-0"
          onClick={() =>
            onChange({ status: 'all', supplierId: null, from: null, to: null, search: '' })
          }
        >
          {t('purchasing.purchases.filters.clear')}
        </Button>
      ) : null}
    </div>
  )
}

/**
 * One purchase in the list: who from (without a supplier, what it bought: "Flour, Eggs +1"), when,
 * its number and how many materials, its total and its status.
 */
function PurchaseRow({ purchase, href }: { purchase: PurchaseListItemDto; href: string }) {
  const { t } = useTranslation()
  const businessDate = useBusinessDate()
  const names = purchase.itemNames.filter(Boolean)
  const more = purchase.lineCount - names.length
  const itemsTitle =
    names.length === 0
      ? null
      : more > 0
        ? t('purchasing.purchases.moreItems', {
            names: names.join(t('purchasing.purchases.namesSeparator')),
            count: more,
          })
        : names.join(t('purchasing.purchases.namesSeparator'))
  return (
    <Link
      href={href}
      className="flex items-start gap-3 px-4 py-3.5 transition-colors outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset sm:px-5"
    >
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-xl',
          purchase.status === 'reversed'
            ? 'bg-muted text-muted-foreground'
            : 'bg-accent text-primary',
        )}
      >
        <ReceiptTextIcon aria-hidden className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span dir="auto" className="min-w-0 font-medium break-words">
            {purchase.supplierName ?? itemsTitle ?? t('purchasing.noSupplier')}
          </span>
          <StatusBadge status={purchase.status} />
        </span>
        <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
          {purchase.supplierName === null && itemsTitle ? `${t('purchasing.noSupplier')} · ` : null}
          {businessDate(purchase.businessDate)}
          {purchase.reference ? (
            <>
              {' · '}
              <bdi dir="auto">{purchase.reference}</bdi>
            </>
          ) : null}
          {' · '}
          {t('purchasing.purchases.items', { count: purchase.lineCount }).replaceAll(' ', NBSP)}
        </span>
      </span>
      <span
        className={cn(
          'shrink-0 pt-0.5 text-end font-medium',
          purchase.status === 'reversed' && 'text-muted-foreground line-through',
        )}
      >
        <Money value={purchase.total} currency={purchase.currency} />
      </span>
    </Link>
  )
}

function PurchasesList() {
  const { t } = useTranslation()
  const term = useTerminology()
  const trpc = useTRPC()
  const { businessId } = useParams<{ businessId: string }>()
  const businessDate = useBusinessDate()
  const { data: context } = useBusinessContext()
  const { filters, set } = useFilters()
  const list = useInfiniteQuery(
    trpc.purchase.list.infiniteQueryOptions(listInput(filters), {
      getNextPageParam: (page) => page.data.nextCursor,
      placeholderData: keepPreviousData,
    }),
  )
  const books = useQuery(trpc.books.get.queryOptions())
  if (!context) return null
  const canManage = can(context, 'purchases.documents.manage')
  const items = list.data?.pages.flatMap((page) => page.data.items) ?? []
  const filtered = isFiltered(filters)
  // No purchase at all yet: only the first-time card and its one "New purchase" (as D-132).
  const firstTime = !filtered && list.isSuccess && !list.isPlaceholderData && items.length === 0
  const base = `/b/${businessId}/purchases`
  const title = t('common.nav.purchases')

  const newButton = canManage ? (
    <Button asChild size="lg" className="shrink-0">
      <Link href={`${base}/new`}>
        <PlusIcon aria-hidden />
        {t('purchasing.purchases.new')}
      </Link>
    </Button>
  ) : null

  return (
    <PageContainer>
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
          <p className="mt-1.5 max-w-2xl text-muted-foreground">
            {term('purchasing.purchases.intro', context.terminologyProfile)}
          </p>
        </div>
        {firstTime ? null : newButton}
      </header>
      {books.data?.closedThrough ? (
        <FormAlert tone="info" className="mb-4">
          {t('purchasing.purchases.booksClosed', {
            date: businessDate(books.data.closedThrough),
          })}
        </FormAlert>
      ) : null}
      {firstTime ? null : <FilterBar filters={filters} onChange={set} />}
      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError && !list.data ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 ? (
        filtered ? (
          <ListEmpty
            icon={SearchXIcon}
            title={t('purchasing.purchases.filters.noMatches')}
            body={t('purchasing.purchases.filters.noMatchesHint')}
          />
        ) : (
          <ListEmpty
            icon={ReceiptTextIcon}
            title={t('purchasing.purchases.empty.title')}
            body={
              canManage
                ? term('purchasing.purchases.empty.body', context.terminologyProfile)
                : t('purchasing.purchases.empty.viewer')
            }
          >
            {newButton}
          </ListEmpty>
        )
      ) : (
        <div className="space-y-4">
          {list.data?.pages.some((page) => page.meta.redacted.length > 0) ? (
            <p className="text-sm text-muted-foreground">{t('common.locked.note')}</p>
          ) : null}
          <ul
            aria-label={title}
            className="divide-y overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]"
          >
            {items.map((purchase) => (
              <li key={purchase.id}>
                <PurchaseRow purchase={purchase} href={`${base}/${purchase.id}`} />
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

/** The Purchases page: the list inside the module's gate (turned off, or not open to the member). */
export function PurchasesPage() {
  return (
    <ModuleGate moduleId="purchases" entryId="purchases">
      <PurchasesList />
    </ModuleGate>
  )
}
