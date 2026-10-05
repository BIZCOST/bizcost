'use client'

import { useTRPC } from '@bizcost/app-core'
import type { ExpenseListItemDto } from '@bizcost/contracts'
import { addMonths, monthOf } from '@bizcost/domain'
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  ChevronDownIcon,
  InfoIcon,
  PlusIcon,
  ReceiptIcon,
  SearchXIcon,
  SlidersHorizontalIcon,
  TagsIcon,
} from 'lucide-react'
import Link from 'next/link'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { FormAlert } from '@/components/form/form-alert'
import { isolate } from '@/components/form/use-message'
import { ModuleGate } from '@/components/shell/module-gate'
import { PageContainer } from '@/components/shell/page-container'
import { LoadError } from '@/components/states/query-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { ListEmpty, ListSkeleton } from '@/features/catalog/catalog-list'
import { Money, useBusinessDate, useBusinessMonth } from '@/features/documents/amounts'
import { SearchBox } from '@/features/documents/search-box'
import { hasModule } from '@/features/purchasing/data'
import { can, isSectionVisible, sectionPath } from '@/features/settings/sections'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { CategoriesSheet } from './categories-sheet'
import {
  canManageCategories,
  mayReviewExpenses,
  useCostCategories,
  useExpenseSettings,
} from './data'
import {
  EXPENSE_STATUS_FILTERS,
  isFiltered,
  listInput,
  readExpenseFilters,
  writeExpenseFilters,
  type ExpenseFilters,
} from './expense-filters'
import { MineExpenses } from './mine-expenses'
import { usePaysLabel } from './pays-choice'
import { ExpenseStatusBadge } from './status-badge'

// Expenses (M2 Step 5; PRODUCT.md §4 rule 13, D-164, D-168): the business's expenses, newest day
// first, with filters kept in the address (status, category, days, a search in what it was for, the
// number, the supplier's or the category's name). A row opens the expense: a draft in its editor,
// anything else as it was recorded, each saying what it pays when it says it (D-216). To a member
// who sees costs, the page says in one line that final expenses count in the business's costs in
// the month they are for, and, with Running Costs on and seen, that a running cost's bill takes the
// place of its regular amount and an extra expense counts on top (D-202, D-203, D-216). With
// approval on, it says so, and an approver is told when expenses wait for them; with approval off, a
// member who may finalize is told when drafts the team entered wait for them (D-184). Everyone with
// expenses.documents.view sees the list;
// expenses.documents.manage adds expenses and categories. Totals are supplier prices: a member who
// may not see them sees a lock (redaction, D-165). In a business with a team, "My expenses" lists
// the member's own with their amounts and what is owed to them (D-181); it is where a member who may
// not see supplier prices lands.

/** The two lists: every expense, or the member's own (`?view=mine` / `?view=all`). */
type ExpensesView = 'all' | 'mine'

function useView(fallback: ExpensesView): [ExpensesView, (view: ExpensesView) => void] {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const asked = params.get('view')
  const view: ExpensesView = asked === 'mine' || asked === 'all' ? asked : fallback
  return [
    view,
    (next) => {
      // The filters of "All expenses" stay in the address.
      const query = new URLSearchParams(params.toString())
      if (next === fallback) query.delete('view')
      else query.set('view', next)
      router.replace(query.size > 0 ? `${pathname}?${query}` : pathname, { scroll: false })
    },
  ]
}

