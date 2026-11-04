'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { CountDto, CountResultDto, CountReviewDto, StockMaterialDto } from '@bizcost/contracts'
import { sumDecimals } from '@bizcost/domain'
import { formatDate } from '@bizcost/i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftIcon,
  CheckCheckIcon,
  LockKeyholeIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchXIcon,
  Undo2Icon,
} from 'lucide-react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { isolate, ltrIsolate } from '@/components/form/use-message'
import { ModuleGate } from '@/components/shell/module-gate'
import { PageContainer } from '@/components/shell/page-container'
import { LoadError, SectionSkeleton } from '@/components/states/query-state'
import { StatePanel } from '@/components/states/state-panel'
import { Button } from '@/components/ui/button'
import { Locked, Money, useBusinessDate, useMoney, useUnitCost } from '@/features/documents/amounts'
import { closedFor, nextDay } from '@/features/documents/books'
import { ConfirmDialog } from '@/features/documents/confirm-dialog'
import { Panel } from '@/features/documents/panel'
import { refusalOf, useSayRefusal, type Refusal } from '@/features/documents/refusal'
import { StatusBadge } from '@/features/documents/status-badge'
import { useLocale, useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { CountSheet } from './count-sheet'
import {
  hasBranches,
  mayChangeCount,
  mayEnterCounts,
  mayManageCounts,
  useBooks,
  useRefreshStock,
} from './data'
import { StockQty } from './quantity'
import { differenceSide, magnitude, summarizeDifferences } from './stock-words'

// A count's pages (M4 Step 2; D-339 Q5, Q6): a draft opens its sheet for whoever fills counts; a
// finalized or reversed count shows what was counted (and, to a manager, what was expected and the
// difference, its value with the costs switch), with Reverse for a manager. The review (managers,
// a draft) puts what was counted beside what the book expected at the end of the count's day, asks
// for lines to be counted again, lists what is not counted yet and the branches a first count misses,
// says what a first count starts each material at, and finalizes after a confirmation that says in
// words what it changes. What is finalized is what was reviewed (D-348): the review's version goes
// with it, and a line changed since is said, never finalized unseen. A first count is changed only
// by a manager who works in every branch.

/** A draft is read again this often while its page is in view (several people count it, Q6). */
const DRAFT_REFRESH_MS = 20_000

/** Read a draft again every little while and when its page comes back to view; not a final one. */
function draftRefresh(query: { state: { data?: { data: { status: string } } } }) {
  return query.state.data?.data.status === 'draft'
}

/** A count page on its way (also its loading.tsx). */
export function CountLoading() {
  return (
    <PageContainer>
      <SectionSkeleton cards={3} />
    </PageContainer>
  )
}

function BackToCounts() {
  const { t } = useTranslation()
  const { businessId } = useParams<{ businessId: string }>()
  return (
    <Button asChild variant="outline" size="lg">
      <Link href={`/b/${businessId}/stock/counts`}>
        {t('states.goTo', { section: t('stock.tabs.counts') })}
      </Link>
    </Button>
  )
}

function NotFound() {
  const { t } = useTranslation()
  return (
    <PageContainer>
      <StatePanel
        icon={SearchXIcon}
        title={t('stock.view.notFound')}
        body={t('stock.view.notFoundBody')}
        documentTitle={`${t('stock.view.notFound')} · ${t('appName')}`}
      >
        <BackToCounts />
      </StatePanel>
    </PageContainer>
  )
}

function Forbidden() {
  const { t } = useTranslation()
  return (
    <PageContainer>
      <StatePanel
        icon={LockKeyholeIcon}
        title={t('states.forbidden.title')}
        body={t('states.forbidden.body')}
        documentTitle={`${t('states.forbidden.title')} · ${t('appName')}`}
      >
        <BackToCounts />
      </StatePanel>
    </PageContainer>
  )
}

/** "8 L more", "80 L less", "As expected": a difference in words, never "loss" (PRODUCT.md §13). */
function Difference({ material, qty }: { material: StockMaterialDto; qty: string }) {
  const { t } = useTranslation()
  const side = differenceSide(qty)
  if (side === 'same')
    return <span className="text-muted-foreground">{t('stock.review.same')}</span>
  return (
    <span
      data-difference={side}
      className={cn(side === 'less' ? 'text-warning' : 'text-foreground')}
    >
      <StockQty material={material} qty={magnitude(qty)} />{' '}
      <span className="font-medium">
        {side === 'less' ? t('stock.review.lessWord') : t('stock.review.moreWord')}
      </span>
    </span>
  )
}

/** A difference's value: "AED 480.00 less", or the lock without the costs switch. */
function DifferenceValue({ value }: { value: string | null | undefined }) {
  const { t } = useTranslation()
  const money = useMoney()
  if (value === undefined) return <Locked category="cost" />
  if (value === null) return null
  const side = differenceSide(value)
  if (side === 'same')
    return <span className="text-muted-foreground tabular-nums">{money('0')}</span>
  return (
    <bdi data-difference-value={side} className="tabular-nums">
      {t(side === 'less' ? 'stock.review.valueLess' : 'stock.review.valueMore', {
        amount: money(magnitude(value)),
      })}
    </bdi>
  )
}

/** A label above a value, in a line's grid. */
function Cell({
  label,
  children,
  className,
}: {
  label: string
  children: ReactNode
  className?: string
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="text-sm">{children}</div>
    </div>
  )
}

/** The page's top: back to the counts, the title, its status, where and who. */
function CountTop({ count, actions }: { count: CountDto; actions?: ReactNode }) {
  const { t } = useTranslation()
  const businessDate = useBusinessDate()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const opening = count.kind === 'opening'
  const branches = context !== undefined && hasBranches(context)
  const where = opening
    ? branches
      ? t('stock.counts.everyBranch')
      : null
    : branches
      ? count.locationName
      : null
  const who = [
    count.createdByName ? t('stock.view.startedBy', { name: isolate(count.createdByName) }) : null,
    count.postedByName ? t('stock.view.finalizedBy', { name: isolate(count.postedByName) }) : null,
  ].filter(Boolean)
  return (
    <>
      <Link
        href={`/b/${businessId}/stock/counts`}
        className="-ms-2 -mt-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
        {t('stock.tabs.counts')}
      </Link>
      <header className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {t(opening ? 'stock.sheet.openingTitle' : 'stock.sheet.title', {
                date: businessDate(count.businessDate),
              })}
            </h1>
            <StatusBadge status={count.status} kind="count" />
          </div>
          <p className="mt-1.5 text-muted-foreground">
            {[where, ...who].filter(Boolean).map((part, index) => (
              <span key={index}>
                {index > 0 ? ' · ' : null}
                <bdi>{part}</bdi>
              </span>
            ))}
          </p>
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </header>
    </>
  )
}

/**
 * The reversal's day (D-114 rule 3): the count's own, or the first day after the closed books; null
 * when that would be after today (the books are closed through today).
 */
function reversalDay(count: CountDto, today: string, closedThrough: string | null): string | null {
  const day =
    closedThrough && count.businessDate <= closedThrough
      ? nextDay(closedThrough)
      : count.businessDate
  return day > today ? null : day
}

/** When something happened (a timestamp), as the business's day: "31 Oct 2026" in its time zone. */
function useDayOf(timeZone: string) {
  const { locale } = useLocale()
  return (at: string) => formatDate(locale, at, { dateStyle: 'medium', timeZone })
}

/** A finalized or reversed count, as it was counted. */
function CountView({
  result,
  today,
  closedThrough,
  timeZone,
}: {
  result: CountResultDto
  today: string
  closedThrough: string | null
  timeZone: string
}) {
  const { t } = useTranslation()
  const term = useTerminology()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const refresh = useRefreshStock()
  const businessDate = useBusinessDate()
  const dayOf = useDayOf(timeZone)
  const { locale } = useLocale()
  const { data: context } = useBusinessContext()
  const count = result.data
  const reverse = useMutation(trpc.count.reverse.mutationOptions())
  const [confirming, setConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState<Refusal | null>(null)
  const materials = useMemo(() => new Map(count.materials.map((m) => [m.id, m])), [count.materials])
  if (!context) return null
  const opening = count.kind === 'opening'
  // Reverse: a manager of counts; a first count only one who works in every branch.
  const reverses = mayChangeCount(context, count.kind)
  // What the book said and the difference: only a manager gets them (blind otherwise, Q6), and a
  // first count has nothing to compare with.
  const compares = !opening && count.lines.some((line) => line.bookQty !== undefined)
  const branches = new Set(count.lines.map((line) => line.locationId)).size > 1
  const posted = count.status === 'posted'
  const reversal = reversalDay(count, today, closedThrough)
  const itemCount = count.materials.length
  const day = businessDate(count.businessDate)

  async function doReverse() {
    setConfirmError(null)
    try {
      const reversed = await reverse.mutateAsync({ id: count.id })
      queryClient.setQueryData(trpc.count.get.queryKey({ id: count.id }), reversed)
      await refresh()
      toast.success(t('stock.confirm.reversed'))
      setConfirming(false)
    } catch (error) {
      // HAS_LATER_COUNTS, STOCK_USED_SINCE (with the materials' names)…
      setConfirmError(refusalOf(error, locale))
    }
  }

  return (
    <PageContainer>
      <CountTop
        count={count}
        actions={
          posted && reverses ? (
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmError(null)
                setConfirming(true)
              }}
            >
              <Undo2Icon aria-hidden />
              {t('stock.view.reverse')}
            </Button>
          ) : null
        }
      />
      <div className="space-y-5">
        <FormAlert tone="info">
          {count.status === 'reversed'
            ? t('stock.view.reversedNote', {
                date: count.reversedAt
                  ? dayOf(count.reversedAt)
                  : businessDate(count.reversalDate ?? count.businessDate),
              })
            : t(opening ? 'stock.view.openingFinalNote' : 'stock.view.finalNote', {
                date: count.postedAt ? dayOf(count.postedAt) : day,
                day,
              })}
        </FormAlert>
        {count.note ? (
          <p className="text-sm">
            <span className="text-muted-foreground">{t('stock.view.note')}: </span>
            <bdi dir="auto">{count.note}</bdi>
          </p>
        ) : null}
        {compares && result.meta.redacted.length > 0 ? (
          <p className="text-sm text-muted-foreground">{t('stock.onHand.lockedNote')}</p>
        ) : null}
        <Panel title={t('stock.view.lines')}>
          <ul aria-label={t('stock.view.lines')} className="divide-y">
            {count.lines.map((line) => {
              const material = materials.get(line.materialId)!
              return (
                <li
                  key={line.id}
                  data-count-line={line.id}
                  className="space-y-2 py-3 first:pt-0 last:pb-0"
                >
                  <p className="font-medium break-words">
                    <bdi>{material.name}</bdi>
                    {branches ? (
                      <span className="font-normal text-muted-foreground">
                        {' · '}
                        <bdi>{line.locationName}</bdi>
                      </span>
                    ) : null}
                  </p>
                  <div
                    className={cn(
                      'grid gap-x-4 gap-y-2',
                      compares ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-1',
                    )}
                  >
                    <Cell label={t('stock.review.counted')}>
                      {line.countedQty !== null ? (
                        <StockQty material={material} qty={line.countedQty} />
                      ) : (
                        '—'
                      )}
                    </Cell>
                    {compares && line.bookQty !== undefined ? (
                      <>
                        <Cell label={t('stock.review.expected')}>
                          <StockQty material={material} qty={line.bookQty} />
                        </Cell>
                        <Cell label={t('stock.review.difference')}>
                          <Difference material={material} qty={line.differenceQty ?? '0'} />
                        </Cell>
                        <Cell label={t('stock.review.totalDifference')}>
                          <DifferenceValue value={line.differenceValue} />
                        </Cell>
                      </>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
        </Panel>
      </div>
      <ConfirmDialog
        open={confirming}
        icon={Undo2Icon}
        title={t('stock.confirm.reverseTitle')}
        body={
          reversal === null
            ? t('stock.confirm.reverseClosed')
            : term(
                opening ? 'stock.confirm.reverseOpeningBody' : 'stock.confirm.reverseBody',
                context.terminologyProfile,
                { count: itemCount, date: businessDate(reversal) },
              )
        }
        note={t('stock.confirm.reverseNote')}
        action={t('stock.confirm.reverse')}
        busyLabel={t('stock.confirm.reversing')}
        busy={reverse.isPending}
        error={confirmError}
        destructive
        disabled={reversal === null}
        onConfirm={() => void doReverse()}
        onClose={() => setConfirming(false)}
      />
    </PageContainer>
  )
}

function OneCount({ countId }: { countId: string }) {
  const trpc = useTRPC()
  const { data: context } = useBusinessContext()
  const books = useBooks()
  // A draft is read again every little while and on coming back to it: others count it too, and a
  // manager may finalize it (Q6).
  const count = useQuery({
    ...trpc.count.get.queryOptions({ id: countId }),
    refetchInterval: (query) => (draftRefresh(query) ? DRAFT_REFRESH_MS : false),
    refetchOnWindowFocus: (query) => (draftRefresh(query) ? 'always' : true),
  })
  if (!context) return null
  if (count.isError && apiErrorCode(count.error) === 'not_found') return <NotFound />
  const error = count.error ?? books.error
  if (error && (!count.data || !books.data)) {
    return (
      <PageContainer>
        <LoadError
          error={error}
          onRetry={() => {
            void count.refetch()
            void books.refetch()
          }}
        />
      </PageContainer>
    )
  }
  if (!count.data || !books.data) return <CountLoading />
  if (count.data.data.status === 'draft') {
    if (!mayEnterCounts(context)) return <Forbidden />
    return <CountSheet key={count.data.data.id} result={count.data} />
  }
  return (
    <CountView
      result={count.data}
      today={books.data.today}
      closedThrough={books.data.closedThrough}
      timeZone={books.data.timeZone}
    />
  )
}

// ---------------------------------------------------------------------------------------------------
// The review (counts.manage)
// ---------------------------------------------------------------------------------------------------

function CountReview({
  count,
  review,
  today,
  closedThrough,
  reload,
}: {
  count: CountResultDto
  review: CountReviewDto
  today: string
  closedThrough: string | null
  /** Reads the review again; its answer, or undefined when it could not be read. */
  reload: () => Promise<CountReviewDto | undefined>
}) {
  const { t } = useTranslation()
  const term = useTerminology()
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  const refresh = useRefreshStock()
  const money = useMoney()
  const unitCost = useUnitCost()
  const businessDate = useBusinessDate()
  const { locale } = useLocale()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const say = useSayRefusal()
  const finalize = useMutation(trpc.count.finalize.mutationOptions())
  const clear = useMutation(trpc.count.clearLine.mutationOptions())
  const addLines = useMutation(trpc.count.addLines.mutationOptions())
  const [confirming, setConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState<Refusal | null>(null)
  // The review's version the confirmation was opened on (read afresh then): what finalize sends.
  const [confirmVersion, setConfirmVersion] = useState<number | null>(null)
  const [checking, setChecking] = useState(false)
  // Lines changed since the manager looked (a CONFLICT, or a new version on opening Finalize).
  const [changedSince, setChangedSince] = useState(false)
  const [addError, setAddError] = useState<Refusal | null>(null)
  const [clearing, setClearing] = useState<string | null>(null)
  const data = count.data
  const profile = context?.terminologyProfile
  const materials = useMemo(() => new Map(data.materials.map((m) => [m.id, m])), [data.materials])
  const versions = useMemo(
    () => new Map(data.lines.map((line) => [line.id, line] as const)),
    [data.lines],
  )
  const opening = data.kind === 'opening'
  const sheetHref = `/b/${businessId}/stock/counts/${data.id}`
  const branches = new Set(review.data.lines.map((line) => line.locationId)).size > 1
  const lines = review.data.lines
  const notCounted = lines.filter((line) => line.countedQty === null)
  const counted = lines.filter((line) => line.countedQty !== null)
  const missing = review.data.missingLines
  const closed = closedFor(data.businessDate, today, closedThrough)
  const summary = summarizeDifferences(counted)
  const openingTotal = review.data.openings.some((o) => o.value === undefined)
    ? undefined
    : sumDecimals(review.data.openings.map((o) => o.value ?? '0'))
  const countKey = trpc.count.get.queryKey({ id: data.id })
  const where = context && hasBranches(context) ? data.locationName : null

  async function countAgain(lineId: string, name: string) {
    const line = versions.get(lineId)
    if (!line) return
    setClearing(lineId)
    try {
      const cleared = await clear.mutateAsync({ countId: data.id, lineId, version: line.version })
      queryClient.setQueryData(countKey, (old: CountResultDto | undefined) => {
        if (!old) return old
        const next = old.data.lines.map((l) => (l.id === lineId ? cleared.data : l))
        return {
          ...old,
          data: {
            ...old.data,
            lines: next,
            countedCount: next.filter((l) => l.countedQty !== null).length,
          },
        }
      })
      await reload()
      void queryClient.invalidateQueries({ queryKey: trpc.count.list.pathKey() })
      toast.success(t('stock.review.countAgainDone', { name: isolate(name) }))
    } catch (error) {
      toast.error(
        t(apiErrorCode(error) === 'conflict' ? 'stock.review.conflict' : apiErrorKey(error)),
      )
      await Promise.all([reload(), queryClient.invalidateQueries({ queryKey: countKey })])
    } finally {
      setClearing(null)
    }
  }

  /** Adds the lines a first count misses in branches added since (its materials there). */
  async function addMissing() {
    setAddError(null)
    try {
      const added = await addLines.mutateAsync({
        countId: data.id,
        materialIds: [...new Set(missing.map((line) => line.materialId))],
      })
      queryClient.setQueryData(countKey, added)
      await reload()
      void queryClient.invalidateQueries({ queryKey: trpc.count.list.pathKey() })
      toast.success(t('stock.review.branchAdded'))
    } catch (error) {
      setAddError(refusalOf(error, locale))
    }
  }

  /** Opens the confirmation on the review as it is now: a line changed since is said first. */
  async function openFinalize() {
    const looked = review.data.version
    setConfirmError(null)
    setChangedSince(false)
    setConfirmVersion(null)
    setConfirming(true)
    setChecking(true)
    const fresh = await reload()
    setChecking(false)
    if (!fresh) {
      setConfirming(false)
      return
    }
    if (fresh.data.version !== looked) {
      setConfirming(false)
      setChangedSince(true)
      return
    }
    setConfirmVersion(fresh.data.version)
  }

  async function doFinalize() {
    if (confirmVersion === null) return
    setConfirmError(null)
    try {
      const finalized = await finalize.mutateAsync({ id: data.id, version: confirmVersion })
      queryClient.setQueryData(countKey, finalized)
      await refresh()
      toast.success(t(opening ? 'stock.confirm.openingFinalized' : 'stock.confirm.finalized'))
      setConfirming(false)
      router.replace(sheetHref)
    } catch (error) {
      const code = apiErrorCode(error)
      if (code === 'conflict' || code === 'count_incomplete') {
        // Lines changed since the manager looked: the review shows them now, nothing finalized.
        setConfirming(false)
        setChangedSince(true)
        await Promise.all([reload(), queryClient.invalidateQueries({ queryKey: countKey })])
        return
      }
      setConfirmError(refusalOf(error, locale))
    }
  }

  const date = businessDate(data.businessDate)
  const itemCount = data.materials.length
  let body: string
  let note: string
  if (opening) {
    body = term('stock.confirm.openingBody', profile, { count: itemCount, date })
    note =
      openingTotal === undefined
        ? t('stock.confirm.openingValueHidden')
        : t('stock.confirm.openingValue', { amount: ltrIsolate(money(openingTotal)) })
  } else {
    body = where
      ? term('stock.confirm.finalizeBody', profile, {
          count: itemCount,
          branch: isolate(where),
          date,
        })
      : term('stock.confirm.finalizeBodyHere', profile, { count: itemCount, date })
    // "Everything matches" only when no line's quantity differs; the value is said on its own (a
    // −72 and a +72, or an unpriced material counted short, are differences at AED 0).
    if (summary.differing === 0) note = t('stock.confirm.diffNone')
    else {
      const total = summary.total
      const side = total ? differenceSide(total) : 'same'
      const value =
        total === undefined || total === null
          ? t('stock.confirm.diffHidden', { date })
          : side === 'same'
            ? t('stock.confirm.diffZero', { amount: ltrIsolate(money('0')) })
            : t(side === 'less' ? 'stock.confirm.diffLess' : 'stock.confirm.diffMore', {
                amount: ltrIsolate(money(magnitude(total))),
                date,
              })
      note = `${t('stock.confirm.diffSome', { count: summary.differing })} ${value}`
    }
  }

  return (
    <PageContainer>
      <Link
        href={sheetHref}
        className="-ms-2 -mt-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
        {t('stock.review.backToSheet')}
      </Link>
      <header className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {t('stock.review.title')}
            </h1>
            <StatusBadge status={data.status} kind="count" />
          </div>
          <p className="mt-1.5 text-muted-foreground">
            {t(opening ? 'stock.sheet.openingTitle' : 'stock.sheet.title', { date })}
            {where && !opening ? (
              <>
                {' · '}
                <bdi>{where}</bdi>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={
              notCounted.length > 0 ||
              lines.length === 0 ||
              (opening && missing.length > 0) ||
              closed !== null
            }
            onClick={() => void openFinalize()}
          >
            <CheckCheckIcon aria-hidden />
            {t('stock.review.finalize')}
          </Button>
        </div>
      </header>

      <div className="space-y-5">
        {changedSince ? (
          <FormAlert tone="error">
            <span data-review-changed>{t('stock.review.changed')}</span>
          </FormAlert>
        ) : null}
        <FormAlert tone="info">
          {opening ? term('stock.review.openingIntro', profile) : t('stock.review.intro', { date })}
        </FormAlert>
        {closed && closedThrough ? (
          <FormAlert tone="error">
            {t('stock.confirm.closed', { date: businessDate(closedThrough) })}
          </FormAlert>
        ) : null}
        {review.meta.redacted.length > 0 ? (
          <p className="text-sm text-muted-foreground">{t('stock.onHand.lockedNote')}</p>
        ) : null}

        {notCounted.length > 0 ? (
          <Panel title={t('stock.review.notCountedTitle')} hint={t('stock.review.notCountedHint')}>
            <ul data-not-counted className="space-y-1 text-sm">
              {notCounted.map((line) => (
                <li key={line.lineId}>
                  <bdi className="font-medium">{line.materialName}</bdi>
                  {branches ? (
                    <span className="text-muted-foreground">
                      {' · '}
                      <bdi>{line.locationName}</bdi>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            <Button asChild variant="outline" className="mt-4">
              <Link href={sheetHref}>{t('stock.review.backToSheet')}</Link>
            </Button>
          </Panel>
        ) : null}

        {opening && missing.length > 0 ? (
          <Panel title={t('stock.review.missingTitle')} hint={t('stock.review.missingHint')}>
            <ul data-missing-lines className="space-y-1 text-sm">
              {missing.map((line) => (
                <li key={`${line.locationId}:${line.materialId}`}>
                  <bdi className="font-medium">{materials.get(line.materialId)?.name ?? ''}</bdi>
                  <span className="text-muted-foreground">
                    {' · '}
                    <bdi>{line.locationName}</bdi>
                  </span>
                </li>
              ))}
            </ul>
            {addError ? (
              <FormAlert tone="error" className="mt-4">
                {say(addError)}
              </FormAlert>
            ) : null}
            <Button
              variant="outline"
              className="mt-4"
              disabled={addLines.isPending}
              onClick={() => void addMissing()}
            >
              <PlusIcon aria-hidden />
              {addLines.isPending ? t('stock.review.addingBranch') : t('stock.review.addBranch')}
            </Button>
          </Panel>
        ) : null}

        {opening ? (
          <Panel title={t('stock.review.openingsTitle')}>
            <ul className="divide-y" aria-label={t('stock.review.openingsTitle')}>
              {review.data.openings.map((item) => {
                const material = materials.get(item.materialId)
                if (!material) return null
                return (
                  <li
                    key={item.materialId}
                    data-opening={item.materialId}
                    className="space-y-2 py-3 first:pt-0 last:pb-0"
                  >
                    <p className="font-medium break-words">
                      <bdi>{material.name}</bdi>
                    </p>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-3">
                      <Cell label={t('stock.review.counted')}>
                        <StockQty material={material} qty={item.countedQty} />
                      </Cell>
                      <Cell label={t('stock.review.average')}>
                        {item.avgPerUnit === undefined ? (
                          <Locked category="cost" />
                        ) : item.avgPerUnit === null ? (
                          <span className="text-muted-foreground">{t('stock.onHand.noPrice')}</span>
                        ) : (
                          <bdi className="tabular-nums">
                            {unitCost(item.avgPerUnit)} {t(`units.per.${material.unit}`)}
                          </bdi>
                        )}
                      </Cell>
                      <Cell label={t('stock.review.startsAt')}>
                        {item.value === undefined ? (
                          <Locked category="cost" />
                        ) : item.avgPerUnit === null ? (
                          <span className="text-xs text-muted-foreground">
                            {t('stock.review.noPrice')}
                          </span>
                        ) : (
                          <Money value={item.value} category="cost" />
                        )}
                      </Cell>
                    </div>
                  </li>
                )
              })}
            </ul>
          </Panel>
        ) : null}

        {counted.length > 0 ? (
          <Panel
            title={t('stock.view.lines')}
            hint={opening ? undefined : t('stock.review.differenceNote')}
          >
            <ul className="divide-y" aria-label={t('stock.view.lines')}>
              {counted.map((line) => {
                const material = materials.get(line.materialId)
                if (!material) return null
                return (
                  <li
                    key={line.lineId}
                    data-review-line={line.lineId}
                    className="space-y-2 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="min-w-0 font-medium break-words">
                        <bdi>{line.materialName}</bdi>
                        {branches ? (
                          <span className="font-normal text-muted-foreground">
                            {' · '}
                            <bdi>{line.locationName}</bdi>
                          </span>
                        ) : null}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={clearing !== null}
                        aria-label={t('stock.review.countAgainFor', {
                          name: isolate(line.materialName),
                        })}
                        onClick={() => void countAgain(line.lineId, line.materialName)}
                      >
                        <RotateCcwIcon aria-hidden />
                        {t('stock.review.countAgain')}
                      </Button>
                    </div>
                    <div
                      className={cn(
                        'grid gap-x-4 gap-y-2',
                        opening ? 'grid-cols-1' : 'grid-cols-2 md:grid-cols-4',
                      )}
                    >
                      <Cell label={t('stock.review.counted')}>
                        <StockQty material={material} qty={line.countedQty!} />
                      </Cell>
                      {!opening && line.expectedQty !== null ? (
                        <>
                          <Cell label={t('stock.review.expected')}>
                            <StockQty material={material} qty={line.expectedQty} />
                          </Cell>
                          <Cell label={t('stock.review.difference')}>
                            <Difference material={material} qty={line.differenceQty ?? '0'} />
                          </Cell>
                          <Cell label={t('stock.review.totalDifference')}>
                            <DifferenceValue value={line.differenceValue} />
                          </Cell>
                        </>
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ul>
            {!opening && summary.total !== null ? (
              <p data-review-total className="mt-4 border-t pt-3 text-sm font-medium">
                {t('stock.review.totalDifference')}: <DifferenceValue value={summary.total} />
              </p>
            ) : null}
          </Panel>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirming}
        icon={CheckCheckIcon}
        title={t(opening ? 'stock.confirm.openingTitle' : 'stock.confirm.finalizeTitle')}
        body={body}
        note={
          <>
            {note} {opening ? null : t('stock.confirm.finalizeNote')}
          </>
        }
        action={t('stock.review.finalize')}
        busyLabel={checking ? t('stock.review.checking') : t('stock.confirm.finalizing')}
        busy={finalize.isPending || checking}
        error={confirmError}
        disabled={confirmVersion === null}
        onConfirm={() => void doFinalize()}
        onClose={() => setConfirming(false)}
      />
    </PageContainer>
  )
}

function ReviewLoader({ countId }: { countId: string }) {
  const trpc = useTRPC()
  const { data: context } = useBusinessContext()
  const books = useBooks()
  const manages = context !== undefined && mayManageCounts(context)
  const count = useQuery({
    ...trpc.count.get.queryOptions({ id: countId }),
    enabled: manages,
    refetchInterval: (query) => (draftRefresh(query) ? DRAFT_REFRESH_MS : false),
    refetchOnWindowFocus: (query) => (draftRefresh(query) ? 'always' : true),
  })
  const draft = count.data?.data.status === 'draft'
  // A first count is reviewed only by a manager who works in every branch.
  const changes =
    context !== undefined &&
    count.data !== undefined &&
    mayChangeCount(context, count.data.data.kind)
  // Read afresh each time it opens, every little while, and on coming back: others may have counted
  // since (several counters, Q6).
  const review = useQuery({
    ...trpc.count.review.queryOptions({ id: countId }),
    enabled: manages && draft && changes,
    refetchOnMount: 'always',
    refetchInterval: DRAFT_REFRESH_MS,
    refetchOnWindowFocus: 'always',
  })
  if (!context) return null
  if (!manages) return <Forbidden />
  if (count.isError && apiErrorCode(count.error) === 'not_found') return <NotFound />
  if (count.data && !draft) {
    if (!books.data) return <CountLoading />
    return (
      <CountView
        result={count.data}
        today={books.data.today}
        closedThrough={books.data.closedThrough}
        timeZone={books.data.timeZone}
      />
    )
  }
  if (count.data && !changes) return <Forbidden />
  const error = count.error ?? review.error ?? books.error
  if (error && (!count.data || !review.data || !books.data)) {
    return (
      <PageContainer>
        <LoadError
          error={error}
          onRetry={() => {
            void count.refetch()
            void review.refetch()
            void books.refetch()
          }}
        />
      </PageContainer>
    )
  }
  if (!count.data || !review.data || !books.data) return <CountLoading />
  return (
    <CountReview
      count={count.data}
      review={review.data}
      today={books.data.today}
      closedThrough={books.data.closedThrough}
      reload={async () => {
        const read = await review.refetch()
        return read.isError ? undefined : read.data
      }}
    />
  )
}

/** One count (its sheet, or as finalized), inside the module's gate. */
export function CountPage({ countId }: { countId: string }) {
  return (
    <ModuleGate moduleId="inventory" entryId="stock">
      <OneCount countId={countId} />
    </ModuleGate>
  )
}

/** A count's review (managers), inside the module's gate. */
export function CountReviewPage({ countId }: { countId: string }) {
  return (
    <ModuleGate moduleId="inventory" entryId="stock">
      <ReviewLoader countId={countId} />
    </ModuleGate>
  )
}
