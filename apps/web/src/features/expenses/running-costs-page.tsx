'use client'

import { useTRPC } from '@bizcost/app-core'
import type { RunningCostDto, RunningCostListInput } from '@bizcost/contracts'
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import { PlusIcon, RepeatIcon, SearchIcon, SearchXIcon, TagsIcon, XIcon } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ModuleGate } from '@/components/shell/module-gate'
import { PageContainer } from '@/components/shell/page-container'
import { LoadError } from '@/components/states/query-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ListEmpty, ListSkeleton } from '@/features/catalog/catalog-list'
import { Money, useBusinessDate, useMoney } from '@/features/purchasing/amounts'
import { Panel } from '@/features/purchasing/panel'
import { can } from '@/features/settings/sections'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { CategoriesSheet } from './categories-sheet'
import { canManageCategories, useCostCategories } from './data'
import { RunningCostSheet } from './running-cost-sheet'

// Running Costs (M2 Step 5; D-116, D-169): "What do you pay to run your business?" The regular amounts
// the business pays (rent, salaries, electricity…), each with how often, turned into a monthly amount,
// and what they come to a month now (the running costs active today, whatever is shown). Quick picks
// of the shared categories (the owner's list first) open the form with the name and category filled
// in. A running cost is never posted: it counts from its start to its end. Everyone with
// running_costs.items.view sees the list; running_costs.items.manage adds and changes them. Amounts
// are costs: a member who may not see them sees a lock (redaction, D-165).

const STATES = ['all', 'active', 'upcoming', 'ended'] as const
type StateFilter = (typeof STATES)[number]
const SEARCH_DELAY_MS = 300

/** The list's search (`?q=`) and which to show (`?state=`), read from and written to the address. */
function useParamsState() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const stateParam = params.get('state')
  const state: StateFilter = (STATES as readonly (string | null)[]).includes(stateParam)
    ? (stateParam as StateFilter)
    : 'all'
  const search = (params.get('q') ?? '').trim()
  const set = (next: { search?: string; state?: StateFilter }) => {
    const query = new URLSearchParams(params.toString())
    if (next.search !== undefined) {
      if (next.search.trim()) query.set('q', next.search.trim())
      else query.delete('q')
    }
    if (next.state !== undefined) {
      if (next.state === 'all') query.delete('state')
      else query.set('state', next.state)
    }
    const text = query.toString()
    router.replace(text ? `${pathname}?${text}` : pathname, { scroll: false })
  }
  return { state, search, set }
}