/** "All expenses" / "My expenses", above the list. */
function ViewTabs({
  view,
  onChange,
  children,
}: {
  view: ExpensesView
  onChange: (view: ExpensesView) => void
  children: ReactNode
}) {
  const { t } = useTranslation()
  const id = useId()
  return (
    <>
      <div
        role="tablist"
        aria-label={t('common.nav.expenses')}
        className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 sm:inline-grid sm:min-w-96"
      >
        {(['all', 'mine'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            id={`${id}-${tab}`}
            aria-selected={view === tab}
            aria-controls={`${id}-panel`}
            onClick={() => onChange(tab)}
            className={cn(
              'flex min-h-11 items-center justify-center rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring',
              view === tab && 'bg-card text-foreground shadow-sm',
            )}
          >
            {t(`expenses.list.tabs.${tab}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${view}`}>
        {children}
      </div>
    </>
  )
}

function useFilters() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const filters = readExpenseFilters(params)
  const set = (next: Partial<ExpenseFilters>) => {
    const query = writeExpenseFilters(params, next)
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }
  return { filters, set }
}

/** The filters: a search and the status, then (folded on a phone) the category and the days. */
function FilterBar({
  filters,
  onChange,
}: {
  filters: ExpenseFilters
  onChange: (next: Partial<ExpenseFilters>) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const { categories } = useCostCategories()
  const monthName = useBusinessMonth()
  // The months the filter offers: next month and the 12 before this one (the months a new bill can
  // be for, D-194), and the one in the address.
  const [thisMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const months = Array.from({ length: 14 }, (_, index) => addMonths(thisMonth, 1 - index))
  if (filters.month && !months.includes(filters.month)) months.push(filters.month)
  // On a phone the category, the month and the days fold away under one button (open while one is
  // set).
  const narrowing = [filters.categoryId, filters.month, filters.from, filters.to].filter(
    Boolean,
  ).length
  const [open, setOpen] = useState(narrowing > 0)
  return (
    <div className="mb-4 space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchBox
          value={filters.search}
          placeholder={t('expenses.list.searchPlaceholder')}
          onChange={(search) => onChange({ search })}
        />
        <label className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground sm:w-60">
          <span className="shrink-0">{t('expenses.list.filters.status')}</span>
          <NativeSelect
            value={filters.status}
            onChange={(event) =>
              onChange({ status: event.target.value as ExpenseFilters['status'] })
            }
            className="min-w-0 flex-1 text-foreground"
          >
            {EXPENSE_STATUS_FILTERS.map((value) => (
              <option key={value} value={value}>
                {t(`expenses.list.filters.${value}`)}
              </option>
            ))}
          </NativeSelect>
        </label>
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
        {t('expenses.list.filters.more')}
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
          'grid grid-cols-2 items-end gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)_minmax(0,2fr)_minmax(0,2fr)]',
          !open && 'max-sm:hidden',
        )}
      >
        <div className="flex flex-col gap-1 max-sm:col-span-2">
          <label htmlFor={`${id}-category`} className="text-sm text-muted-foreground">
            {t('expenses.list.filters.category')}
          </label>
          <NativeSelect
            id={`${id}-category`}
            value={filters.categoryId ?? ''}
            onChange={(event) => onChange({ categoryId: event.target.value || null })}
          >
            <option value="">{t('expenses.list.filters.anyCategory')}</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1 max-sm:col-span-2">
          <label htmlFor={`${id}-month`} className="text-sm text-muted-foreground">
            {t('expenses.list.filters.month')}
          </label>
          <NativeSelect
            id={`${id}-month`}
            value={filters.month ?? ''}
            onChange={(event) => onChange({ month: event.target.value || null })}
          >
            <option value="">{t('expenses.list.filters.anyMonth')}</option>
            {months.map((month) => (
              <option key={month} value={month}>
                {monthName(month)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <label className="flex min-w-0 flex-col gap-1 text-sm text-muted-foreground">
          <span>{t('expenses.list.filters.from')}</span>
          <Input
            type="date"
            value={filters.from ?? ''}
            max={filters.to ?? undefined}
            onChange={(event) => onChange({ from: event.target.value || null })}
            className="min-w-0 text-foreground"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-sm text-muted-foreground">
          <span>{t('expenses.list.filters.to')}</span>
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
            onChange({
              status: 'all',
              categoryId: null,
              month: null,
              from: null,
              to: null,
              search: '',
            })
          }
        >
          {t('expenses.list.filters.clear')}
        </Button>
      ) : null}
    </div>
  )
}

/**
 * One expense in the list: what it was for (or its category), its status, then its category, day,
 * what it pays (D-216), number, supplier and, in a business with a team, who entered it; its total
 * at the end.
 */
function ExpenseRow({
  expense,
  href,
  showEnteredBy,
}: {
  expense: ExpenseListItemDto
  href: string
  showEnteredBy: boolean
}) {
  const { t } = useTranslation()
  const businessDate = useBusinessDate()
  const monthName = useBusinessMonth()
  const paysLabel = usePaysLabel()
  const pays = paysLabel(expense.pays)
  const parts = [
    expense.description ? <bdi key="category">{expense.categoryName}</bdi> : null,
    <span key="date">{businessDate(expense.businessDate)}</span>,
    // The month the bill is for, when it is not the bill's own month (D-194).
    expense.periodMonth !== monthOf(expense.businessDate) ? (
      <span key="month" data-period-month={expense.periodMonth}>
        {t('expenses.list.forMonth', { month: monthName(expense.periodMonth) })}
      </span>
    ) : null,
    pays ? (
      // Kept whole on its line when it fits.
      <span key="pays" data-pays={expense.pays?.kind} className="inline-block">
        {pays}
      </span>
    ) : null,
    expense.supplierName ? <bdi key="supplier">{expense.supplierName}</bdi> : null,
    expense.reference ? (
      // Kept whole on its line when it fits ("DEWA-118734", never "DEWA-" / "118734").
      <bdi key="reference" dir="auto" className="inline-block">
        {expense.reference}
      </bdi>
    ) : null,
    showEnteredBy && expense.createdBy.name ? (
      <span key="by">
        {t('expenses.list.enteredBy', { name: isolate(expense.createdBy.name) })}
      </span>
    ) : null,
  ].filter(Boolean)
  return (
    <Link
      href={href}
      data-expense={expense.id}
      className="flex items-start gap-3 px-4 py-3.5 transition-colors outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset sm:px-5"
    >
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-xl',
          expense.status === 'reversed'
            ? 'bg-muted text-muted-foreground'
            : 'bg-accent text-primary',
        )}
      >
        <ReceiptIcon aria-hidden className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span dir="auto" className="min-w-0 font-medium break-words">
            {expense.description ?? expense.categoryName}
          </span>
          <ExpenseStatusBadge status={expense.status} />
        </span>
        <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
          {parts.map((part, index) => (
            <span key={index}>
              {index > 0 ? ' · ' : null}
              {part}
            </span>
          ))}
        </span>
      </span>
      <span
        className={cn(
          'shrink-0 pt-0.5 text-end font-medium',
          expense.status === 'reversed' && 'text-muted-foreground line-through',
        )}
      >
        <Money value={expense.total} currency={expense.currency} />
      </span>
    </Link>
  )
}

function ExpensesList() {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const { businessId } = useParams<{ businessId: string }>()
  const businessDate = useBusinessDate()
  const { data: context } = useBusinessContext()
  const { filters, set } = useFilters()
  const settings = useExpenseSettings(context)
  // With a team, a member's own expenses have their own list; one who may not see supplier prices
  // lands there, since it shows their amounts (D-181).
  const hasTeam = context?.capabilities.has_team === true
  const seesAmounts = context?.visibleCategories.includes('supplier_price') === true
  const [view, setView] = useView(hasTeam && !seesAmounts ? 'mine' : 'all')
  const showsMine = hasTeam && view === 'mine'
  const list = useInfiniteQuery({
    ...trpc.expense.list.infiniteQueryOptions(listInput(filters), {
      getNextPageParam: (page) => page.data.nextCursor,
      placeholderData: keepPreviousData,
    }),
    enabled: !showsMine,
  })
  const mayApprove = context ? mayReviewExpenses(context) : false
  // An approver hears when expenses wait for them (one row is enough to know).
  const waiting = useQuery({
    ...trpc.expense.list.queryOptions({ status: 'submitted', limit: 1 }),
    enabled: mayApprove && filters.status !== 'submitted',
  })
  // With approval off, who may finalize hears when drafts the team entered wait for them (D-184).
  const mayFinalize = context !== undefined && can(context, 'expenses.documents.post')
  const draftsWait = useQuery({
    ...trpc.expense.list.queryOptions({ status: 'draft', enteredBy: 'others', limit: 1 }),
    enabled:
      hasTeam &&
      mayFinalize &&
      settings.data?.approvalRequired === false &&
      filters.status !== 'draft',
  })
  const books = useQuery(trpc.books.get.queryOptions())
  const [categoriesOpen, setCategoriesOpen] = useState(false)
  if (!context) return null
  const canManage = can(context, 'expenses.documents.manage')
  const items = list.data?.pages.flatMap((page) => page.data.items) ?? []
  const filtered = isFiltered(filters)
  // No expense at all yet: only the first-time card and its one "New expense" (as D-132).
  const firstTime =
    !showsMine && !filtered && list.isSuccess && !list.isPlaceholderData && items.length === 0
  const base = `/b/${businessId}/expenses`
  const title = t('common.nav.expenses')
  const approvalRequired = settings.data?.approvalRequired === true
  const hasWaiting = (waiting.data?.data.items.length ?? 0) > 0
  const hasDraftsWaiting =
    settings.data?.approvalRequired === false && (draftsWait.data?.data.items.length ?? 0) > 0
  const mayChangeApproval = isSectionVisible(context, 'approval')
  // "Approval is on" is for those who send expenses, and for who may change it (with "Change"); an
  // approver hears only that expenses wait for them (a phone keeps room for the list).
  const showApprovalOn = approvalRequired && (!mayApprove || mayChangeApproval)
  // How expenses reach costs (D-202, D-203, D-216): only for who sees costs; that a running cost's
  // bill takes the place of its regular amount, and an extra counts on top, only for who sees running
  // costs, with Running Costs on.
  const costsNote = !context.visibleCategories.includes('cost')
    ? null
    : hasModule(context, 'running_costs') && can(context, 'running_costs.items.view')
      ? t('expenses.list.costsNote')
      : t('expenses.list.costsNoteSimple')

  const newButton = canManage ? (
    <Button asChild size="lg" className="shrink-0">
      <Link href={`${base}/new`}>
        <PlusIcon aria-hidden />
        {t('expenses.list.new')}
      </Link>
    </Button>
  ) : null

  return (
    <PageContainer>
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
          <p className="mt-1.5 max-w-2xl text-muted-foreground">{t('expenses.list.intro')}</p>
          {costsNote ? (
            <p
              data-costs-note
              className="mt-2 flex max-w-2xl items-start gap-2 text-sm text-muted-foreground"
            >
              <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-info" />
              {costsNote}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {canManageCategories(context) ? (
            <Button variant="outline" size="lg" onClick={() => setCategoriesOpen(true)}>
              <TagsIcon aria-hidden />
              {t('expenses.list.categories')}
            </Button>
          ) : null}
          {firstTime ? null : newButton}
        </div>
      </header>
      {showApprovalOn ? (
        <FormAlert tone="info" className="mb-4">
          {t('expenses.list.approvalOn')}{' '}
          {mayChangeApproval ? (
            <Link
              href={sectionPath(businessId, 'approval')}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {t('expenses.list.approvalChange')}
            </Link>
          ) : null}
        </FormAlert>
      ) : null}
      {hasWaiting && filters.status !== 'submitted' ? (
        <FormAlert tone="info" className="mb-4">
          <span data-waiting>{t('expenses.list.waiting')}</span>{' '}
          <button
            type="button"
            onClick={() => set({ status: 'submitted' })}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {t('expenses.list.showWaiting')}
          </button>
        </FormAlert>
      ) : null}
      {hasDraftsWaiting && filters.status !== 'draft' ? (
        <FormAlert tone="info" className="mb-4">
          <span data-drafts-waiting>{t('expenses.list.draftsWaiting')}</span>{' '}
          {/* Every expense, drafts only (from "My expenses" too). */}
          <Link
            href={`${base}?${hasTeam ? 'view=all&' : ''}status=draft`}
            scroll={false}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {t('expenses.list.showWaiting')}
          </Link>
        </FormAlert>
      ) : null}
      {books.data?.closedThrough ? (
        <FormAlert tone="info" className="mb-4">
          {t('expenses.list.booksClosed', { date: businessDate(books.data.closedThrough) })}
        </FormAlert>
      ) : null}
      {hasTeam ? (
        <ViewTabs view={view} onChange={setView}>
          {showsMine ? <MineExpenses base={base} /> : allExpenses()}
        </ViewTabs>
      ) : (
        allExpenses()
      )}
      {categoriesOpen ? <CategoriesSheet onClose={() => setCategoriesOpen(false)} /> : null}
    </PageContainer>
  )

  /** "Your own expenses show their amounts in [My expenses]." (D-184), the tab name a button. */
  function ownAmountsNote() {
    const [before, after] = t('expenses.list.ownAmounts', { tab: ' ' }).split(' ')
    return (
      <span data-own-amounts>
        {before}
        <button
          type="button"
          onClick={() => setView('mine')}
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          {t('expenses.list.tabs.mine')}
        </button>
        {after}
      </span>
    )
  }

  /** Every expense: the filters and the list (the first-time card before any). */
  function allExpenses() {
    return (
      <>
        {firstTime ? null : <FilterBar filters={filters} onChange={set} />}
        {list.isPending ? (
          <ListSkeleton />
        ) : list.isError && !list.data ? (
          <LoadError error={list.error} onRetry={() => void list.refetch()} />
        ) : items.length === 0 ? (
          filtered ? (
            <ListEmpty
              icon={SearchXIcon}
              title={t('expenses.list.filters.noMatches')}
              body={t('expenses.list.filters.noMatchesHint')}
            />
          ) : (
            <ListEmpty
              icon={ReceiptIcon}
              title={t('expenses.list.empty.title')}
              body={canManage ? t('expenses.list.empty.body') : t('expenses.list.empty.viewer')}
            >
              {newButton}
            </ListEmpty>
          )
        ) : (
          <div className="space-y-4">
            {list.data?.pages.some((page) => page.meta.redacted.length > 0) ? (
              <p className="text-sm text-muted-foreground">
                {t('common.locked.note')}
                {hasTeam && !seesAmounts ? <> {ownAmountsNote()}</> : null}
              </p>
            ) : null}
            <ul
              aria-label={title}
              className="divide-y overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]"
            >
              {items.map((expense) => (
                <li key={expense.id}>
                  <ExpenseRow
                    expense={expense}
                    href={`${base}/${expense.id}`}
                    showEnteredBy={hasTeam}
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
      </>
    )
  }
}

/** The Expenses page: the list inside the module's gate (turned off, or not open to the member). */
export function ExpensesPage() {
  return (
    <ModuleGate moduleId="expenses" entryId="expenses">
      <ExpensesList />
    </ModuleGate>
  )
}
