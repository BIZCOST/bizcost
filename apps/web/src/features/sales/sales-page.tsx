'use client'

import { useTRPC } from '@bizcost/app-core'
import type { SaleListDto, SaleListItemDto } from '@bizcost/contracts'
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import {
  BanknoteIcon,
  CalendarCheckIcon,
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
import { useBusinessDate, useMoney } from '@/features/documents/amounts'
import { SearchBox } from '@/features/documents/search-box'
import { StatusBadge } from '@/features/documents/status-badge'
import { useLocationOptions } from '@/features/purchasing/data'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { mayEnterSales, useBooks, useChannels } from './data'
import {
  isFiltered,
  listInput,
  NO_FILTERS,
  readSaleFilters,
  SALE_STATUS_FILTERS,
  writeSaleFilters,
  type SaleFilters,
} from './sale-filters'
import { sheetHref } from './sheet-params'

// Sales (M3 Step 2; D-231): what was sold, newest day first, each day with what its sales came to
// before VAT (only for members who see every sale: the sales totals, H1), and each sale with its
// channel and status. Filters live in the address (status, kind, channel, branch, days, a search in
// what was sold, never in an amount: D-209). Members who enter sales open Today's sales or a new
// sale from here; one's own draft sheet opens in Today's sales, anything else as it was recorded.

function useFilters() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const filters = readSaleFilters(params)
  const set = (next: Partial<SaleFilters>) => {
    const query = writeSaleFilters(params, next)
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }
  return { filters, set }
}

