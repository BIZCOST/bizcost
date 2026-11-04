'use client'

import { apiErrorCode, useTRPC } from '@bizcost/app-core'
import type { StockCardEntryDto, StockMaterialDto } from '@bizcost/contracts'
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import { ArrowLeftIcon, SearchXIcon, WarehouseIcon } from 'lucide-react'
import Link from 'next/link'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { ModuleGate } from '@/components/shell/module-gate'
import { PageContainer } from '@/components/shell/page-container'
import { LoadError, SectionSkeleton } from '@/components/states/query-state'
import { StatePanel } from '@/components/states/state-panel'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { Locked, useBusinessDate, useMoney } from '@/features/documents/amounts'
import { Panel } from '@/features/documents/panel'
import { hasModule } from '@/features/purchasing/data'
import { can } from '@/features/settings/sections'
import { useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { readStockFilters, writeFilters } from './count-filters'
import { maySeeStock, useStockBranches } from './data'
import { StockQty, useSignedStock } from './quantity'
import { differenceSide, magnitude } from './stock-words'

// A material's stock card (M4 Step 2): its movements from its first count on, newest business day
// first (purchases, supplier returns and credit notes, first counts, counts, and their reversals),
// each with the quantity it moved, what was on hand after it, what it moved the stock's value by (a
// lock without the costs switch) and a link to where it came from. A branch filter for a member who
// sees more than one branch (`?branch=`).

/** "Purchase", "Count reversed"…: what a movement is. */
function useKindWords() {
  const { t } = useTranslation()
  return (entry: StockCardEntryDto) =>
    entry.kind === 'reversal' && entry.reversesKind
      ? t(`stock.card.reversalOf.${entry.reversesKind}`)
      : t(`stock.card.kinds.${entry.kind}`)
}

function EntryRow({
  entry,
  material,
  showBranch,
  purchases,
}: {
  entry: StockCardEntryDto
  material: StockMaterialDto
  showBranch: boolean
  /** The member may open purchases. */
  purchases: boolean
}) {
  const { t } = useTranslation()
  const money = useMoney()
  const kindWords = useKindWords()
  const businessDate = useBusinessDate()
  const signed = useSignedStock()
  const { businessId } = useParams<{ businessId: string }>()
  const base = `/b/${businessId}`
  const side = differenceSide(entry.qty)
  const link =
    entry.countId !== null
      ? { href: `${base}/stock/counts/${entry.countId}`, label: t('stock.card.openCount') }
      : entry.purchaseId !== null && purchases
        ? { href: `${base}/purchases/${entry.purchaseId}`, label: t('stock.card.openPurchase') }
        : null
  return (
    <li data-card-entry={entry.kind} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {kindWords(entry)}
          <span className="font-normal text-muted-foreground">
            {' · '}
            {businessDate(entry.businessDate)}
            {showBranch ? (
              <>
                {' · '}
                <bdi>{entry.locationName}</bdi>
              </>
            ) : null}
          </span>
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          <bdi
            data-card-qty
            className={cn(
              'font-medium tabular-nums',
              side === 'less' ? 'text-foreground' : 'text-success',
            )}
          >
            {signed(material, entry.qty)}
          </bdi>
          {' · '}
          {t('stock.card.after')}: <StockQty material={material} qty={entry.runningQty} />
          {entry.countedQty !== null ? (
            <>
              {' · '}
              {t('stock.card.countedQty')}: <StockQty material={material} qty={entry.countedQty} />
            </>
          ) : null}
        </p>
        {link ? (
          <Link
            href={link.href}
            className="mt-1 inline-flex min-h-9 items-center text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {link.label}
          </Link>
        ) : null}
      </div>
      <div className="shrink-0 text-end">
        <p className="text-xs text-muted-foreground">{t('stock.card.valueChange')}</p>
        <p className="text-sm font-medium tabular-nums">
          {entry.valueChange === undefined ? (
            <Locked category="cost" />
          ) : (
            <bdi>
              {differenceSide(entry.valueChange) === 'more'
                ? '+'
                : differenceSide(entry.valueChange) === 'less'
                  ? '−'
                  : ''}
              {money(magnitude(entry.valueChange))}
            </bdi>
          )}
        </p>
      </div>
    </li>
  )
}

function Card({ materialId }: { materialId: string }) {
  const { t } = useTranslation()
  const term = useTerminology()
  const trpc = useTRPC()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const businessDate = useBusinessDate()
  const branchId = useId()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const { branches } = useStockBranches(context)
  const { locationId } = readStockFilters(params)
  const card = useInfiniteQuery(
    trpc.stock.card.infiniteQueryOptions(
      { materialId, locationId: locationId ?? undefined },
      { getNextPageParam: (page) => page.data.nextCursor, placeholderData: keepPreviousData },
    ),
  )
  const stockHref = `/b/${businessId}/stock`
  if (!context) return null
  const code = card.isError ? apiErrorCode(card.error) : undefined
  if (code === 'not_found' || code === 'stock_not_tracked') {
    const notTracked = code === 'stock_not_tracked'
    return (
      <PageContainer>
        <StatePanel
          icon={notTracked ? WarehouseIcon : SearchXIcon}
          title={term(
            notTracked ? 'stock.card.notTracked' : 'stock.card.notFound',
            context.terminologyProfile,
          )}
          body={t(notTracked ? 'stock.card.notTrackedBody' : 'stock.card.notFoundBody')}
        >
          <Button asChild variant="outline" size="lg">
            <Link href={stockHref}>{t('states.goTo', { section: t('common.nav.stock') })}</Link>
          </Button>
        </StatePanel>
      </PageContainer>
    )
  }
  if (card.isError && !card.data) {
    return (
      <PageContainer>
        <LoadError error={card.error} onRetry={() => void card.refetch()} />
      </PageContainer>
    )
  }
  const pages = card.data?.pages ?? []
  const first = pages[0]?.data
  if (!first) {
    return (
      <PageContainer>
        <SectionSkeleton cards={2} />
      </PageContainer>
    )
  }
  const entries = pages.flatMap((page) => page.data.entries)
  const purchases = hasModule(context, 'purchases') && can(context, 'purchases.documents.view')
  const showBranch = branches.length > 1 && locationId === null
  const redacted = pages.some((page) => page.meta.redacted.length > 0)

  return (
    <PageContainer>
      <Link
        href={stockHref}
        className="-ms-2 -mt-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
        {t('common.nav.stock')}
      </Link>
      <header className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight break-words sm:text-3xl">
          <bdi>{first.material.name}</bdi>
        </h1>
        <p className="mt-1.5 text-muted-foreground">
          {t('stock.card.title')} ·{' '}
          {t('stock.card.trackedFrom', { date: businessDate(first.trackedFrom) })}
        </p>
      </header>
      <div className="space-y-5">
        <Panel title={t('stock.card.onHand')}>
          <p data-card-on-hand className="text-lg font-semibold">
            <StockQty material={first.material} qty={first.onHand} />
          </p>
          {branches.length > 1 ? (
            <div className="mt-4 flex flex-col gap-1 sm:w-64">
              <label htmlFor={branchId} className="text-sm text-muted-foreground">
                {t('stock.onHand.branch')}
              </label>
              <NativeSelect
                id={branchId}
                value={locationId ?? ''}
                onChange={(event) => {
                  const query = writeFilters(params, { locationId: event.target.value || null })
                  router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
                }}
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
        </Panel>
        <Panel title={t('stock.card.title')} hint={t('stock.card.intro')}>
          {redacted ? (
            <p className="mb-3 text-sm text-muted-foreground">{t('stock.onHand.lockedNote')}</p>
          ) : null}
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('stock.card.empty')}</p>
          ) : (
            <ul aria-label={t('stock.card.title')} className="divide-y">
              {entries.map((entry) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  material={first.material}
                  showBranch={showBranch}
                  purchases={purchases}
                />
              ))}
            </ul>
          )}
          {card.hasNextPage ? (
            <div className="mt-4 flex justify-center">
              <Button
                variant="outline"
                disabled={card.isFetchingNextPage}
                onClick={() => void card.fetchNextPage()}
              >
                {card.isFetchingNextPage ? t('status.loading') : t('catalog.list.showMore')}
              </Button>
            </div>
          ) : null}
        </Panel>
      </div>
    </PageContainer>
  )
}

function StockCard({ materialId }: { materialId: string }) {
  const { data: context } = useBusinessContext()
  if (!context) return null
  if (!maySeeStock(context)) {
    return <ForbiddenCard />
  }
  return <Card materialId={materialId} />
}

function ForbiddenCard() {
  const { t } = useTranslation()
  const { businessId } = useParams<{ businessId: string }>()
  return (
    <PageContainer>
      <StatePanel
        icon={WarehouseIcon}
        title={t('states.forbidden.title')}
        body={t('states.forbidden.body')}
        documentTitle={`${t('states.forbidden.title')} · ${t('appName')}`}
      >
        <Button asChild variant="outline" size="lg">
          <Link href={`/b/${businessId}/stock`}>
            {t('states.goTo', { section: t('common.nav.stock') })}
          </Link>
        </Button>
      </StatePanel>
    </PageContainer>
  )
}

/** A material's stock card, inside the module's gate. */
export function StockCardPage({ materialId }: { materialId: string }) {
  return (
    <ModuleGate moduleId="inventory" entryId="stock">
      <StockCard materialId={materialId} />
    </ModuleGate>
  )
}
