'use client'

import { apiErrorKey, useTRPC } from '@bizcost/app-core'
import { STOCK_PAGE_SIZE_MAX, type CountDto, type CountResultDto } from '@bizcost/contracts'
import { nameKey, newId } from '@bizcost/domain'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useId, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { isolate } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useBusinessDate } from '@/features/documents/amounts'
import { closedFor, firstOpenDay } from '@/features/documents/books'
import { refusalOf, useSayRefusal } from '@/features/documents/refusal'
import { SearchBox } from '@/features/documents/search-box'
import { useLocale, useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { firstCountMax, latestCount, pickUpTo } from './count-draft'
import { hasBranches, useAllTracked, useRefreshStock, useStockBranches } from './data'

// Starting counts (M4 Step 2; D-339 Q2, Q5): "Start tracking your stock" picks materials not tracked
// yet for a first count (all of them, or a few), which covers every branch on one day; "Count stock"
// starts a count of one branch, of everything tracked or a few; "Add materials" adds to a draft. Each
// says up front what the server would refuse later: the first count's day comes after nothing
// recorded for its materials (today is best), a count's day comes after the last count of each of
// its materials in its branch, and a first count takes at most STOCK_COUNT_LINES_MAX lines (a line
// per material and branch). A refusal names what it is about (STOCK_TRACKED, BRANCH_HAS_STOCK…).

interface PickItem {
  readonly id: string
  readonly name: string
  /** Shown under the name (e.g. "Already on a draft first count", with a link). */
  readonly note?: ReactNode
  /** Can't be picked (already on this count, or on another draft). */
  readonly disabled?: boolean
}

/** A list of materials to tick, with what is picked counted. */
function PickList({
  legend,
  items,
  picked,
  onToggle,
  empty,
  more,
}: {
  legend: string
  items: readonly PickItem[]
  picked: ReadonlySet<string>
  onToggle: (id: string, on: boolean) => void
  /** What the list says when nothing is in it. */
  empty: string
  /** "Show more" while more pages wait. */
  more?: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <fieldset>
      <legend className="sr-only">{legend}</legend>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-2" data-pick-list>
          {items.map((item) => {
            const on = picked.has(item.id)
            return (
              <li key={item.id}>
                <label
                  className={cn(
                    'flex min-h-11 items-start gap-3 rounded-xl border p-3',
                    item.disabled
                      ? 'cursor-default bg-muted/40 text-muted-foreground'
                      : 'cursor-pointer',
                    on && 'border-primary/40 bg-accent/40',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={item.disabled}
                    onChange={(event) => onToggle(item.id, event.target.checked)}
                    className="mt-0.5 size-5 shrink-0 accent-primary"
                  />
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="block font-medium break-words">
                      <bdi>{item.name}</bdi>
                    </span>
                    {item.note ? (
                      <span className="mt-0.5 block text-muted-foreground">{item.note}</span>
                    ) : null}
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
      )}
      {more ? <div className="mt-3 flex justify-center">{more}</div> : null}
      <p className="mt-3 text-sm text-muted-foreground" aria-live="polite">
        {picked.size > 0 ? t('stock.start.picked', { count: picked.size }) : null}
      </p>
    </fieldset>
  )
}

/** The day of a count: today by default, never after it, and a word about the closed books. */
function DayField({
  value,
  onChange,
  today,
  closedThrough,
  label,
  hint,
}: {
  value: string
  onChange: (day: string) => void
  today: string
  closedThrough: string | null
  label: string
  hint: ReactNode
}) {
  const { t } = useTranslation()
  const id = useId()
  const businessDate = useBusinessDate()
  const closed = closedFor(value, today, closedThrough)
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input
        id={id}
        type="date"
        required
        max={today}
        min={firstOpenDay(today, closedThrough)}
        value={value}
        aria-describedby={`${id}-hint`}
        onChange={(event) => {
          const day = event.target.value
          if (day && day <= today) onChange(day)
        }}
      />
      <div id={`${id}-hint`} className="space-y-1 text-sm text-muted-foreground">
        {hint}
        {closed && closedThrough ? (
          <p className="text-destructive">
            {t('stock.confirm.closed', { date: businessDate(closedThrough) })}
          </p>
        ) : null}
      </div>
    </div>
  )
}

/** A refusal said with the names it is about, in the page's language. */
function useRefusal() {
  const { locale } = useLocale()
  const say = useSayRefusal()
  return (error: unknown): string => say(refusalOf(error, locale))
}

/**
 * "Start tracking your stock" (counts.manage, every branch): materials not tracked yet, the day, then
 * a draft first count opens.
 */
export function StartTrackingSheet({
  today,
  closedThrough,
  onClose,
}: {
  today: string
  closedThrough: string | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const term = useTerminology()
  const trpc = useTRPC()
  const router = useRouter()
  const refresh = useRefreshStock()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const { live, ready: branchesReady } = useStockBranches(context)
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [capped, setCapped] = useState(false)
  const [loadingAll, setLoadingAll] = useState(false)
  const [day, setDay] = useState(today)
  const [countId] = useState(() => newId())
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const start = useMutation(trpc.count.start.mutationOptions())
  const untracked = useInfiniteQuery(
    trpc.stock.untracked.infiniteQueryOptions(
      { search: search || undefined, limit: STOCK_PAGE_SIZE_MAX },
      { getNextPageParam: (page) => page.nextCursor },
    ),
  )
  const base = `/b/${businessId}/stock/counts`
  // A line per material and live branch, STOCK_COUNT_LINES_MAX lines at most.
  const max = firstCountMax(live.length)
  const listed = (untracked.data?.pages ?? []).flatMap((page) => page.items)
  // What "Select all" can pick: every material listed not already on another draft first count.
  const selectable = listed.filter((item) => item.openingDraftId === null)
  const items: PickItem[] = listed.map(({ material, openingDraftId }) => ({
    id: material.id,
    name: material.name,
    disabled: openingDraftId !== null,
    note: openingDraftId ? (
      <>
        {t('stock.start.onDraft')}{' '}
        <Link
          href={`${base}/${openingDraftId}`}
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          {t('stock.start.openDraft')}
        </Link>
      </>
    ) : undefined,
  }))
  const closed = closedFor(day, today, closedThrough)
  const busy = start.isPending
  const refusal = useRefusal()
  const overMax = picked.size > max

  /** Picks every material not tracked yet (each page read first), as many as one first count takes. */
  async function selectAll() {
    setLoadingAll(true)
    setError(null)
    try {
      let pages = untracked.data?.pages ?? []
      let more = untracked.hasNextPage
      while (more) {
        const read = await untracked.fetchNextPage()
        if (read.isError) throw read.error
        pages = read.data?.pages ?? pages
        more = read.hasNextPage
      }
      const ids = pages
        .flatMap((page) => page.items)
        .filter((item) => item.openingDraftId === null)
        .map((item) => item.material.id)
      const next = pickUpTo(picked, ids, max)
      setPicked(next.picked)
      setCapped(next.capped)
    } catch (caught) {
      setError(refusal(caught))
    } finally {
      setLoadingAll(false)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitted(true)
    setError(null)
    if (picked.size === 0 || overMax || closed || busy || !branchesReady) return
    try {
      await start.mutateAsync({
        id: countId,
        kind: 'opening',
        businessDate: day,
        materialIds: [...picked],
      })
      await refresh()
      router.push(`${base}/${countId}`)
      onClose()
    } catch (caught) {
      setError(refusal(caught))
    }
  }

  return (
    <Sheet open onOpenChange={(open) => !open && !busy && onClose()}>
      <SheetContent closeLabel={t('actions.close')}>
        <form
          method="post"
          noValidate
          onSubmit={(event) => void submit(event)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <SheetHeader>
            <SheetTitle>{t('stock.start.title')}</SheetTitle>
            <SheetDescription>{t('stock.start.description')}</SheetDescription>
          </SheetHeader>
          <SheetBody className="space-y-6">
            {error ? <FormAlert tone="error">{error}</FormAlert> : null}
            <DayField
              value={day}
              onChange={setDay}
              today={today}
              closedThrough={closedThrough}
              label={t('stock.start.day')}
              hint={
                <>
                  <p>
                    {context && hasBranches(context)
                      ? t('stock.start.dayHint')
                      : t('stock.start.dayHintOne')}
                  </p>
                  <p>{t('stock.start.dayRule')}</p>
                </>
              }
            />
            <div className="space-y-3">
              <h3 className="text-sm font-medium">
                {term('stock.start.pick', context?.terminologyProfile)}
              </h3>
              <SearchBox value={search} placeholder={t('stock.start.find')} onChange={setSearch} />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <Button
                  type="button"
                  variant="link"
                  className="h-11 px-0"
                  disabled={loadingAll || untracked.isPending || !branchesReady}
                  onClick={() => void selectAll()}
                >
                  {loadingAll
                    ? t('status.loading')
                    : untracked.isSuccess && !untracked.hasNextPage
                      ? t('stock.start.selectAllCount', { total: selectable.length })
                      : t('stock.start.selectAll')}
                </Button>
                {picked.size > 0 ? (
                  <Button
                    type="button"
                    variant="link"
                    className="h-11 px-0"
                    onClick={() => {
                      setPicked(new Set())
                      setCapped(false)
                    }}
                  >
                    {t('stock.start.clearAll')}
                  </Button>
                ) : null}
              </div>
              {submitted && picked.size === 0 ? (
                <p className="text-sm text-destructive">{t('stock.start.pickOne')}</p>
              ) : null}
              {overMax ? (
                <p data-over-max className="text-sm text-destructive">
                  {t('stock.start.overMax', { max })}
                </p>
              ) : capped ? (
                <p data-capped className="text-sm text-muted-foreground">
                  {t('stock.start.tooMany', { max })}
                </p>
              ) : null}
              {untracked.isPending ? (
                <p className="text-sm text-muted-foreground">{t('status.loading')}</p>
              ) : untracked.isError ? (
                <FormAlert tone="error">{t(apiErrorKey(untracked.error))}</FormAlert>
              ) : (
                <PickList
                  legend={term('stock.start.pick', context?.terminologyProfile)}
                  items={items}
                  picked={picked}
                  onToggle={(id, on) => {
                    setCapped(false)
                    setPicked((current) => {
                      const next = new Set(current)
                      if (on) next.add(id)
                      else next.delete(id)
                      return next
                    })
                  }}
                  empty={search ? t('stock.start.noMatch') : t('stock.start.allTracked')}
                  more={
                    untracked.hasNextPage ? (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={untracked.isFetchingNextPage}
                        onClick={() => void untracked.fetchNextPage()}
                      >
                        {untracked.isFetchingNextPage
                          ? t('status.loading')
                          : t('catalog.list.showMore')}
                      </Button>
                    ) : null
                  }
                />
              )}
            </div>
          </SheetBody>
          <SheetFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              {t('actions.cancel')}
            </Button>
            <Button type="submit" disabled={busy || closed !== null || overMax || !branchesReady}>
              {busy ? t('stock.start.starting') : t('stock.start.action')}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

/** "Count stock" (counts.manage): the branch, the day, and everything tracked or a few. */
export function NewCountSheet({
  today,
  closedThrough,
  initialBranch,
  onClose,
}: {
  today: string
  closedThrough: string | null
  /** The branch the page shows (its filter), picked first when it is one of the member's. */
  initialBranch: string | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const term = useTerminology()
  const trpc = useTRPC()
  const router = useRouter()
  const refresh = useRefreshStock()
  const businessDate = useBusinessDate()
  const refusal = useRefusal()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const branchId = useId()
  const tracked = useAllTracked(true)
  // The live branches the member works in (stock.list): `branches` with the branches setting.
  const { branches, live, ready: branchesReady } = useStockBranches(context)
  const [picking, setPicking] = useState<string | null>(initialBranch)
  // The branch counted: the one picked when it is one of theirs, else the first (never a select
  // showing a branch while none is chosen); null without the branches setting (the business's one
  // location, which the API takes when none is named).
  const locationId = branches.find((branch) => branch.id === picking)?.id ?? branches[0]?.id ?? null
  // Where its last counts are read: that branch, or the one live location without the setting.
  const countedIn = locationId ?? (live.length === 1 ? live[0]!.id : null)
  const [day, setDay] = useState(today)
  const [which, setWhich] = useState<'all' | 'some'>('all')
  const [find, setFind] = useState('')
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [countId] = useState(() => newId())
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const start = useMutation(trpc.count.start.mutationOptions())
  const chosen =
    which === 'all' ? tracked.items : tracked.items.filter((i) => picked.has(i.material.id))
  const latest = latestCount(chosen, countedIn)
  const tooEarly = latest !== null && day <= latest.date
  const closed = closedFor(day, today, closedThrough)
  const busy = start.isPending
  const findKey = nameKey(find)
  const shown = findKey
    ? tracked.items.filter((item) => nameKey(item.material.name).includes(findKey))
    : tracked.items

  async function submit(event: FormEvent) {
    event.preventDefault()
    setSubmitted(true)
    setError(null)
    if (busy || tooEarly || closed || !branchesReady || (which === 'some' && picked.size === 0))
      return
    try {
      await start.mutateAsync({
        id: countId,
        kind: 'count',
        businessDate: day,
        locationId,
        materialIds: which === 'all' ? 'all' : [...picked],
      })
      await refresh()
      router.push(`/b/${businessId}/stock/counts/${countId}`)
      onClose()
    } catch (caught) {
      setError(refusal(caught))
    }
  }

  return (
    <Sheet open onOpenChange={(open) => !open && !busy && onClose()}>
      <SheetContent closeLabel={t('actions.close')}>
        <form
          method="post"
          noValidate
          onSubmit={(event) => void submit(event)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <SheetHeader>
            <SheetTitle>{t('stock.newCount.title')}</SheetTitle>
            <SheetDescription>{t('stock.newCount.description')}</SheetDescription>
          </SheetHeader>
          <SheetBody className="space-y-6">
            {error ? <FormAlert tone="error">{error}</FormAlert> : null}
            {branches.length > 1 ? (
              <div className="space-y-1.5">
                <label htmlFor={branchId} className="text-sm font-medium">
                  {t('stock.newCount.branch')}
                </label>
                <NativeSelect
                  id={branchId}
                  value={locationId ?? ''}
                  onChange={(event) => setPicking(event.target.value || null)}
                >
                  {branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ) : null}
            <DayField
              value={day}
              onChange={setDay}
              today={today}
              closedThrough={closedThrough}
              label={t('stock.newCount.day')}
              hint={
                <>
                  <p>{t('stock.newCount.dayHint')}</p>
                  {tooEarly && latest ? (
                    <p data-too-early className="text-destructive">
                      {t('stock.newCount.afterLast', {
                        date: businessDate(latest.date),
                        name: isolate(latest.name),
                      })}
                    </p>
                  ) : null}
                </>
              }
            />
            <fieldset className="space-y-3">
              <legend className="mb-2 text-sm font-medium">{t('stock.newCount.which')}</legend>
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
                {(['all', 'some'] as const).map((choice) => (
                  <label key={choice} className="relative min-w-0">
                    <input
                      type="radio"
                      name={`${branchId}-which`}
                      value={choice}
                      checked={which === choice}
                      onChange={() => setWhich(choice)}
                      className="peer sr-only"
                    />
                    <span
                      className={cn(
                        'flex min-h-11 cursor-pointer items-center justify-center rounded-md px-2 py-1.5 text-center text-sm font-medium text-muted-foreground transition-colors',
                        'peer-checked:bg-card peer-checked:text-foreground peer-checked:shadow-sm',
                        'peer-focus-visible:ring-3 peer-focus-visible:ring-ring',
                      )}
                    >
                      {choice === 'all'
                        ? term('stock.newCount.all', context?.terminologyProfile)
                        : t('stock.newCount.some')}
                    </span>
                  </label>
                ))}
              </div>
              {tracked.error ? (
                <FormAlert tone="error">{t(apiErrorKey(tracked.error))}</FormAlert>
              ) : !tracked.ready ? (
                <p className="text-sm text-muted-foreground">{t('status.loading')}</p>
              ) : tracked.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t('stock.newCount.nothingTracked')}
                </p>
              ) : which === 'some' ? (
                <>
                  <SearchBox
                    value={find}
                    placeholder={t('stock.newCount.find')}
                    onChange={setFind}
                  />
                  {submitted && picked.size === 0 ? (
                    <p className="text-sm text-destructive">{t('stock.newCount.pickOne')}</p>
                  ) : null}
                  <PickList
                    legend={t('stock.newCount.which')}
                    items={shown.map((item) => ({
                      id: item.material.id,
                      name: item.material.name,
                    }))}
                    picked={picked}
                    onToggle={(id, on) =>
                      setPicked((current) => {
                        const next = new Set(current)
                        if (on) next.add(id)
                        else next.delete(id)
                        return next
                      })
                    }
                    empty={t('stock.start.noMatch')}
                  />
                </>
              ) : null}
            </fieldset>
          </SheetBody>
          <SheetFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              {t('actions.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={
                busy || tooEarly || closed !== null || !branchesReady || tracked.items.length === 0
              }
            >
              {busy ? t('stock.newCount.starting') : t('stock.newCount.action')}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

/**
 * "Add materials" to a draft (a manager who may change it): for a first count, materials not tracked
 * yet; else tracked ones.
 */
export function AddItemsSheet({ count, onClose }: { count: CountDto; onClose: () => void }) {
  const { t } = useTranslation()
  const term = useTerminology()
  const { data: context } = useBusinessContext()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const refresh = useRefreshStock()
  const refusal = useRefusal()
  const opening = count.kind === 'opening'
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const add = useMutation(trpc.count.addLines.mutationOptions())
  const untracked = useInfiniteQuery({
    ...trpc.stock.untracked.infiniteQueryOptions(
      { search: search || undefined },
      { getNextPageParam: (page) => page.nextCursor },
    ),
    enabled: opening,
  })
  const tracked = useAllTracked(!opening)
  const on = useMemo(() => new Set(count.materials.map((m) => m.id)), [count.materials])
  const searchKey = nameKey(search)
  const items: PickItem[] = opening
    ? (untracked.data?.pages ?? [])
        .flatMap((page) => page.items)
        .filter((item) => !on.has(item.material.id))
        .map(({ material, openingDraftId }) => ({
          id: material.id,
          name: material.name,
          disabled: openingDraftId !== null,
          note: openingDraftId ? t('stock.start.onDraft') : undefined,
        }))
    : tracked.items
        .filter((item) => !on.has(item.material.id))
        .filter((item) => !searchKey || nameKey(item.material.name).includes(searchKey))
        .map((item) => ({ id: item.material.id, name: item.material.name }))
  const loading = opening ? untracked.isPending : !tracked.ready
  const busy = add.isPending

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (picked.size === 0 || busy) return
    try {
      const result: CountResultDto = await add.mutateAsync({
        countId: count.id,
        materialIds: [...picked],
      })
      queryClient.setQueryData(trpc.count.get.queryKey({ id: count.id }), result)
      void refresh()
      toast.success(t('stock.add.added', { count: picked.size }))
      onClose()
    } catch (caught) {
      setError(refusal(caught))
    }
  }

  return (
    <Sheet open onOpenChange={(open) => !open && !busy && onClose()}>
      <SheetContent closeLabel={t('actions.close')}>
        <form
          method="post"
          noValidate
          onSubmit={(event) => void submit(event)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <SheetHeader>
            <SheetTitle>{term('stock.add.title', context?.terminologyProfile)}</SheetTitle>
            <SheetDescription>
              {opening ? t('stock.add.openingDescription') : t('stock.add.description')}
            </SheetDescription>
          </SheetHeader>
          <SheetBody className="space-y-4">
            {error ? <FormAlert tone="error">{error}</FormAlert> : null}
            <SearchBox value={search} placeholder={t('stock.start.find')} onChange={setSearch} />
            {loading ? (
              <p className="text-sm text-muted-foreground">{t('status.loading')}</p>
            ) : (
              <PickList
                legend={term('stock.add.title', context?.terminologyProfile)}
                items={items}
                picked={picked}
                onToggle={(id, value) =>
                  setPicked((current) => {
                    const next = new Set(current)
                    if (value) next.add(id)
                    else next.delete(id)
                    return next
                  })
                }
                empty={search ? t('stock.start.noMatch') : t('stock.add.nothing')}
                more={
                  opening && untracked.hasNextPage ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={untracked.isFetchingNextPage}
                      onClick={() => void untracked.fetchNextPage()}
                    >
                      {untracked.isFetchingNextPage
                        ? t('status.loading')
                        : t('catalog.list.showMore')}
                    </Button>
                  ) : null
                }
              />
            )}
          </SheetBody>
          <SheetFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              {t('actions.cancel')}
            </Button>
            <Button type="submit" disabled={busy || picked.size === 0}>
              {busy ? t('stock.add.adding') : t('stock.add.action')}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