/** The filters: a search, the status, and on a phone under one button the rest. */
function FilterBar({
  filters,
  onChange,
}: {
  filters: SaleFilters
  onChange: (next: Partial<SaleFilters>) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const { data: context } = useBusinessContext()
  const { channels } = useChannels('all')
  const locationOptions = useLocationOptions(context)
  const narrowing = [
    filters.source,
    filters.channelId,
    filters.locationId,
    filters.from,
    filters.to,
  ].filter(Boolean).length
  const [open, setOpen] = useState(narrowing > 0)
  return (
    <div className="mb-4 space-y-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <SearchBox
          value={filters.search}
          placeholder={t('sales.list.searchPlaceholder')}
          onChange={(search) => onChange({ search })}
        />
        <fieldset className="flex shrink-0 rounded-lg bg-muted p-1">
          <legend className="sr-only">{t('sales.list.filters.status')}</legend>
          {SALE_STATUS_FILTERS.map((value) => (
            <label key={value} className="relative flex-1 lg:flex-none">
              <input
                type="radio"
                name="sale-status"
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
                {t(`sales.list.filters.${value}`)}
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
        {t('sales.list.filters.more')}
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
          'grid grid-cols-2 items-end gap-3 sm:grid-cols-3 lg:grid-cols-5',
          !open && 'max-sm:hidden',
        )}
      >
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={`${id}-kind`} className="text-sm text-muted-foreground">
            {t('sales.list.filters.source')}
          </label>
          <NativeSelect
            id={`${id}-kind`}
            value={filters.source ?? ''}
            onChange={(event) =>
              onChange({ source: (event.target.value || null) as SaleFilters['source'] })
            }
          >
            <option value="">{t('sales.list.filters.anySource')}</option>
            <option value="day_sheet">{t('sales.list.filters.day_sheet')}</option>
            <option value="single">{t('sales.list.filters.single')}</option>
          </NativeSelect>
        </div>
        {channels.length > 1 ? (
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={`${id}-channel`} className="text-sm text-muted-foreground">
              {t('sales.list.filters.channel')}
            </label>
            <NativeSelect
              id={`${id}-channel`}
              value={filters.channelId ?? ''}
              onChange={(event) => onChange({ channelId: event.target.value || null })}
            >
              <option value="">{t('sales.list.filters.anyChannel')}</option>
              {channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : null}
        {locationOptions.enabled && locationOptions.locations.length > 1 ? (
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={`${id}-branch`} className="text-sm text-muted-foreground">
              {t('sales.list.filters.location')}
            </label>
            <NativeSelect
              id={`${id}-branch`}
              value={filters.locationId ?? ''}
              onChange={(event) => onChange({ locationId: event.target.value || null })}
            >
              <option value="">{t('sales.list.filters.anyLocation')}</option>
              {locationOptions.locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : null}
        <label className="flex min-w-0 flex-col gap-1 text-sm text-muted-foreground">
          <span>{t('sales.list.filters.from')}</span>
          <Input
            type="date"
            value={filters.from ?? ''}
            max={filters.to ?? undefined}
            onChange={(event) => onChange({ from: event.target.value || null })}
            className="min-w-0 text-foreground"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm text-muted-foreground">
          <span>{t('sales.list.filters.to')}</span>
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
        <Button variant="link" className="h-auto px-0" onClick={() => onChange(NO_FILTERS)}>
          {t('sales.list.filters.clear')}
        </Button>
      ) : null}
    </div>
  )
}

/**
 * The days of the loaded pages, newest first, each with its sales and (for viewers) its total; with
 * them the days that only take back sales of a closed day reversed on them (D-227, D-236).
 */
function byDay(
  items: readonly SaleListItemDto[],
  totals: readonly NonNullable<SaleListDto['dayTotals']>[number][],
) {
  const days: {
    businessDate: string
    sales: SaleListItemDto[]
    total?: (typeof totals)[number]
  }[] = []
  for (const sale of items) {
    const last = days.at(-1)
    if (last?.businessDate === sale.businessDate) last.sales.push(sale)
    else days.push({ businessDate: sale.businessDate, sales: [sale] })
  }
  const listed = new Set(days.map((day) => day.businessDate))
  for (const total of totals) {
    if (listed.has(total.businessDate)) continue
    listed.add(total.businessDate)
    days.push({ businessDate: total.businessDate, sales: [] })
  }
  days.sort((a, b) =>
    a.businessDate < b.businessDate ? 1 : a.businessDate > b.businessDate ? -1 : 0,
  )
  const byDate = new Map(totals.map((total) => [total.businessDate, total]))
  return days.map((day) => ({ ...day, total: byDate.get(day.businessDate) }))
}

/** One sale in the list: what it was, its channel and who entered it, its amount and status. */
function SaleRow({
  sale,
  href,
  vatShown,
  locationName,
}: {
  sale: SaleListItemDto
  href: string
  vatShown: boolean
  /** The sale's branch, with branches (when the member may see the branch list). */
  locationName: string | undefined
}) {
  const { t } = useTranslation()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const names = sale.itemNames.filter(Boolean)
  const more = sale.lineCount - names.length
  const items =
    names.length === 0
      ? t('sales.list.noItems')
      : more > 0
        ? t('sales.list.moreItems', {
            names: names.join(t('sales.list.namesSeparator')),
            count: more,
          })
        : names.join(t('sales.list.namesSeparator'))
  const title =
    sale.source === 'day_sheet'
      ? sale.periodFrom
        ? t('sales.list.sheetPeriod', {
            from: businessDate(sale.periodFrom),
            to: businessDate(sale.businessDate),
          })
        : t('sales.list.sheet', { date: businessDate(sale.businessDate) })
      : items
  const Icon = sale.source === 'day_sheet' ? CalendarCheckIcon : ReceiptTextIcon
  return (
    <Link
      href={href}
      data-sale-row={sale.source}
      className="flex items-start gap-3 px-4 py-3.5 transition-colors outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset sm:px-5"
    >
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-xl',
          sale.status === 'reversed' ? 'bg-muted text-muted-foreground' : 'bg-accent text-primary',
        )}
      >
        <Icon aria-hidden className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 text-start font-medium break-words">
            <bdi>{title}</bdi>
          </span>
          <StatusBadge status={sale.status} kind="sale" />
        </span>
        <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
          <bdi>{sale.channelName}</bdi>
          {locationName ? (
            <>
              {' · '}
              <bdi>{locationName}</bdi>
            </>
          ) : null}
          {sale.enteredByName ? (
            <>
              {' · '}
              <bdi>{sale.enteredByName}</bdi>
            </>
          ) : null}
          {sale.source === 'day_sheet' ? (
            <>
              {' · '}
              {t('sales.list.items', { count: sale.lineCount }).replaceAll(' ', NBSP)}
            </>
          ) : null}
        </span>
      </span>
      <span
        className={cn(
          'shrink-0 pt-0.5 text-end font-medium',
          sale.status === 'reversed' && 'text-muted-foreground line-through',
        )}
      >
        <bdi className="tabular-nums">{money(sale.netTotal, sale.currency)}</bdi>
        {vatShown ? (
          <span className="block text-xs font-normal text-muted-foreground no-underline">
            {t('sales.list.beforeVat')}
          </span>
        ) : null}
      </span>
    </Link>
  )
}

function SalesList() {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const { filters, set } = useFilters()
  const list = useInfiniteQuery(
    trpc.sale.list.infiniteQueryOptions(listInput(filters), {
      getNextPageParam: (page) => page.nextCursor,
      placeholderData: keepPreviousData,
    }),
  )
  const books = useBooks()
  const locationOptions = useLocationOptions(context)
  if (!context) return null
  const canEnter = mayEnterSales(context)
  const locationNames =
    locationOptions.enabled && locationOptions.locations.length > 1
      ? new Map(locationOptions.locations.map((location) => [location.id, location.name]))
      : null
  const vatShown = context.capabilities.vat_registered === true
  const items = list.data?.pages.flatMap((page) => page.items) ?? []
  const totals = list.data?.pages.flatMap((page) => page.dayTotals ?? []) ?? []
  const filtered = isFiltered(filters)
  // No sale at all yet: only the first-time card and its buttons (as D-132).
  const firstTime = !filtered && list.isSuccess && !list.isPlaceholderData && items.length === 0
  const base = `/b/${businessId}/sales`
  const title = t('common.nav.sales')
  const today = books.data?.today

  const buttons = canEnter ? (
    <div className="flex shrink-0 flex-wrap gap-2">
      <Button asChild size="lg">
        <Link href={`${base}/today`}>
          <CalendarCheckIcon aria-hidden />
          {t('sales.list.today')}
        </Link>
      </Button>
      <Button asChild size="lg" variant="outline">
        <Link href={`${base}/new`}>
          <PlusIcon aria-hidden />
          {t('sales.list.newSale')}
        </Link>
      </Button>
    </div>
  ) : null

  /** One's own draft sheet opens in Today's sales; anything else as it was recorded. */
  const hrefOf = (sale: SaleListItemDto) =>
    sale.source === 'day_sheet' && sale.status === 'draft' && sale.mine && canEnter && today
      ? sheetHref(
          businessId,
          {
            businessDate: sale.businessDate,
            periodFrom: sale.periodFrom,
            channelId: sale.channelId,
            locationId: sale.locationId,
          },
          today,
        )
      : `${base}/${sale.id}`

  return (
    <PageContainer>
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
          <p className="mt-1.5 max-w-2xl text-muted-foreground">
            {canEnter ? t('sales.list.intro') : t('sales.list.introViewer')}
          </p>
        </div>
        {firstTime ? null : buttons}
      </header>
      {books.data?.closedThrough ? (
        <FormAlert tone="info" className="mb-4">
          {t('sales.list.booksClosed', { date: businessDate(books.data.closedThrough) })}
        </FormAlert>
      ) : null}
      {firstTime ? null : <FilterBar filters={filters} onChange={set} />}
      {list.isPending ? (
        <ListSkeleton />
      ) : list.isError && !list.data ? (
        <LoadError error={list.error} onRetry={() => void list.refetch()} />
      ) : items.length === 0 && totals.length === 0 ? (
        filtered ? (
          <ListEmpty
            icon={SearchXIcon}
            title={t('sales.list.filters.noMatches')}
            body={t('sales.list.filters.noMatchesHint')}
          />
        ) : (
          <ListEmpty
            icon={BanknoteIcon}
            title={t('sales.list.empty.title')}
            body={canEnter ? t('sales.list.empty.body') : t('sales.list.empty.viewer')}
          >
            {buttons}
          </ListEmpty>
        )
      ) : (
        <div className="space-y-5">
          {byDay(items, totals).map((day) => (
            <section key={day.businessDate} aria-labelledby={`day-${day.businessDate}`}>
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-1">
                <h2 id={`day-${day.businessDate}`} className="font-semibold">
                  {businessDate(day.businessDate)}
                </h2>
                {day.total && (day.total.count > 0 || day.sales.length === 0) ? (
                  <p data-day-total className="text-sm text-muted-foreground">
                    <bdi className="font-medium text-foreground tabular-nums">
                      {money(day.total.netTotal)}
                    </bdi>
                    {vatShown ? ` ${t('sales.list.beforeVat')}` : null}
                    {day.total.count > 0 ? (
                      <>
                        {' · '}
                        {t('sales.list.daySales', { count: day.total.count })}
                      </>
                    ) : null}
                  </p>
                ) : null}
              </div>
              {day.sales.length === 0 ? (
                <p
                  data-taken-back
                  className="rounded-2xl bg-card px-4 py-3.5 text-sm text-muted-foreground shadow-sm ring-1 ring-foreground/[0.06] sm:px-5"
                >
                  {t('sales.list.takenBack')}
                </p>
              ) : (
                <ul
                  aria-labelledby={`day-${day.businessDate}`}
                  className="divide-y overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]"
                >
                  {day.sales.map((sale) => (
                    <li key={sale.id}>
                      <SaleRow
                        sale={sale}
                        href={hrefOf(sale)}
                        vatShown={vatShown}
                        locationName={locationNames?.get(sale.locationId)}
                      />
                    </li>
                  ))}
                </ul>
              )}
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

/** The Sales page: the list inside the module's gate (turned off, or not open to the member). */
export function SalesPage() {
  return (
    <ModuleGate moduleId="sales" entryId="sales">
      <SalesList />
    </ModuleGate>
  )
}