/** The search box (it searches a moment after typing) and which running costs to show. */
function Toolbar({
  search,
  state,
  onChange,
}: {
  search: string
  state: StateFilter
  onChange: (next: { search?: string; state?: StateFilter }) => void
}) {
  const { t } = useTranslation()
  const [text, setText] = useState(search)
  const typed = useRef(search)
  const change = useRef(onChange)
  useEffect(() => {
    change.current = onChange
  })
  useEffect(() => {
    if (search !== typed.current.trim()) {
      typed.current = search
      setText(search)
    }
  }, [search])
  useEffect(() => {
    if (text.trim() === search) return
    const timer = setTimeout(() => change.current({ search: text }), SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [text, search])
  return (
    <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
      <div role="search" className="relative min-w-0 flex-1">
        <SearchIcon
          aria-hidden
          className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          aria-label={t('catalog.list.searchLabel')}
          placeholder={t('expenses.running.searchPlaceholder')}
          autoComplete="off"
          enterKeyHint="search"
          value={text}
          onChange={(event) => {
            typed.current = event.target.value
            setText(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onChange({ search: text })
          }}
          className="ps-9 pe-11 [unicode-bidi:plaintext] [&::-webkit-search-cancel-button]:hidden"
        />
        {text ? (
          <button
            type="button"
            aria-label={t('catalog.list.clearSearch')}
            onClick={() => {
              typed.current = ''
              setText('')
              onChange({ search: '' })
            }}
            className="absolute end-0 top-0 flex size-11 items-center justify-center rounded-lg text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring"
          >
            <XIcon aria-hidden className="size-4" />
          </button>
        ) : null}
      </div>
      <fieldset className="flex shrink-0 rounded-lg bg-muted p-1">
        <legend className="sr-only">{t('expenses.running.states.label')}</legend>
        {STATES.map((value) => (
          <label key={value} className="relative flex-1 lg:flex-none">
            <input
              type="radio"
              name="running-cost-state"
              value={value}
              checked={state === value}
              onChange={() => onChange({ state: value })}
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
              {t(`expenses.running.states.${value}`)}
            </span>
          </label>
        ))}
      </fieldset>
    </div>
  )
}

/** When it counts: since when (and until when), from when, or when it ended (each kept on a line). */
function When({ cost }: { cost: RunningCostDto }) {
  const { t } = useTranslation()
  const businessDate = useBusinessDate()
  const part = (text: string) => <span className="whitespace-nowrap">{text}</span>
  if (cost.state === 'ended' && cost.endsOn) {
    return part(t('expenses.running.ended', { date: businessDate(cost.endsOn) }))
  }
  if (cost.state === 'upcoming') {
    return part(t('expenses.running.startsOn', { date: businessDate(cost.startsOn) }))
  }
  return (
    <>
      {part(t('expenses.running.since', { date: businessDate(cost.startsOn) }))}
      {cost.endsOn ? (
        <> {part(t('expenses.running.until', { date: businessDate(cost.endsOn) }))}</>
      ) : null}
    </>
  )
}

/**
 * One running cost: its name and state, its category and when it counts; the amount as it is paid
 * and, when not monthly, what it makes a month (at the end of the row from 640px, under the rest on a
 * phone, so the words keep their room).
 */
function RunningCostRow({ cost, onOpen }: { cost: RunningCostDto; onOpen?: () => void }) {
  const { t } = useTranslation()
  const money = useMoney()
  const face: ReactNode = (
    <>
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-xl',
          cost.state === 'active' ? 'bg-accent text-primary' : 'bg-muted text-muted-foreground',
        )}
      >
        <RepeatIcon aria-hidden className="size-5" />
      </span>
      <span className="min-w-0 flex-1 sm:flex sm:items-start sm:justify-between sm:gap-4">
        <span className="block min-w-0">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span dir="auto" className="min-w-0 font-medium break-words">
              {cost.name}
            </span>
            {cost.state === 'active' ? null : (
              <Badge tone={cost.state === 'upcoming' ? 'primary' : 'neutral'}>
                {t(`expenses.running.badge.${cost.state}`)}
              </Badge>
            )}
          </span>
          <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
            <bdi>{cost.categoryName}</bdi>
            {' · '}
            <When cost={cost} />
          </span>
        </span>
        <span className="mt-1.5 block sm:mt-0 sm:shrink-0 sm:pt-0.5 sm:text-end">
          <span data-amount className="block font-medium">
            {cost.amount === undefined ? (
              <Money value={undefined} category="cost" />
            ) : (
              <bdi className="tabular-nums">
                {t(`expenses.running.every.${cost.frequency}`, { amount: money(cost.amount) })}
              </bdi>
            )}
          </span>
          {cost.frequency !== 'monthly' && cost.monthlyAmount !== undefined ? (
            <span data-monthly className="block text-sm text-muted-foreground">
              <bdi className="tabular-nums">
                {t('expenses.running.perMonth', { amount: money(cost.monthlyAmount) })}
              </bdi>
            </span>
          ) : null}
        </span>
      </span>
    </>
  )
  if (!onOpen) {
    return (
      <div data-running-cost={cost.name} className="flex items-start gap-3 px-4 py-3.5 sm:px-5">
        {face}
      </div>
    )
  }
  return (
    <button
      type="button"
      data-running-cost={cost.name}
      onClick={onOpen}
      className="flex w-full items-start gap-3 px-4 py-3.5 text-start transition-colors outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset sm:px-5"
    >
      {face}
    </button>
  )
}

type Editing = {
  cost?: RunningCostDto
  preset?: { name: string; categoryId: string }
  key: string
}

function RunningCostsList() {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const { data: context } = useBusinessContext()
  const { state, search, set } = useParamsState()
  const input: RunningCostListInput = { state, search: search || undefined }
  const list = useInfiniteQuery(
    trpc.runningCost.list.infiniteQueryOptions(input, {
      getNextPageParam: (page) => page.data.nextCursor,
      placeholderData: keepPreviousData,
    }),
  )
  const canManage = context ? can(context, 'running_costs.items.manage') : false
  const { categories } = useCostCategories(canManage)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [categoriesOpen, setCategoriesOpen] = useState(false)
  if (!context) return null
  const first = list.data?.pages[0]?.data
  const items = list.data?.pages.flatMap((page) => page.data.items) ?? []
  const filtered = state !== 'all' || search !== ''
  // No running cost at all yet: the question and the quick picks, without the tools.
  const firstTime = !filtered && list.isSuccess && !list.isPlaceholderData && items.length === 0
  const title = t('common.nav.running_costs')
  const today = first?.today
  const quickPicks = categories.filter((category) => category.archivedAt === null)
  const add = (preset?: Editing['preset']) => setEditing({ preset, key: `new-${Date.now()}` })

  return (
    <PageContainer>
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
          <p className="mt-1.5 max-w-2xl text-lg font-medium">{t('expenses.running.question')}</p>
          <p className="mt-1 max-w-2xl text-muted-foreground">{t('expenses.running.intro')}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {canManageCategories(context) ? (
            <Button variant="outline" size="lg" onClick={() => setCategoriesOpen(true)}>
              <TagsIcon aria-hidden />
              {t('expenses.list.categories')}
            </Button>
          ) : null}
          {canManage && !firstTime ? (
            <Button size="lg" disabled={!today} onClick={() => add()}>
              <PlusIcon aria-hidden />
              {t('expenses.running.add')}
            </Button>
          ) : null}
        </div>
      </header>

      <div className="space-y-5">
        {first && !firstTime ? (
          <section
            data-monthly-total
            aria-label={t('expenses.running.monthlyTotal')}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-2xl bg-card px-4 py-4 shadow-sm ring-1 ring-foreground/[0.06] sm:px-5"
          >
            <div className="min-w-0">
              <p className="font-semibold">{t('expenses.running.monthlyTotal')}</p>
              <p className="text-sm text-muted-foreground">
                {t('expenses.running.monthlyTotalHint')}
              </p>
            </div>
            <Money
              value={first.monthlyTotal}
              currency={first.currency}
              category="cost"
              className="text-2xl font-semibold"
            />
          </section>
        ) : null}

        {canManage && today && quickPicks.length > 0 ? (
          <Panel title={t('expenses.running.quickTitle')} hint={t('expenses.running.quickHint')}>
            <ul
              aria-label={t('expenses.running.quickTitle')}
              className={cn(
                'flex gap-2',
                // Once there are running costs, a phone keeps them to one row that scrolls sideways.
                firstTime
                  ? 'flex-wrap'
                  : 'max-sm:-mx-4 max-sm:overflow-x-auto max-sm:px-4 max-sm:pb-1 sm:flex-wrap',
              )}
            >
              {quickPicks.map((category) => (
                <li key={category.id} className="shrink-0">
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full"
                    onClick={() => add({ name: category.name, categoryId: category.id })}
                  >
                    <PlusIcon aria-hidden />
                    <bdi>{category.name}</bdi>
                  </Button>
                </li>
              ))}
              <li className="shrink-0">
                <Button
                  type="button"
                  variant="ghost"
                  className="rounded-full"
                  onClick={() => add()}
                >
                  <PlusIcon aria-hidden />
                  {t('expenses.running.quickOther')}
                </Button>
              </li>
            </ul>
          </Panel>
        ) : null}

        <div>
          {firstTime ? null : <Toolbar search={search} state={state} onChange={set} />}
          {list.isPending ? (
            <ListSkeleton />
          ) : list.isError && !list.data ? (
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
          ) : items.length === 0 ? (
            filtered ? (
              <ListEmpty
                icon={SearchXIcon}
                title={t('expenses.running.noMatches')}
                body={t('expenses.running.noMatchesHint')}
              />
            ) : (
              <ListEmpty
                icon={RepeatIcon}
                title={t('expenses.running.empty.title')}
                body={
                  canManage ? t('expenses.running.empty.body') : t('expenses.running.empty.viewer')
                }
              />
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
                {items.map((cost) => (
                  <li key={cost.id}>
                    <RunningCostRow
                      cost={cost}
                      onOpen={
                        canManage && cost.amount !== undefined
                          ? () => setEditing({ cost, key: cost.id })
                          : undefined
                      }
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
        </div>
      </div>

      {editing && today ? (
        <RunningCostSheet
          key={editing.key}
          cost={editing.cost}
          preset={editing.preset}
          today={today}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {categoriesOpen ? <CategoriesSheet onClose={() => setCategoriesOpen(false)} /> : null}
    </PageContainer>
  )
}

/** The Running Costs page: the list inside the module's gate. */
export function RunningCostsPage() {
  return (
    <ModuleGate moduleId="running_costs" entryId="running_costs">
      <RunningCostsList />
    </ModuleGate>
  )
}
