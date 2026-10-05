'use client'

import { useTRPC } from '@bizcost/app-core'
import type {
  BusinessContextDto,
  ProfitGroup,
  ProfitGroupDto,
  ProfitMonthDto,
  ProfitShow,
  ProfitSummaryDto,
} from '@bizcost/contracts'
import {
  compareDecimal,
  type RealProfitReason,
  type StandardUnit,
  type TerminologyProfile,
} from '@bizcost/domain'
import { formatDate, formatPercent, type I18nKey } from '@bizcost/i18n'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  ChartLineIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  SearchXIcon,
} from 'lucide-react'
import Link from 'next/link'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Fragment, useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { FormAlert } from '@/components/form/form-alert'
import { ModuleGate } from '@/components/shell/module-gate'
import { PageContainer } from '@/components/shell/page-container'
import { LoadError } from '@/components/states/query-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { ListEmpty, ListSkeleton } from '@/features/catalog/catalog-list'
import { useUnitQuantity } from '@/features/catalog/unit-parts'
import { NBSP } from '@/features/catalog/units'
import { useBusinessDate, useBusinessMonth, useMoney } from '@/features/documents/amounts'
import { Panel } from '@/features/documents/panel'
import { hasModule } from '@/features/purchasing/data'
import { can, sectionPath } from '@/features/settings/sections'
import { useLocale, useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { useMediaQuery } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'
import {
  customStart,
  deviceToday,
  groupChoices,
  isTimeGroup,
  periodDays,
  PROFIT_PERIODS,
  profitInput,
  readProfitParams,
  showChoices,
  sortChoices,
  sortValue,
  writeProfitParams,
  type ProfitAccess,
  type ProfitParams,
  type ProfitPeriod,
} from './profit-params'
import {
  completenessShare,
  isLoss,
  partAmount,
  partsShown,
  percentOfSales,
  withoutMinus,
  type CostPart,
} from './profit-view'

// Reports → Real profit («الربح الحقيقي», M3 Step 3; D-223, D-237, D-241; the owner's answers Q6–Q8,
// Q11, Q14 of D-218): what the business really earns from its sales over a period, worked out on read
// by `profit.summary` (nothing is stored), grouped by month, week, product, channel, branch or day.
// Every figure says how it was worked out: the parts of real profit with their words (materials by
// the recipes at the average cost, app fees, delivery, running costs by each month's rate, the owner's
// time), each month's rate as a division ("September 2026: its costs AED 20,000 ÷ its sales AED 80,000
// = 25 % of each sale's price"; the running month "at September's rate until October ends"; a first
// month "so far, from your first sale on 1 Nov"), and how complete the answer is, with the way to fix
// what is missing. By branch says each branch carries the business's rate (B18).
//
// Profit and every cost show only to a member who sees profit (reports.profit.view with the costs
// switch and Product costs; Q11): the API withholds them from anyone else, who reads the sales only,
// and "Show" and "Sort by" never offer what they cannot see (the API refuses it). A member limited to
// some branches sees their branches at the shares their sales carry, without the business's costs.
// Released businesses never reach this page: Reports is served only under the dev-only preview until
// Release A (its layout says "Page not found" otherwise).

type Summary = ProfitSummaryDto['data']

/** The report's period, grouping, order and filter, from and to the address. */
function useProfitParams(access: ProfitAccess) {
  const router = useRouter()
  const pathname = usePathname()
  const search = useSearchParams()
  const params = readProfitParams(search, access)
  const set = (next: Partial<ProfitParams>) => {
    const query = writeProfitParams(new URLSearchParams(search.toString()), next)
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }
  return { params, set }
}

/** A value of the DTO, whether withheld by the service (null) or removed for the member (absent). */
function shown<T>(value: T | null | undefined): T | null {
  return value === undefined ? null : value
}

/** Whether the member may see real profit (the API's answer decides; this picks the controls). */
function accessOf(context: BusinessContextDto): ProfitAccess {
  return {
    profitShown:
      can(context, 'reports.profit.view') &&
      context.visibleCategories.includes('cost') &&
      context.visibleCategories.includes('profit_margin'),
    branches: context.capabilities.multi_location === true,
  }
}

/** An amount that never breaks inside ("AED 18.00"), in the loss color below 0 when `tone`. */
function Amount({
  value,
  className,
  tone = false,
}: {
  value: string
  className?: string
  tone?: boolean
}) {
  const money = useMoney()
  return (
    <bdi
      className={cn(
        'whitespace-nowrap tabular-nums',
        tone && isLoss(value) && 'text-loss',
        className,
      )}
    >
      {money(value).replaceAll(' ', NBSP)}
    </bdi>
  )
}

/** A percentage of up to 12 decimals ("42.8%"), rounded from the decimal string itself. */
function usePercentText() {
  const { locale } = useLocale()
  return (value: string, digits = 1) =>
    formatPercent(locale, value, { minDigits: digits, maxDigits: digits })
}

/** A month's name alone ("September"), for "at September's rate until October ends". */
function useMonthOnly() {
  const { locale } = useLocale()
  return (month: string) =>
    formatDate(locale, `${month}-01T00:00:00Z`, { month: 'long', timeZone: 'UTC' })
}

/** An amount said in a sentence: whole currency units would hide the costs of a small business. */
function useSaid() {
  const money = useMoney()
  return (value: string) => money(value).replaceAll(' ', NBSP)
}

// ---------------------------------------------------------------------------------------------------
// The controls: the period, how it is grouped, which groups and their order
// ---------------------------------------------------------------------------------------------------

function PeriodControl({
  params,
  today,
  onChange,
}: {
  params: ProfitParams
  today: string | null
  onChange: (next: Partial<ProfitParams>) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const businessDate = useBusinessDate()
  const start = today ? customStart(today) : { from: '', to: '' }
  const [from, setFrom] = useState(params.from || start.from)
  const [to, setTo] = useState(params.to || start.to)
  const days = today ? periodDays(params, today) : null
  const problem =
    params.period === 'custom' && days !== null && 'problem' in days ? days.problem : null
  const range = days !== null && !('problem' in days) ? days : null
  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="min-w-0 sm:w-52">
          <label htmlFor={`${id}-period`} className="mb-1 block text-xs text-muted-foreground">
            {t('reports.profit.period.label')}
          </label>
          <NativeSelect
            id={`${id}-period`}
            value={params.period}
            onChange={(event) => {
              const period = event.target.value as ProfitPeriod
              if (period !== 'custom') return onChange({ period })
              const first = range ?? start
              setFrom(first.from)
              setTo(first.to)
              onChange({ period, from: first.from, to: first.to })
            }}
          >
            {PROFIT_PERIODS.map((period) => (
              <option key={period} value={period}>
                {t(`reports.profit.period.${period}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
        {params.period === 'custom' ? (
          <form
            data-custom-period
            className="grid grid-cols-2 gap-2 sm:flex sm:items-end"
            onSubmit={(event) => {
              event.preventDefault()
              onChange({ period: 'custom', from, to })
            }}
          >
            <div className="min-w-0">
              <label htmlFor={`${id}-from`} className="mb-1 block text-xs text-muted-foreground">
                {t('reports.profit.period.from')}
              </label>
              <Input
                id={`${id}-from`}
                type="date"
                value={from}
                max={today ?? undefined}
                onChange={(event) => setFrom(event.target.value)}
                aria-invalid={problem !== null || undefined}
                className="sm:w-44"
              />
            </div>
            <div className="min-w-0">
              <label htmlFor={`${id}-to`} className="mb-1 block text-xs text-muted-foreground">
                {t('reports.profit.period.to')}
              </label>
              <Input
                id={`${id}-to`}
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                aria-invalid={problem !== null || undefined}
                className="sm:w-44"
              />
            </div>
            <Button type="submit" variant="outline" className="col-span-2 h-11 sm:col-span-1">
              {t('reports.profit.period.apply')}
            </Button>
          </form>
        ) : null}
      </div>
      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`reports.profit.period.errors.${problem}`)}
        </p>
      ) : range ? (
        <p data-period-days className="text-sm text-muted-foreground">
          {t('reports.profit.period.range', {
            from: businessDate(range.from).replaceAll(' ', NBSP),
            to: businessDate(range.to).replaceAll(' ', NBSP),
          })}
        </p>
      ) : null}
    </div>
  )
}

function groupLabelKey(by: ProfitGroup, servicesOnly: boolean): I18nKey {
  return by === 'product' && servicesOnly
    ? 'reports.profit.by.product_services'
    : (`reports.profit.by.${by}` as I18nKey)
}

function GroupControl({
  value,
  choices,
  servicesOnly,
  onChange,
}: {
  value: ProfitGroup
  choices: readonly ProfitGroup[]
  servicesOnly: boolean
  onChange: (by: ProfitGroup) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  return (
    <div role="group" aria-labelledby={id} className="min-w-0">
      <p id={id} className="mb-1 text-xs text-muted-foreground">
        {t('reports.profit.by.label')}
      </p>
      <div className="grid grid-cols-3 gap-1 rounded-xl bg-muted p-1 sm:inline-flex sm:flex-wrap">
        {choices.map((by) => (
          <button
            key={by}
            type="button"
            data-group-by={by}
            aria-pressed={by === value}
            onClick={() => onChange(by)}
            className={cn(
              'min-h-9 rounded-lg px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring',
              by === value && 'bg-card text-foreground shadow-sm',
            )}
          >
            {t(groupLabelKey(by, servicesOnly))}
          </button>
        ))}
      </div>
    </div>
  )
}

function OrderControls({
  params,
  access,
  onChange,
}: {
  params: ProfitParams
  access: ProfitAccess
  onChange: (next: Partial<ProfitParams>) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const shows = showChoices(access)
  const time = isTimeGroup(params.by)
  const sortLabel = (value: string): string => {
    if (value === 'key_asc') {
      return t(time ? 'reports.profit.sort.key_asc_time' : 'reports.profit.sort.key_asc_name')
    }
    if (value === 'key_desc') return t('reports.profit.sort.key_desc_time')
    return t(`reports.profit.sort.${value}` as I18nKey)
  }
  return (
    <div className={cn('grid gap-3 sm:flex sm:items-end', shows.length > 1 && 'grid-cols-2')}>
      {shows.length > 1 ? (
        <div className="min-w-0">
          <label htmlFor={`${id}-show`} className="mb-1 block text-xs text-muted-foreground">
            {t('reports.profit.show.label')}
          </label>
          <NativeSelect
            id={`${id}-show`}
            value={params.show}
            onChange={(event) => onChange({ show: event.target.value as ProfitShow })}
            className="sm:w-52"
          >
            {shows.map((show) => (
              <option key={show} value={show}>
                {t(`reports.profit.show.${show}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : null}
      <div className="min-w-0">
        <label htmlFor={`${id}-sort`} className="mb-1 block text-xs text-muted-foreground">
          {t('reports.profit.sort.label')}
        </label>
        <NativeSelect
          id={`${id}-sort`}
          value={sortValue(params)}
          onChange={(event) => {
            const match = /^(key|sales|profit|margin_percent)_(asc|desc)$/.exec(event.target.value)
            if (match) {
              onChange({
                sort: match[1] as ProfitParams['sort'],
                order: match[2] as ProfitParams['order'],
              })
            }
          }}
          className="sm:w-52"
        >
          {sortChoices(params.by, access).map((choice) => (
            <option key={sortValue(choice)} value={sortValue(choice)}>
              {sortLabel(sortValue(choice))}
            </option>
          ))}
        </NativeSelect>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------
// The whole period: real profit, where the sales went, how running costs are counted, completeness
// ---------------------------------------------------------------------------------------------------

/** The business's words for its materials (food: ingredients; a shop: items). */
function materialsKey(base: string, profile: TerminologyProfile): I18nKey {
  if (profile === 'food') return `${base}_food` as I18nKey
  if (profile === 'retail') return `${base}_retail` as I18nKey
  return base as I18nKey
}

/** Real profit of the whole period, and the sales it comes from. */
function ProfitSummary({ data, vat }: { data: Summary; vat: boolean }) {
  const { t } = useTranslation()
  const percent = usePercentText()
  const total = data.total
  const profit = shown(total.profit)
  const margin = shown(total.marginPercent)
  const loss = isLoss(profit)
  return (
    <section
      aria-label={t(
        data.profitShown ? 'reports.profit.summary.label' : 'reports.profit.summary.labelSales',
      )}
      data-profit-summary
      className="rounded-2xl bg-card p-5 shadow-sm ring-1 ring-foreground/[0.06]"
    >
      {data.profitShown && profit !== null ? (
        <div data-summary="profit">
          <p className="text-sm text-muted-foreground">
            {t(loss ? 'reports.profit.summary.loss' : 'reports.profit.summary.profit')}
          </p>
          <p
            className={cn(
              'mt-1 text-3xl font-semibold tracking-tight sm:text-4xl',
              loss ? 'text-loss' : 'text-foreground',
            )}
          >
            <Amount value={withoutMinus(profit)} />
          </p>
          {margin !== null ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {t(loss ? 'reports.profit.summary.lossMargin' : 'reports.profit.summary.margin', {
                percent: percent(withoutMinus(margin)),
              })}
            </p>
          ) : null}
          {total.complete === false ? (
            <p
              data-summary-incomplete
              className="mt-3 flex items-start gap-2 rounded-xl bg-warning/10 px-3 py-2 text-sm leading-relaxed"
            >
              <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
              <span>{t('reports.profit.summary.incomplete')}</span>
            </p>
          ) : null}
          {total.beforeRunningCosts === true ? (
            <p className="mt-2 text-sm text-muted-foreground">
              {t('reports.profit.summary.beforeRunning')}
            </p>
          ) : null}
        </div>
      ) : null}
      <div
        data-summary="sales"
        className={cn(data.profitShown && profit !== null && 'mt-4 border-t pt-4')}
      >
        <p className="text-sm text-muted-foreground">
          {t(vat ? 'reports.profit.summary.salesBeforeVat' : 'reports.profit.summary.sales')}
        </p>
        <p
          className={cn(
            'mt-1 font-semibold',
            data.profitShown && profit !== null ? 'text-xl' : 'text-3xl sm:text-4xl',
          )}
        >
          <Amount value={total.sales} />
        </p>
      </div>
    </section>
  )
}

/** One part of real profit: its name and amount (and share of the sales), how it was worked out. */
function PartLine({
  id,
  label,
  amount,
  sales,
  strong = false,
  children,
}: {
  id: string
  label: string
  amount: string | null
  sales: string
  strong?: boolean
  children?: ReactNode
}) {
  const { t } = useTranslation()
  const percent = usePercentText()
  const share = percentOfSales(amount, sales)
  return (
    <div
      data-part={id}
      className={cn('grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 py-3', strong && 'border-t-2')}
    >
      <dt className={cn('min-w-0', strong ? 'font-semibold' : 'font-medium')}>{label}</dt>
      <dd className="text-end">
        {amount === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <Amount
            value={id === 'profit' ? withoutMinus(amount) : amount}
            className={cn(
              strong ? 'text-lg font-semibold' : 'font-medium',
              id === 'profit' && isLoss(amount) && 'text-loss',
            )}
          />
        )}
        {share !== null && id !== 'sales' ? (
          <span className="block text-xs text-muted-foreground">
            {t('reports.profit.parts.ofSales', { percent: percent(withoutMinus(share)) })}
          </span>
        ) : null}
      </dd>
      {children ? (
        <dd className="col-span-2 mt-1 space-y-1 text-sm leading-relaxed text-muted-foreground">
          {children}
        </dd>
      ) : null}
    </div>
  )
}

/** Where the sales went: each part taken off them, with how it was worked out. */
function Parts({
  data,
  parts,
  context,
}: {
  data: Summary
  parts: readonly CostPart[]
  context: BusinessContextDto
}) {
  const { t } = useTranslation()
  const term = useTerminology()
  const said = useSaid()
  const total = data.total
  const vat = context.capabilities.vat_registered === true
  const profile = context.terminologyProfile
  const reasons = shown(total.reasons) ?? []
  const monthCosts = shown(total.monthCosts)
  // App fees no sale carries (D-250): marked for a month their app sold nothing in, or taken back.
  const feesNotCarried = shown(total.feesNotCarried)
  const runningAmount =
    data.businessLevel && monthCosts !== null ? monthCosts : partAmount(total, 'running')
  const profit = shown(total.profit)
  const lines: Record<CostPart, ReactNode> = {
    materials: (
      <PartLine
        id="materials"
        label={term(materialsKey('reports.profit.parts.materials', profile), profile)}
        amount={partAmount(total, 'materials')}
        sales={total.sales}
      >
        <p>{term('reports.profit.explain.materials', profile)}</p>
        {context.capabilities.keeps_stock === true ? (
          <p data-keeps-stock>{t('reports.profit.explain.keepsStock')}</p>
        ) : null}
      </PartLine>
    ),
    fees: (
      <PartLine
        id="fees"
        label={t('reports.profit.parts.fees')}
        amount={partAmount(total, 'fees')}
        sales={total.sales}
      >
        <p>{t('reports.profit.explain.fees')}</p>
        {reasons.includes('fees_not_entered') ? (
          <p data-before-fees className="font-medium text-foreground">
            {t('reports.profit.explain.feesMissing')}
          </p>
        ) : null}
        {showsAsSomething(feesNotCarried) ? (
          <p data-fees-not-carried>
            {t(
              isLoss(feesNotCarried)
                ? 'reports.profit.explain.feesTakenBack'
                : 'reports.profit.explain.feesNotCarried',
              { amount: said(withoutMinus(feesNotCarried)) },
            )}
          </p>
        ) : null}
      </PartLine>
    ),
    delivery: (
      <PartLine
        id="delivery"
        label={t('reports.profit.parts.delivery')}
        amount={partAmount(total, 'delivery')}
        sales={total.sales}
      >
        {typeof total.deliveryCost === 'string' ? (
          <p>
            {t('reports.profit.explain.delivery', {
              cost: said(total.deliveryCost),
              charged: said(total.deliveryCharged),
            })}
          </p>
        ) : null}
      </PartLine>
    ),
    running: (
      <PartLine
        id="running"
        label={t('reports.profit.parts.running')}
        amount={runningAmount}
        sales={total.sales}
      >
        <p>
          {t(
            data.businessLevel
              ? 'reports.profit.explain.runningBusiness'
              : 'reports.profit.explain.runningShares',
          )}
        </p>
      </PartLine>
    ),
    time: (
      <PartLine
        id="time"
        label={t('reports.profit.parts.time')}
        amount={partAmount(total, 'time')}
        sales={total.sales}
      >
        <p>{t('reports.profit.explain.time')}</p>
      </PartLine>
    ),
  }
  return (
    <Panel title={t('reports.profit.parts.title')}>
      <dl className="-my-3 divide-y">
        <PartLine
          id="sales"
          label={t(vat ? 'reports.profit.parts.salesBeforeVat' : 'reports.profit.parts.sales')}
          amount={total.sales}
          sales={total.sales}
        >
          <p>{t(vat ? 'reports.profit.explain.sales' : 'reports.profit.explain.salesNoVat')}</p>
          {showsAsSomething(total.deliveryCharged) ? (
            <p>
              {t('reports.profit.explain.salesDelivery', { amount: said(total.deliveryCharged) })}
            </p>
          ) : null}
        </PartLine>
        {parts.map((part) => (
          <Fragment key={part}>{lines[part]}</Fragment>
        ))}
        <PartLine
          id="profit"
          strong
          label={t(isLoss(profit) ? 'reports.profit.parts.loss' : 'reports.profit.parts.profit')}
          amount={profit}
          sales={total.sales}
        >
          <p>{t('reports.profit.explain.profit')}</p>
        </PartLine>
      </dl>
    </Panel>
  )
}

/** Whether an amount shows as something other than 0 (half a cent and up, either way). */
function showsAsSomething(value: string | null | undefined): value is string {
  return typeof value === 'string' && compareDecimal(withoutMinus(value), '0.005') >= 0
}

/** Whether a week group holds all its 7 days (the period did not cut its end). */
function fullWeek(group: ProfitGroupDto): boolean {
  if (group.to === null) return false
  const end = new Date(Date.parse(`${group.key}T00:00:00Z`) + 6 * 86_400_000)
  return group.to === end.toISOString().slice(0, 10)
}

/** A rate (0.25) as a percentage: whole when it is one, else with one decimal ("25%", "42.8%"). */
function useRatePercent() {
  const { locale } = useLocale()
  return (rate: string) => formatPercent(locale, rate, { ratio: true, minDigits: 0, maxDigits: 1 })
}

/** Each month's rate in words, and the business's costs subtracted. */
function Months({ data, by }: { data: Summary; by: ProfitGroup }) {
  const { t } = useTranslation()
  const monthName = useBusinessMonth()
  const monthOnly = useMonthOnly()
  const businessDate = useBusinessDate()
  const said = useSaid()
  const ratePercent = useRatePercent()
  const sentence = (row: ProfitMonthDto): string | null => {
    const month = monthName(row.month).replaceAll(' ', NBSP)
    const state = shown(row.state)
    const rate = shown(row.rate)
    const costs = shown(row.rateCosts)
    const sales = shown(row.rateSales)
    const values = {
      month,
      percent: rate !== null ? ratePercent(rate) : '',
      costs: costs !== null ? said(costs) : '',
      sales: sales !== null ? said(sales) : '',
    }
    const withAmounts = costs !== null && sales !== null
    switch (state) {
      case null:
        return null
      case 'off':
        return t('reports.profit.months.off')
      case 'awaiting_sales':
        // A month that is over had no sales; the running one has none yet.
        return t(
          row.month < data.today.slice(0, 7)
            ? 'reports.profit.months.awaitingPast'
            : 'reports.profit.months.awaiting',
          { month },
        )
      case 'before_running_costs':
        return t('reports.profit.months.before', {
          month,
          day: row.showsOn ? businessDate(row.showsOn).replaceAll(' ', NBSP) : '',
        })
      case 'none':
        return t('reports.profit.months.none', { month })
      case 'applied': {
        const basis = shown(row.basis)
        if (basis === 'last_month' && row.rateMonth) {
          return t(
            withAmounts ? 'reports.profit.months.lastMonth' : 'reports.profit.months.lastMonthRate',
            { ...values, rateMonth: monthOnly(row.rateMonth), monthOnly: monthOnly(row.month) },
          )
        }
        if (basis === 'so_far' && row.rateFrom) {
          // A first month that is over counts up to its last day: "so far" only while it runs.
          const rateTo = shown(row.rateTo)
          const done = rateTo !== null && rateTo < data.today
          const key = done
            ? withAmounts
              ? 'reports.profit.months.soFarDone'
              : 'reports.profit.months.soFarDoneRate'
            : withAmounts
              ? 'reports.profit.months.soFar'
              : 'reports.profit.months.soFarRate'
          return t(key, { ...values, day: businessDate(row.rateFrom).replaceAll(' ', NBSP) })
        }
        return t(
          withAmounts ? 'reports.profit.months.applied' : 'reports.profit.months.appliedRate',
          values,
        )
      }
    }
  }
  const rows = data.months.flatMap((row) => {
    const text = sentence(row)
    return text === null ? [] : [{ row, text }]
  })
  if (rows.length === 0) return null
  // "Off" is the same for every month: said once.
  const off = rows.every(({ row }) => row.state === 'off')
  return (
    <Panel
      title={t('reports.profit.months.title')}
      hint={off ? undefined : t('reports.profit.months.rule')}
    >
      <ul className="space-y-3 text-sm leading-relaxed">
        {(off ? rows.slice(0, 1) : rows).map(({ row, text }) => {
          const costs = shown(row.costs)
          const notCarried = shown(row.notCarried)
          return (
            <li key={row.month} data-profit-month={row.month} className="space-y-1">
              <p>{text}</p>
              {costs !== null && row.state !== 'off' ? (
                <p className="text-muted-foreground">
                  {t('reports.profit.months.costs', {
                    month: monthName(row.month).replaceAll(' ', NBSP),
                    costs: said(costs),
                  })}{' '}
                  {showsAsSomething(notCarried) && !isLoss(notCarried) ? (
                    <span data-not-carried>
                      {t('reports.profit.months.notCarried', { amount: said(notCarried) })}
                    </span>
                  ) : null}
                </p>
              ) : null}
            </li>
          )
        })}
        {by === 'branch' ? (
          <li data-branch-rate className="flex items-start gap-2 font-medium">
            <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>{t('reports.profit.months.branch')}</span>
          </li>
        ) : null}
      </ul>
    </Panel>
  )
}

/** What a missing part points to: where it is added. */
function useReasonLink() {
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  return (reason: RealProfitReason): string | null => {
    if (!context) return null
    switch (reason) {
      case 'no_recipe':
        return hasModule(context, 'products') && can(context, 'products.recipes.manage')
          ? `/b/${businessId}/products`
          : null
      case 'unpriced_materials':
        return hasModule(context, 'purchases') && can(context, 'purchases.documents.manage')
          ? `/b/${businessId}/purchases/new`
          : null
      case 'fees_not_entered':
        return can(context, 'sales.channels.manage') ? sectionPath(businessId, 'channels') : null
      case 'hourly_rate_not_set':
        return can(context, 'cost_engine.settings.manage')
          ? sectionPath(businessId, 'costing')
          : null
      case 'delivery_cost_not_entered':
        return hasModule(context, 'sales') ? `/b/${businessId}/sales` : null
    }
  }
}

/** How complete the answer is: the share of sales with complete costs, and what is missing. */
function Completeness({ data, profile }: { data: Summary; profile: TerminologyProfile }) {
  const { t } = useTranslation()
  const term = useTerminology()
  const said = useSaid()
  const percent = usePercentText()
  const link = useReasonLink()
  const completeness = shown(data.completeness)
  if (!completeness || completeness.percent === null) return null
  const all = completeness.missing.length === 0
  // Never "100%" while something is missing, nor "0%" while something is complete (D-250).
  const share = completenessShare(completeness.percent, all)
  return (
    <Panel title={t('reports.profit.completeness.title')}>
      <p data-completeness className="flex items-start gap-2 text-sm leading-relaxed">
        {all ? (
          <CircleCheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
        ) : (
          <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        )}
        <span>
          {all
            ? t('reports.profit.completeness.all')
            : t(`reports.profit.completeness.${share.words}`, {
                percent: percent(share.percent, 0),
              })}
        </span>
      </p>
      {all ? null : (
        <ul className="mt-3 space-y-2">
          {completeness.missing.map((item) => {
            const href = link(item.reason)
            return (
              <li
                key={item.reason}
                data-missing={item.reason}
                className="flex flex-col gap-2 rounded-xl bg-muted/50 px-3 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="min-w-0">
                  {term(`reports.profit.completeness.reasons.${item.reason}`, profile, {
                    amount: said(item.sales),
                  })}
                </span>
                {href ? (
                  <Button asChild variant="outline" size="sm" className="h-9 shrink-0 bg-card">
                    <Link href={href}>
                      {term(`reports.profit.completeness.actions.${item.reason}`, profile)}
                    </Link>
                  </Button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------------------------------
// The groups: a table from 1280 px, cards below
// ---------------------------------------------------------------------------------------------------

/** A group's name: a month, a week, a day, or a product, channel or branch (what is not one). */
function useGroupName() {
  const { t } = useTranslation()
  const monthName = useBusinessMonth()
  const businessDate = useBusinessDate()
  return (group: ProfitGroupDto, by: ProfitGroup): string => {
    if (by === 'month') return monthName(group.key)
    if (by === 'week') {
      // A week cut by the period (its first or last days outside it) says the days it covers.
      const clipped =
        group.from !== null && group.to !== null && (group.from !== group.key || !fullWeek(group))
      return clipped
        ? t('reports.profit.table.weekDays', {
            from: businessDate(group.from!),
            to: businessDate(group.to!),
          })
        : t('reports.profit.table.week', { day: businessDate(group.key) })
    }
    if (by === 'day') return businessDate(group.key)
    if (group.key === 'delivery') return t('reports.profit.table.deliveryRow')
    if (group.key === 'charge') return t('reports.profit.table.chargeRow')
    return group.name ?? t('reports.profit.table.removed')
  }
}

/** The short words of a cost part as a column. */
function columnKey(part: CostPart, profile: TerminologyProfile): I18nKey {
  if (part === 'materials') return materialsKey('reports.profit.table.materials', profile)
  return `reports.profit.table.${part}` as I18nKey
}

/** A group's profit: the amount (red at a loss), "not complete", "before running costs". */
function ProfitCell({ group }: { group: ProfitGroupDto }) {
  const { t } = useTranslation()
  const profit = shown(group.profit)
  if (profit === null) return <span className="text-muted-foreground">—</span>
  return (
    <>
      <Amount value={profit} tone className="font-semibold" />
      {group.complete === false ? (
        <Badge tone="warning" className="mt-1 flex w-fit max-xl:ms-auto xl:ms-auto">
          {t('reports.profit.table.incomplete')}
        </Badge>
      ) : null}
      {group.beforeRunningCosts === true ? (
        <span className="block text-xs text-muted-foreground">
          {t('reports.profit.table.beforeRunning')}
        </span>
      ) : null}
    </>
  )
}

function MarginCell({ group }: { group: ProfitGroupDto }) {
  const percent = usePercentText()
  const margin = shown(group.marginPercent)
  if (margin === null) return <span className="text-muted-foreground">—</span>
  return (
    <bdi className={cn('whitespace-nowrap tabular-nums', isLoss(margin) && 'text-loss')}>
      {percent(margin)}
    </bdi>
  )
}

function Groups({
  data,
  by,
  parts,
  context,
}: {
  data: Summary
  by: ProfitGroup
  parts: readonly CostPart[]
  context: BusinessContextDto
}) {
  const { t } = useTranslation()
  const wide = useMediaQuery('(min-width: 1280px)')
  const name = useGroupName()
  const unitQuantity = useUnitQuantity()
  const profile = context.terminologyProfile
  const profitShown = data.profitShown
  const label = t(profitShown ? 'reports.profit.table.label' : 'reports.profit.table.labelSales', {
    by: t(groupLabelKey(by, context.sellsOnlyServices)),
  })
  const quantity = (group: ProfitGroupDto) =>
    group.quantity !== null && group.unit
      ? unitQuantity(group.quantity, group.unit as StandardUnit)
      : null
  const showQuantity = by === 'product'

  if (wide) {
    const head = 'px-3 py-3 text-xs font-medium text-muted-foreground'
    const cell = 'px-3 py-3 align-top'
    return (
      <div className="overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]">
        <table aria-label={label} data-profit-groups className="w-full border-collapse text-sm">
          <thead className="bg-muted/40">
            <tr>
              <th scope="col" className={cn(head, 'ps-5 text-start')}>
                {t(groupLabelKey(by, context.sellsOnlyServices))}
              </th>
              {showQuantity ? (
                <th scope="col" className={cn(head, 'text-end')}>
                  {t('reports.profit.table.quantity')}
                </th>
              ) : null}
              <th scope="col" className={cn(head, 'text-end')}>
                {t('reports.profit.table.sales')}
              </th>
              {profitShown
                ? parts.map((part) => (
                    <th key={part} scope="col" className={cn(head, 'text-end')}>
                      {t(columnKey(part, profile))}
                    </th>
                  ))
                : null}
              {profitShown ? (
                <>
                  <th scope="col" className={cn(head, 'text-end')}>
                    {t('reports.profit.table.profit')}
                  </th>
                  <th scope="col" className={cn(head, 'pe-5 text-end')}>
                    {t('reports.profit.table.margin')}
                  </th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {data.groups.map((group) => (
              <tr key={group.key} data-profit-group={group.key} className="border-t">
                <th scope="row" className={cn(cell, 'ps-5 text-start font-medium')}>
                  <bdi className="break-words">{name(group, by)}</bdi>
                </th>
                {showQuantity ? (
                  <td className={cn(cell, 'text-end whitespace-nowrap text-muted-foreground')}>
                    {quantity(group) ? <bdi>{quantity(group)}</bdi> : '—'}
                  </td>
                ) : null}
                <td className={cn(cell, 'text-end')}>
                  <Amount value={group.sales} className="font-medium" />
                </td>
                {profitShown
                  ? parts.map((part) => {
                      const value = partAmount(group, part)
                      return (
                        <td
                          key={part}
                          data-figure={part}
                          className={cn(cell, 'text-end text-muted-foreground')}
                        >
                          {value === null ? '—' : <Amount value={value} />}
                        </td>
                      )
                    })
                  : null}
                {profitShown ? (
                  <>
                    <td data-figure="profit" className={cn(cell, 'text-end')}>
                      <ProfitCell group={group} />
                    </td>
                    <td data-figure="margin" className={cn(cell, 'pe-5 text-end')}>
                      <MarginCell group={group} />
                    </td>
                  </>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <ul
      aria-label={label}
      data-profit-groups
      className="divide-y overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]"
    >
      {data.groups.map((group) => (
        <li key={group.key} data-profit-group={group.key} className="px-4 py-3.5 sm:px-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium break-words">
                <bdi>{name(group, by)}</bdi>
              </p>
              {showQuantity && quantity(group) ? (
                <p className="text-sm text-muted-foreground">
                  <bdi>{quantity(group)}</bdi>
                </p>
              ) : null}
            </div>
            <div className="shrink-0 text-end">
              {profitShown ? (
                <ProfitCell group={group} />
              ) : (
                <Amount value={group.sales} className="font-semibold" />
              )}
            </div>
          </div>
          {profitShown ? (
            <>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">
                    {t('reports.profit.table.sales')}
                  </dt>
                  <dd>
                    <Amount value={group.sales} />
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">
                    {t('reports.profit.table.margin')}
                  </dt>
                  <dd>
                    <MarginCell group={group} />
                  </dd>
                </div>
              </dl>
              {parts.length > 0 ? (
                <details className="group mt-2 text-sm">
                  <summary className="inline-flex min-h-9 cursor-pointer items-center rounded-md font-medium text-primary outline-none focus-visible:ring-3 focus-visible:ring-ring">
                    {t('reports.profit.table.parts')}
                  </summary>
                  <dl className="mt-1 space-y-1">
                    {parts.map((part) => {
                      const value = partAmount(group, part)
                      return (
                        <div
                          key={part}
                          data-figure={part}
                          className="flex items-baseline justify-between gap-3 text-muted-foreground"
                        >
                          <dt className="min-w-0">{t(columnKey(part, profile))}</dt>
                          <dd className="shrink-0">
                            {value === null ? '—' : <Amount value={value} />}
                          </dd>
                        </div>
                      )
                    })}
                  </dl>
                </details>
              ) : null}
            </>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------------

function RealProfitReport() {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const access: ProfitAccess = context ? accessOf(context) : { profitShown: false, branches: false }
  const { params, set } = useProfitParams(access)
  // Today in the business's time zone (books.get, which any member who sees sales may read); this
  // device's day only when it may not be read (the API counts up to its own today anyway).
  const books = useQuery({ ...trpc.books.get.queryOptions(), retry: false })
  const today = books.data?.today ?? (books.isError ? deviceToday() : null)
  const input = profitInput(params, today)
  const report = useQuery({
    ...trpc.profit.summary.queryOptions(input ?? { from: '2000-01-01', to: '2000-01-01' }),
    enabled: input !== null,
    placeholderData: keepPreviousData,
  })
  if (!context) return null
  const data = report.data?.data
  const vat = context.capabilities.vat_registered === true
  const parts = data
    ? partsShown([data.total, ...data.groups], {
        runningCounted: data.months.some((m) => m.state !== null && m.state !== 'off'),
        ownerTime: context.capabilities.has_team !== true,
      })
    : []
  const limited = !context.locationScope.all
  const narrowed = params.show !== 'all'
  const salesLink =
    hasModule(context, 'sales') && can(context, 'sales.documents.manage')
      ? `/b/${businessId}/sales`
      : null

  return (
    <PageContainer>
      <header className="mb-5 sm:mb-6">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {t('reports.profit.title')}
        </h1>
        <p className="mt-1.5 max-w-2xl text-muted-foreground">
          {t(
            access.profitShown
              ? 'reports.profit.intro'
              : access.branches
                ? 'reports.profit.introSalesBranches'
                : 'reports.profit.introSales',
          )}
        </p>
      </header>
      <div className="space-y-5">
        <div
          data-profit-controls
          className="space-y-4 rounded-2xl bg-card p-4 shadow-sm ring-1 ring-foreground/[0.06] sm:p-5"
        >
          <PeriodControl
            key={`${params.period}:${params.from}:${params.to}:${today ?? ''}`}
            params={params}
            today={today}
            onChange={set}
          />
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <GroupControl
              value={params.by}
              choices={groupChoices(access)}
              servicesOnly={context.sellsOnlyServices}
              onChange={(by) => set({ by })}
            />
            <OrderControls params={params} access={access} onChange={set} />
          </div>
        </div>
        {data && !data.profitShown ? (
          <FormAlert tone="info">
            <span data-profit-hidden>{t('reports.profit.hidden')}</span>
          </FormAlert>
        ) : null}
        {data && data.profitShown && limited ? (
          <FormAlert tone="info">
            <span data-branch-limited>{t('reports.profit.limited')}</span>
          </FormAlert>
        ) : null}
        {input === null && today !== null ? null : report.isPending || today === null ? (
          <ListSkeleton />
        ) : report.isError && !data ? (
          <LoadError error={report.error} onRetry={() => void report.refetch()} />
        ) : data ? (
          <div className={cn('space-y-5', report.isPlaceholderData && 'opacity-60')}>
            {data.total.sales === '0' && data.groups.length === 0 ? (
              <ListEmpty
                icon={ChartLineIcon}
                title={t('reports.profit.empty.title')}
                body={t(
                  data.profitShown ? 'reports.profit.empty.body' : 'reports.profit.empty.bodySales',
                )}
              >
                {salesLink ? (
                  <Button asChild size="lg">
                    <Link href={salesLink}>{t('common.nav.sales')}</Link>
                  </Button>
                ) : null}
              </ListEmpty>
            ) : (
              <>
                <div
                  className={cn(
                    'grid gap-5',
                    data.profitShown &&
                      'xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] xl:items-start',
                  )}
                >
                  <div className="space-y-5">
                    <ProfitSummary data={data} vat={vat} />
                    {data.profitShown ? (
                      <Completeness data={data} profile={context.terminologyProfile} />
                    ) : null}
                  </div>
                  {data.profitShown ? (
                    <div className="space-y-5">
                      <Parts data={data} parts={parts} context={context} />
                      <Months data={data} by={params.by} />
                    </div>
                  ) : null}
                </div>
                {data.groups.length === 0 && narrowed ? (
                  <ListEmpty
                    icon={SearchXIcon}
                    title={t('reports.profit.empty.filtered')}
                    body={t('reports.profit.empty.filteredBody')}
                  />
                ) : (
                  <Groups data={data} by={params.by} parts={parts} context={context} />
                )}
              </>
            )}
          </div>
        ) : null}
      </div>
    </PageContainer>
  )
}

/** Reports → Real profit, inside the Reports module's gate. */
export function RealProfitPage() {
  return (
    <ModuleGate moduleId="reports" entryId="real_profit">
      <RealProfitReport />
    </ModuleGate>
  )
}
