'use client'

import { useTRPC } from '@bizcost/app-core'
import type {
  BusinessContextDto,
  ProductCostListDto,
  ProductCostRowDto,
  ProductCostSort,
} from '@bizcost/contracts'
import { compareDecimal, type TerminologyProfile } from '@bizcost/domain'
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query'
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  BriefcaseIcon,
  CalculatorIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Clock3Icon,
  InfoIcon,
  PackageIcon,
  PackageCheckIcon,
  ReceiptTextIcon,
  RepeatIcon,
  SearchXIcon,
  SettingsIcon,
  TagIcon,
  type LucideIcon,
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { ListEmpty, ListSkeleton, ListToolbar } from '@/features/catalog/catalog-list'
import { NBSP } from '@/features/catalog/units'
import { Locked, useBusinessDate, useMoney } from '@/features/documents/amounts'
import { Panel } from '@/features/documents/panel'
import { hasModule } from '@/features/purchasing/data'
import { can, isSectionVisible, sectionPath } from '@/features/settings/sections'
import { useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { useMediaQuery } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'
import {
  costListInput,
  isNarrowed,
  maySort,
  nextSort,
  readCostListParams,
  showChoices,
  showOf,
  showParams,
  sortChoices,
  writeCostListParams,
  type CostListParams,
  type CostListShow,
  type CostVisibility,
} from './list-params'
import { MonthCosts } from './month-costs'
import { useHourlyRateSentence, usePercent, useRateWords, useReasonWords } from './words'

// Product costs (ROADMAP.md M2 Step 6; D-115, D-119, D-178, D-186, D-187, D-202): what one unit of
// each product or service really costs (its materials, its share of the running costs and, without a
// team, the owner's time) and its margin on the price before VAT, worked out by the API on read
// (nothing is stored). Cards on a phone, a table from 1280 px (beside the sidebar). Each row opens the
// product's breakdown. Above the list, how the costs are worked out in words (running costs by each
// item's price, with the owner's example and the business's costs of the last full month), with the
// way to change what can be set (folded to one line on a phone unless something is missing), then a
// search, "Show" (in use, incomplete, sold at a loss, archived, all; with how many need a look) and
// "Sort by".
//
// Costs, margins and supplier prices are visible only together (D-187): a member who may not see
// them sees a lock, and the page never offers to sort or filter by them (the API refuses it,
// list-params.ts). A cost with something missing is marked incomplete and says why in a few words;
// its margin is only "at most" (muted, never green); nothing missing is ever 0. Until sales are
// recorded (Phase 3) the share of running costs waits for them (D-202): that is not "incomplete",
// but the list says its costs and margins are before running costs.

/** The page's order and filter, from and to the address. */
function useListParams(visible: CostVisibility) {
  const router = useRouter()
  const pathname = usePathname()
  const search = useSearchParams()
  const params = readCostListParams(search, visible)
  const set = (next: Partial<CostListParams>) => {
    const query = writeCostListParams(new URLSearchParams(search.toString()), next)
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }
  return { params, set }
}

type ListData = ProductCostListDto['data']

/** One line of how costs are worked out: an icon and what it says, with an action at its end. */
function HowLine({
  icon: Icon,
  tone = 'muted',
  children,
  action,
  ...rest
}: {
  icon: LucideIcon
  tone?: 'muted' | 'warning'
  children: ReactNode
  action?: ReactNode
  'data-how'?: string
}) {
  return (
    <li
      {...rest}
      className={cn(
        'flex flex-col gap-2 rounded-xl px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4',
        tone === 'warning' ? 'bg-warning/10' : 'bg-muted/50',
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <Icon
          aria-hidden
          className={cn(
            'mt-0.5 size-4 shrink-0',
            tone === 'warning' ? 'text-warning' : 'text-muted-foreground',
          )}
        />
        <div className="min-w-0 flex-1 text-sm leading-relaxed">{children}</div>
      </div>
      {action ? <div className="shrink-0 ps-6.5 sm:ps-0">{action}</div> : null}
    </li>
  )
}

/** Whether the costing settings hold something for this business to change: the hourly rate. */
function settingsApply(data: ListData): boolean {
  return data.ownerTime.applies
}

/**
 * How the costs are worked out (members who see costs): the materials' average; how running costs
 * reach what the business sells (by its price, with the owner's example, worked out once sales are
 * recorded, D-202) and the business's costs of the last full month by category; the owner's hourly
 * rate without a team, and how many products have none of the owner's time. On a phone it folds to
 * one line, unless something is missing.
 */
function HowPanel({ data, context }: { data: ListData; context: BusinessContextDto }) {
  const { t } = useTranslation()
  const term = useTerminology()
  const businessDate = useBusinessDate()
  const rateWords = useRateWords()
  const hourly = useHourlyRateSentence()
  const { businessId } = useParams<{ businessId: string }>()
  const wide = useMediaQuery('(min-width: 768px)')
  const [open, setOpen] = useState(false)
  const materialsOn = hasModule(context, 'materials')
  const running = rateWords(data.monthCosts, hasModule(context, 'running_costs'))
  const time = data.ownerTime.applies ? hourly(data.ownerTime.hourlyRate) : null
  if (running === null && time === null) return null
  const canChange = isSectionVisible(context, 'costing')
  const settings = sectionPath(businessId, 'costing')
  const rateMissing = data.ownerTime.applies && data.ownerTime.hourlyRate === null
  const noTime = data.ownerTime.applies ? (data.counts.noTime ?? 0) : 0
  const needsAction = running?.action != null || rateMissing
  const expanded = wide || open || needsAction
  const settingsButton = (label: string) =>
    canChange ? (
      <Button asChild variant="outline" size="sm" className="h-9 bg-card">
        <Link href={settings}>{label}</Link>
      </Button>
    ) : (
      <span className="text-sm text-muted-foreground">{t('costing.how.askOwner')}</span>
    )
  const runningAction =
    running?.action === 'runningCosts' &&
    hasModule(context, 'running_costs') &&
    can(context, 'running_costs.items.view') ? (
      <Button asChild variant="outline" size="sm" className="h-9 bg-card">
        <Link href={`/b/${businessId}/running-costs`}>{t('costing.how.addRunningCosts')}</Link>
      </Button>
    ) : undefined
  const change =
    canChange && settingsApply(data) ? (
      <Button asChild variant="ghost" size="sm" className="-me-1 h-9">
        <Link href={settings}>
          <SettingsIcon aria-hidden />
          {t('costing.how.change')}
        </Link>
      </Button>
    ) : undefined

  if (!expanded) {
    // A phone with nothing missing: the rule in one line, and the rest a tap away.
    const summary = [running?.short, time].filter(Boolean).join(' · ')
    return (
      <section
        aria-label={t('costing.how.title')}
        data-how-folded
        className="flex items-center justify-between gap-3 rounded-2xl bg-card px-4 py-3 shadow-sm ring-1 ring-foreground/[0.06]"
      >
        <span className="flex min-w-0 items-start gap-2.5 text-sm leading-relaxed">
          <RepeatIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0">{summary}</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="-me-2 h-9 shrink-0 text-primary"
          aria-expanded={false}
          onClick={() => setOpen(true)}
        >
          {t('costing.how.more')}
          <ChevronDownIcon aria-hidden />
        </Button>
      </section>
    )
  }

  return (
    <Panel
      title={t('costing.how.title')}
      action={
        !wide && open && !needsAction ? (
          <Button
            variant="ghost"
            size="sm"
            className="-me-1 h-9"
            aria-expanded
            onClick={() => setOpen(false)}
          >
            {t('costing.how.less')}
          </Button>
        ) : (
          change
        )
      }
    >
      <ul className="space-y-2">
        {materialsOn ? (
          <HowLine icon={PackageIcon} data-how="materials">
            {t('costing.how.materials', {
              from: businessDate(data.averageFrom),
              to: businessDate(data.today),
            })}
          </HowLine>
        ) : null}
        {running ? (
          <HowLine icon={RepeatIcon} data-how="running">
            <p data-rule>{running.rule}</p>
            <p data-example className="mt-1 text-muted-foreground">
              {running.example}
            </p>
            {running.awaiting ? (
              <p data-awaiting className="mt-1 font-medium">
                {running.awaiting}
              </p>
            ) : null}
          </HowLine>
        ) : null}
        {running?.nudge ? (
          <HowLine icon={RepeatIcon} tone="warning" data-how="not-entered" action={runningAction}>
            {running.nudge}
          </HowLine>
        ) : null}
        {running ? (
          <HowLine icon={ReceiptTextIcon} data-how="month">
            <MonthCosts
              costs={data.monthCosts}
              materialsOn={materialsOn}
              vatRegistered={context.capabilities.vat_registered === true}
            />
          </HowLine>
        ) : null}
        {time ? (
          <HowLine
            icon={Clock3Icon}
            tone={rateMissing ? 'warning' : 'muted'}
            data-how="time"
            action={rateMissing ? settingsButton(t('costing.how.setRate')) : undefined}
          >
            {time}
          </HowLine>
        ) : null}
        {noTime > 0 ? (
          <HowLine
            icon={Clock3Icon}
            data-how="no-time"
            action={
              hasModule(context, 'products') && can(context, 'products.items.manage') ? (
                <Button asChild variant="outline" size="sm" className="h-9 bg-card">
                  <Link href={`/b/${businessId}/products`}>
                    {term('common.nav.products', context.terminologyProfile)}
                  </Link>
                </Button>
              ) : undefined
            }
          >
            {t('costing.how.noTime', { count: noTime })}
          </HowLine>
        ) : null}
      </ul>
    </Panel>
  )
}

/** "Show" and "Sort by", side by side under the search (only what the member may use). */
function ListChoices({
  params,
  visible,
  counts,
  beforeRunning,
  onChange,
}: {
  params: CostListParams
  visible: CostVisibility
  counts: ListData['counts'] | undefined
  /** The costs are before running costs (D-202): a loss is said to be before them too. */
  beforeRunning: boolean
  onChange: (next: Partial<CostListParams>) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const label = (show: CostListShow) => {
    if (show === 'incomplete' || show === 'loss') {
      const key = show === 'loss' && beforeRunning ? 'lossBefore' : show
      const count = counts?.[show]
      if (typeof count === 'number') return t(`costing.list.show.${key}Count`, { count })
      return t(`costing.list.show.${key}`)
    }
    return t(`costing.list.show.${show}`)
  }
  return (
    <div className="grid shrink-0 grid-cols-2 gap-3 sm:flex sm:items-end">
      <div className="min-w-0">
        <label htmlFor={`${id}-show`} className="mb-1 block text-xs text-muted-foreground">
          {t('costing.list.show.label')}
        </label>
        <NativeSelect
          id={`${id}-show`}
          value={showOf(params)}
          onChange={(event) => onChange(showParams(event.target.value as CostListShow))}
          className="sm:w-48"
        >
          {showChoices(visible).map((show) => (
            <option key={show} value={show}>
              {label(show)}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="min-w-0">
        <label htmlFor={`${id}-sort`} className="mb-1 block text-xs text-muted-foreground">
          {t('costing.list.sort.label')}
        </label>
        <NativeSelect
          id={`${id}-sort`}
          value={`${params.sort}:${params.direction}`}
          onChange={(event) => {
            const [sort, direction] = event.target.value.split(':') as [
              ProductCostSort,
              'asc' | 'desc',
            ]
            onChange({ sort, direction })
          }}
          className="sm:w-56"
        >
          {sortChoices(visible).map((choice) => (
            <option
              key={`${choice.sort}:${choice.direction}`}
              value={`${choice.sort}:${choice.direction}`}
            >
              {t(`costing.list.sort.${choice.sort}_${choice.direction}`)}
            </option>
          ))}
        </NativeSelect>
      </div>
    </div>
  )
}

/** What needs a look (members who see margins): how many are sold at a loss or incomplete. */
function Attention({
  counts,
  beforeRunning,
  onShow,
}: {
  counts: ListData['counts']
  /** The costs are before running costs (D-202): a loss is said to be before them too. */
  beforeRunning: boolean
  onShow: (show: CostListShow) => void
}) {
  const { t } = useTranslation()
  const items = (['loss', 'incomplete'] as const).filter(
    (show) => typeof counts[show] === 'number' && (counts[show] ?? 0) > 0,
  )
  if (items.length === 0) return null
  return (
    <p data-attention className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span className="text-muted-foreground">{t('costing.list.attention')}</span>
      {items.map((show) => (
        <button
          key={show}
          type="button"
          data-attention-item={show}
          onClick={() => onShow(show)}
          className={cn(
            'inline-flex min-h-9 items-center rounded-full px-3 font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring',
            show === 'loss'
              ? 'bg-destructive/10 text-destructive hover:bg-destructive/15'
              : 'bg-warning/15 text-foreground hover:bg-warning/25',
          )}
        >
          {t(`costing.list.show.${show === 'loss' && beforeRunning ? 'lossBefore' : show}Count`, {
            count: counts[show],
          })}
        </button>
      ))}
    </p>
  )
}

/** An amount that never breaks inside ("AED 18.00"). */
function Amount({ value, className }: { value: string; className?: string }) {
  const money = useMoney()
  return (
    <bdi className={cn('whitespace-nowrap tabular-nums', className)}>
      {money(value).replaceAll(' ', NBSP)}
    </bdi>
  )
}

/** The price as set, and before VAT when VAT is taken out of it. */
function PriceValue({ row }: { row: ProductCostRowDto }) {
  const { t } = useTranslation()
  const money = useMoney()
  const { price } = row
  if (price.defaultPrice === null) {
    return <span className="text-muted-foreground">{t('catalog.products.noPrice')}</span>
  }
  const stripped = compareDecimal(price.vatRate, '0') > 0 && price.beforeVat !== null
  return (
    <>
      <Amount value={price.defaultPrice} className="font-medium" />
      {stripped && price.beforeVat ? (
        <span data-before-vat className="block text-xs text-muted-foreground">
          {t('costing.list.row.beforeVat', {
            amount: money(price.beforeVat).replaceAll(' ', NBSP),
          })}
        </span>
      ) : null}
    </>
  )
}

/**
 * One unit's cost: the amount (and "incomplete"), a lock, or why there is none: too large, not worked
 * out yet, or, when nothing is missing and its only line is its share awaiting sales, worked out
 * once sales are recorded (D-203).
 */
function CostValue({ row }: { row: ProductCostRowDto }) {
  const { t } = useTranslation()
  const { total, complete, tooLarge } = row.cost
  if (total === undefined) return <Locked category="cost" />
  if (total === null) {
    const awaiting = complete === true && row.cost.runningCosts.state === 'awaiting_sales'
    return (
      <span data-awaiting={awaiting || undefined} className="text-muted-foreground">
        {tooLarge
          ? t('costing.list.row.tooLarge')
          : awaiting
            ? t('costing.list.row.awaiting')
            : t('costing.list.row.notCounted')}
      </span>
    )
  }
  return (
    <>
      <Amount value={total} className="font-medium" />
      {complete === false ? (
        <Badge
          tone="warning"
          className="ms-1.5 align-middle max-xl:ms-0 max-xl:mt-1 max-xl:flex max-xl:w-fit"
        >
          {t('catalog.products.cost.incomplete')}
        </Badge>
      ) : null}
    </>
  )
}

/**
 * Whether a margin is only "at most" what it shows: its cost is incomplete (what is missing only adds
 * to it). A loss stays a loss.
 */
function atMost(row: ProductCostRowDto, value: string): boolean {
  return row.cost.complete === false && compareDecimal(value, '0') >= 0
}

/** "at most", before a margin whose cost is incomplete. */
function AtMost() {
  const { t } = useTranslation()
  return (
    <span data-at-most className="me-1 text-xs font-normal whitespace-nowrap">
      {t('costing.list.row.atMost')}
    </span>
  )
}

/**
 * The margin on the price before VAT: red for a loss, muted and "at most" while the cost is
 * incomplete, a dash without a price or a cost.
 */
function MarginValue({ row }: { row: ProductCostRowDto }) {
  const { amount } = row.margin
  if (amount === undefined) return <Locked category="profit_margin" />
  if (amount === null) return <span className="text-muted-foreground">—</span>
  const loss = compareDecimal(amount, '0') < 0
  const upTo = atMost(row, amount)
  return (
    <span className={cn(upTo && 'text-muted-foreground')}>
      {upTo ? <AtMost /> : null}
      <Amount value={amount} className={cn(!upTo && 'font-medium', loss && 'text-destructive')} />
    </span>
  )
}

function PercentValue({ row }: { row: ProductCostRowDto }) {
  const percent = usePercent()
  const value = row.margin.percent
  if (value === undefined) return <Locked category="profit_margin" />
  if (value === null) return <span className="text-muted-foreground">—</span>
  const loss = compareDecimal(value, '0') < 0
  const upTo = atMost(row, value)
  return (
    <span className={cn(upTo && 'text-muted-foreground')}>
      {upTo ? <AtMost /> : null}
      <bdi className={cn('whitespace-nowrap tabular-nums', loss && 'text-destructive')}>
        {percent(value)}
      </bdi>
    </span>
  )
}

/**
 * Why a cost is incomplete, in a few words each, and, without a team, that the owner's time is not
 * added (none when complete or hidden).
 */
function Reasons({ row, profile }: { row: ProductCostRowDto; profile: TerminologyProfile }) {
  const { t } = useTranslation()
  const words = useReasonWords()
  const reasons = (row.cost.reasons ?? []).map((reason) => words.short(reason, profile, row.type))
  if (row.cost.ownerTime.state === 'none') reasons.push(t('costing.list.row.timeMissing'))
  if (reasons.length === 0) return null
  return (
    <span data-reasons className="mt-0.5 block text-sm text-muted-foreground">
      {reasons.join(' · ')}
    </span>
  )
}

const ROW_ICONS = { recipe: TagIcon, resale: PackageCheckIcon } as const

function rowIcon(row: ProductCostRowDto): LucideIcon {
  return row.type === 'service' ? BriefcaseIcon : ROW_ICONS[row.kind]
}

/** The name and its tags. */
function NameAndTags({ row }: { row: ProductCostRowDto }) {
  const { t } = useTranslation()
  return (
    <>
      <span dir="auto" className="min-w-0 font-medium break-words">
        {row.name}
      </span>
      {row.type === 'service' ? (
        <Badge tone="primary">{t('catalog.products.type.service')}</Badge>
      ) : row.kind === 'resale' ? (
        <Badge>{t('catalog.products.resale.badge')}</Badge>
      ) : null}
      {row.archived ? <Badge>{t('catalog.list.archivedBadge')}</Badge> : null}
    </>
  )
}

/**
 * A product on a phone or a tablet: its name and why its cost is incomplete, its price on a line of
 * its own, then its cost and margin side by side (room for amounts in the thousands).
 */
function CostCard({
  row,
  href,
  profile,
}: {
  row: ProductCostRowDto
  href: string
  profile: TerminologyProfile
}) {
  const { t } = useTranslation()
  const Icon = rowIcon(row)
  const figure = (label: string, value: ReactNode, key: string) => (
    <div data-figure={key} className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm">{value}</dd>
    </div>
  )
  return (
    <Link
      href={href}
      data-product-cost-row={row.name}
      className="flex items-start gap-3 px-4 py-3.5 transition-colors outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset sm:px-5"
    >
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-xl',
          row.archived ? 'bg-muted text-muted-foreground' : 'bg-accent text-primary',
        )}
      >
        <Icon aria-hidden className="size-5" />
      </span>
      <span className="block min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <NameAndTags row={row} />
        </span>
        <Reasons row={row} profile={profile} />
        <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
          <div className="col-span-2 sm:col-span-1">
            {figure(t('costing.list.row.price'), <PriceValue row={row} />, 'price')}
          </div>
          {figure(t('costing.list.row.cost'), <CostValue row={row} />, 'cost')}
          {figure(
            t('costing.list.row.margin'),
            <>
              <MarginValue row={row} />
              {typeof row.margin.amount !== 'string' ? null : (
                <span className="block text-xs text-muted-foreground">
                  <PercentValue row={row} />
                </span>
              )}
            </>,
            'margin',
          )}
        </dl>
      </span>
      <ChevronRightIcon
        aria-hidden
        className="mt-2.5 size-4 shrink-0 text-muted-foreground rtl:-scale-x-100"
      />
    </Link>
  )
}

/** A column header that sorts the list (only by what the member may see). */
function SortHeader({
  sort,
  label,
  note,
  params,
  visible,
  onSort,
  className,
}: {
  sort: ProductCostSort
  label: string
  /** Under the label, smaller ("before running costs"). */
  note?: string
  params: CostListParams
  visible: CostVisibility
  onSort: (next: Partial<CostListParams>) => void
  className?: string
}) {
  const active = params.sort === sort
  const base = cn('px-4 py-3 text-xs font-medium text-muted-foreground', className)
  const noted = note ? (
    <span data-column-note className="block text-[11px] font-normal">
      {note}
    </span>
  ) : null
  if (!maySort(visible, sort)) {
    return (
      <th scope="col" className={base}>
        {label}
        {noted}
      </th>
    )
  }
  const Icon = !active ? ArrowUpDownIcon : params.direction === 'asc' ? ArrowUpIcon : ArrowDownIcon
  return (
    <th
      scope="col"
      aria-sort={active ? (params.direction === 'asc' ? 'ascending' : 'descending') : undefined}
      className={base}
    >
      <button
        type="button"
        onClick={() => onSort(nextSort(params, sort))}
        className={cn(
          '-mx-1.5 inline-flex min-h-9 items-center gap-1 rounded-md px-1.5 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring',
          active && 'text-foreground',
        )}
      >
        {label}
        <Icon aria-hidden className={cn('size-3.5', !active && 'opacity-50')} />
      </button>
      {noted}
    </th>
  )
}

/** The list as a table (from 1280 px): a row opens the product's breakdown. */
function CostTable({
  rows,
  hrefOf,
  profile,
  params,
  visible,
  beforeRunning,
  onSort,
  label,
}: {
  rows: readonly ProductCostRowDto[]
  hrefOf: (row: ProductCostRowDto) => string
  profile: TerminologyProfile
  params: CostListParams
  visible: CostVisibility
  /** The costs are before running costs (D-202): the margin columns say so. */
  beforeRunning: boolean
  onSort: (next: Partial<CostListParams>) => void
  label: string
}) {
  const { t } = useTranslation()
  const header = (sort: ProductCostSort, key: string, className?: string, note?: string) => (
    <SortHeader
      sort={sort}
      label={t(`costing.list.columns.${key}` as 'costing.list.columns.name')}
      note={note}
      params={params}
      visible={visible}
      onSort={onSort}
      className={className}
    />
  )
  const before = beforeRunning ? t('costing.list.columns.beforeRunning') : undefined
  return (
    <div className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]">
      <table aria-label={label} className="w-full border-collapse text-sm">
        <thead className="bg-muted/40">
          <tr>
            {header('name', 'name', 'text-start ps-5')}
            {header('price', 'price', 'text-end')}
            {header('cost', 'cost', 'text-end')}
            {header('margin', 'margin', 'text-end', before)}
            {header('margin_percent', 'marginPercent', 'text-end', before)}
            <td className="w-10" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const Icon = rowIcon(row)
            return (
              <tr
                key={row.productId}
                data-product-cost-row={row.name}
                className="relative border-t transition-colors hover:bg-muted/40"
              >
                <td className="py-3 ps-5 pe-4 align-top">
                  <span className="flex items-start gap-3">
                    <span
                      className={cn(
                        'flex size-9 shrink-0 items-center justify-center rounded-lg',
                        row.archived ? 'bg-muted text-muted-foreground' : 'bg-accent text-primary',
                      )}
                    >
                      <Icon aria-hidden className="size-4" />
                    </span>
                    <span className="block min-w-0 pt-1.5">
                      <Link
                        href={hrefOf(row)}
                        className="rounded-sm outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-3 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                      >
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <NameAndTags row={row} />
                        </span>
                      </Link>
                      <Reasons row={row} profile={profile} />
                    </span>
                  </span>
                </td>
                <td data-figure="price" className="px-4 py-3 pt-4.5 text-end align-top">
                  <PriceValue row={row} />
                </td>
                <td data-figure="cost" className="px-4 py-3 pt-4.5 text-end align-top">
                  <CostValue row={row} />
                </td>
                <td data-figure="margin" className="px-4 py-3 pt-4.5 text-end align-top">
                  <MarginValue row={row} />
                </td>
                <td data-figure="percent" className="px-4 py-3 pt-4.5 text-end align-top">
                  <PercentValue row={row} />
                </td>
                <td className="pe-4 pt-4.5 align-top">
                  <ChevronRightIcon
                    aria-hidden
                    className="size-4 text-muted-foreground rtl:-scale-x-100"
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ProductCostsList() {
  const { t } = useTranslation()
  const term = useTerminology()
  const trpc = useTRPC()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const visible: CostVisibility = context?.visibleCategories ?? []
  const { params, set } = useListParams(visible)
  const wide = useMediaQuery('(min-width: 1280px)')
  const list = useInfiniteQuery(
    trpc.productCost.list.infiniteQueryOptions(costListInput(params), {
      getNextPageParam: (page) => page.data.nextCursor,
      placeholderData: keepPreviousData,
    }),
  )
  if (!context) return null
  const profile = context.terminologyProfile
  const title = t('common.nav.product_costs')
  const first = list.data?.pages[0]?.data
  const rows = list.data?.pages.flatMap((page) => page.data.items) ?? []
  const narrowed = isNarrowed(params)
  // Nothing sold yet: only the first-time card and its way to Products & Services.
  const firstTime = !narrowed && list.isSuccess && !list.isPlaceholderData && rows.length === 0
  const hrefOf = (row: ProductCostRowDto) => `/b/${businessId}/product-costs/${row.productId}`
  // Costs, margins and supplier prices are visible only together (D-187).
  const seesCosts = visible.includes('cost')
  const canSeeProducts = hasModule(context, 'products') && can(context, 'products.items.view')
  // Until sales are recorded every cost is before running costs (D-202): the list says so.
  const beforeRunning = seesCosts && first?.monthCosts.state === 'awaiting_sales'

  return (
    <PageContainer>
      <header className="mb-5 flex flex-col gap-4 sm:mb-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
          <p className="mt-1.5 max-w-2xl text-muted-foreground">{t('costing.intro')}</p>
        </div>
      </header>
      <div className="space-y-5">
        {!seesCosts ? (
          <FormAlert tone="info">
            <span data-costs-hidden>{t('costing.hidden')}</span>
          </FormAlert>
        ) : null}
        {first && seesCosts && !firstTime ? <HowPanel data={first} context={context} /> : null}
        <div>
          {firstTime ? null : (
            <ListToolbar search={params.search} onChange={(next) => set(next)}>
              <ListChoices
                params={params}
                visible={visible}
                counts={first?.counts}
                beforeRunning={beforeRunning}
                onChange={set}
              />
            </ListToolbar>
          )}
          {first && seesCosts && showOf(params) === 'active' && !params.search ? (
            <Attention
              counts={first.counts}
              beforeRunning={beforeRunning}
              onShow={(show) => set(showParams(show))}
            />
          ) : null}
          {beforeRunning && rows.length > 0 ? (
            // Honest totals (D-202): the share of running costs is not in them until sales are
            // recorded; that is not "incomplete", and never read as final.
            <p
              data-before-running
              className="mb-3 flex items-start gap-2 text-sm leading-relaxed text-muted-foreground"
            >
              <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0">{t('costing.list.beforeRunning')}</span>
            </p>
          ) : null}
          {list.isPending ? (
            <ListSkeleton />
          ) : list.isError && !list.data ? (
            <LoadError error={list.error} onRetry={() => void list.refetch()} />
          ) : rows.length === 0 ? (
            firstTime ? (
              <ListEmpty
                icon={CalculatorIcon}
                title={t('costing.list.empty.title')}
                body={t('costing.list.empty.body')}
              >
                {canSeeProducts ? (
                  <Button asChild size="lg">
                    <Link href={`/b/${businessId}/products`}>
                      {t('states.goTo', { section: term('common.nav.products', profile) })}
                    </Link>
                  </Button>
                ) : null}
              </ListEmpty>
            ) : params.search ? (
              <ListEmpty
                icon={SearchXIcon}
                title={t('catalog.list.noMatches', { search: isolate(params.search) })}
                body={t('costing.list.noMatches.hint')}
              />
            ) : params.filter ? (
              <ListEmpty
                icon={SearchXIcon}
                title={t(`costing.list.noMatches.${params.filter}`)}
                body={t('costing.list.noMatches.hint')}
              />
            ) : (
              <ListEmpty
                icon={SearchXIcon}
                title={t('catalog.list.noArchived')}
                body={t('catalog.list.noArchivedHint')}
              />
            )
          ) : (
            <div className="space-y-4">
              {wide ? (
                <CostTable
                  rows={rows}
                  hrefOf={hrefOf}
                  profile={profile}
                  params={params}
                  visible={visible}
                  beforeRunning={beforeRunning}
                  onSort={set}
                  label={title}
                />
              ) : (
                <ul
                  aria-label={title}
                  className="divide-y overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]"
                >
                  {rows.map((row) => (
                    <li key={row.productId}>
                      <CostCard row={row} href={hrefOf(row)} profile={profile} />
                    </li>
                  ))}
                </ul>
              )}
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
    </PageContainer>
  )
}

/** The Product costs page: the list inside the Cost Engine's gate. */
export function ProductCostsPage() {
  return (
    <ModuleGate moduleId="cost_engine" entryId="product_costs">
      <ProductCostsList />
    </ModuleGate>
  )
}
