'use client'

import type { BusinessContextDto, DashboardCardsDto } from '@bizcost/contracts'
import { compareDecimal, costRatio, sumDecimals, type StandardUnit } from '@bizcost/domain'
import { formatList, formatPercent, type I18nKey } from '@bizcost/i18n'
import {
  ArrowUpRightIcon,
  BanknoteIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  SearchCheckIcon,
  TrendingDownIcon,
  TrendingUpIcon,
  type LucideIcon,
} from 'lucide-react'
import Link from 'next/link'
import { useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { isolate } from '@/components/form/use-message'
import { moduleAccess } from '@/components/shell/nav'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useUnitQuantity } from '@/features/catalog/unit-parts'
import { NBSP } from '@/features/catalog/units'
import {
  useBusinessDate,
  useBusinessMonth,
  useMoney,
  useUnitCost,
} from '@/features/documents/amounts'
import { hasModule } from '@/features/purchasing/data'
import { can, sectionPath } from '@/features/settings/sections'
import { useLocale, useTerminology } from '@/lib/i18n/client'
import { cn } from '@/lib/utils'
import { SalesProfitChart } from './profit-chart'

// The Dashboard's decision cards (M3 Step 3; PRODUCT.md §9; Q14 of D-218): what the business made this
// month so far, from `dashboard.cards` (worked out on read, D-242). Only the cards it has data for
// and the member may see: the API sends null for any other, and none at all while Sales is not
// served (a released business sees no change before Release A) or before the first final sale.
// Stacked on a phone, a grid on a desktop: real profit and sales against last month, where the money
// went, "Sales and real profit by day" (the one chart, drawn in-house), the top sellers, what sold at
// a loss or a low margin, cost increases, sales by channel and what needs a look. Profit and every
// cost fact only for a member who sees profit (the service withholds them otherwise).

type Cards = DashboardCardsDto['data']

const CARD = 'rounded-2xl bg-card p-4 shadow-sm ring-1 ring-foreground/[0.06] sm:p-5'

/** A value the service withheld (null) or the member's role removed (absent): not shown. */
function shown<T>(value: T | null | undefined): T | null {
  return value === undefined ? null : value
}

const isLoss = (value: string | null) => value !== null && compareDecimal(value, '0') < 0
const withoutMinus = (value: string) => value.replace(/^-/, '')
const nonZero = (value: string | null) => value !== null && compareDecimal(value, '0') !== 0

/** Whether the cards hold anything to show (a business with sales this month or last). */
export function hasCards(cards: Cards | null | undefined): cards is Cards {
  return Boolean(cards && (cards.sales ?? shown(cards.profit)))
}

/** An amount that never breaks inside. */
function Amount({ value, className }: { value: string; className?: string }) {
  const money = useMoney()
  return (
    <bdi className={cn('whitespace-nowrap tabular-nums', className)}>
      {money(value).replaceAll(' ', NBSP)}
    </bdi>
  )
}

/** A percentage (in percent, 12 decimals) as the page's language writes it. */
function usePercent() {
  const { locale } = useLocale()
  return (value: string, digits = 1) =>
    formatPercent(locale, value, { minDigits: digits, maxDigits: digits })
}

/** A card: its title (and a line under it), what it shows, and a way to see more at its end. */
function Card({
  id,
  title,
  hint,
  icon: Icon,
  action,
  className,
  children,
}: {
  id: string
  title: string
  hint?: string
  icon?: LucideIcon
  action?: ReactNode
  className?: string
  children: ReactNode
}) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} data-card={id} className={cn(CARD, 'min-w-0', className)}>
      <div className="mb-3">
        <div className="flex items-start justify-between gap-3">
          <h3 id={headingId} className="flex min-w-0 items-center gap-2 font-semibold">
            {Icon ? <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" /> : null}
            {title}
          </h3>
          {action}
        </div>
        {hint ? (
          <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{hint}</p>
        ) : null}
      </div>
      {children}
    </section>
  )
}

/** "See more" at a card's end, to the page that has it all. */
function More({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="-me-1 inline-flex min-h-9 shrink-0 items-center gap-0.5 rounded-lg px-1.5 text-sm font-medium text-primary outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring"
    >
      {label}
      <ChevronRightIcon aria-hidden className="size-4 rtl:rotate-180" />
    </Link>
  )
}

/**
 * A figure tile: real profit or sales this month, against last month; it opens the page behind it.
 * `value` is an amount, or `words` say why there is none yet ("No sales yet this month").
 */
function Tile({
  id,
  label,
  value,
  words,
  loss = false,
  lines,
  href,
  icon: Icon,
}: {
  id: string
  label: string
  value: string | null
  words?: string
  loss?: boolean
  lines: ReactNode
  href: string | null
  icon: LucideIcon
}) {
  const body = (
    <>
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Icon aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0">{label}</span>
      </p>
      <p
        className={cn(
          'mt-1.5 text-xl font-semibold tracking-tight sm:text-2xl',
          loss && 'text-loss',
        )}
      >
        {value !== null ? <Amount value={value} /> : words}
      </p>
      <div className="mt-1 space-y-0.5 text-xs leading-relaxed text-muted-foreground sm:text-sm">
        {lines}
      </div>
    </>
  )
  return href ? (
    <Link
      href={href}
      data-card={id}
      className={cn(
        CARD,
        'block min-w-0 transition-colors outline-none hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring',
      )}
    >
      {body}
    </Link>
  ) : (
    <div data-card={id} className={cn(CARD, 'min-w-0')}>
      {body}
    </div>
  )
}

/** The colors of "where the money went", fixed per part (never by rank). */
const PART_COLORS = {
  materials: 'bg-chart-1',
  fees: 'bg-chart-5',
  delivery: 'bg-chart-3',
  running: 'bg-chart-6',
  // Neutral: the owner's time is not a warning, and never the loss red (D-250).
  time: 'bg-muted-foreground',
  profit: 'bg-chart-2',
} as const

type MoneyPart = keyof typeof PART_COLORS

function MoneyWent({
  money,
  context,
}: {
  money: NonNullable<Cards['moneyWent']>
  context: BusinessContextDto
}) {
  const { t } = useTranslation()
  const term = useTerminology()
  const percent = usePercent()
  const ownerTime = context.capabilities.has_team !== true
  const value = (part: MoneyPart): string | null =>
    shown(
      {
        materials: money.materials,
        fees: money.fees,
        delivery: money.deliveryCost,
        running: money.runningCosts,
        time: money.ownerTime,
        profit: money.profit,
      }[part],
    )
  // A part the business has (materials with Materials on, the owner's time without a team, the
  // others when they are not 0), and the profit always.
  const parts = (['materials', 'fees', 'delivery', 'running', 'time', 'profit'] as const).filter(
    (part) => {
      const amount = value(part)
      if (amount === null) return false
      if (part === 'profit' || part === 'running') return true
      if (part === 'materials') return hasModule(context, 'materials') || nonZero(amount)
      if (part === 'time') return ownerTime
      return nonZero(amount)
    },
  )
  const label = (part: MoneyPart) => {
    if (part === 'materials') {
      return term('dashboard.cards.moneyWent.materials', context.terminologyProfile)
    }
    if (part === 'profit' && isLoss(value('profit'))) return t('dashboard.cards.moneyWent.loss')
    return t(`dashboard.cards.moneyWent.${part}` as I18nKey)
  }
  return (
    <Card
      id="money-went"
      title={t('dashboard.cards.moneyWent.title')}
      hint={t('dashboard.cards.moneyWent.hint')}
      className="col-span-2"
    >
      <ul className="space-y-3">
        {parts.map((part) => {
          const amount = value(part)!
          const share = costRatio([withoutMinus(amount), '100'], [money.sales])
          const width = share === null ? 0 : Math.min(100, Number(share))
          const loss = part === 'profit' && isLoss(amount)
          return (
            <li key={part} data-money-part={part}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      'size-2.5 shrink-0 rounded-[3px]',
                      loss ? 'bg-loss' : PART_COLORS[part],
                    )}
                  />
                  <span className="min-w-0">{label(part)}</span>
                </span>
                <span className="shrink-0 text-end">
                  <Amount
                    value={withoutMinus(amount)}
                    className={cn('font-medium', loss && 'text-loss')}
                  />
                  {share !== null ? (
                    <span className="ms-2 inline-block min-w-9 text-xs text-muted-foreground">
                      <bdi>{percent(share, 0)}</bdi>
                    </span>
                  ) : null}
                </span>
              </div>
              <div aria-hidden className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn('h-full rounded-full', loss ? 'bg-loss' : PART_COLORS[part])}
                  style={{ width: `${width}%` }}
                />
              </div>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/** A margin as a small pill, said as one ("Margin 47%"): red at a loss, amber under 10 %, green. */
function MarginPill({ value }: { value: string }) {
  const { t } = useTranslation()
  const percent = usePercent()
  const tone =
    compareDecimal(value, '0') < 0
      ? 'danger'
      : compareDecimal(value, '10') < 0
        ? 'warning'
        : 'success'
  return (
    <Badge tone={tone} className="tabular-nums">
      <bdi>{t('dashboard.cards.margin', { percent: percent(value, 0) })}</bdi>
    </Badge>
  )
}

function TopProducts({ top }: { top: NonNullable<Cards['topProducts']> }) {
  const { t } = useTranslation()
  const unitQuantity = useUnitQuantity()
  const byMargin = shown(top.byMargin)
  const [view, setView] = useState<'quantity' | 'margin'>('quantity')
  const rows = view === 'margin' && byMargin ? byMargin : top.byQuantity
  const choices = byMargin && byMargin.length > 0
  return (
    <Card
      id="top-products"
      title={t('dashboard.cards.top.title')}
      hint={view === 'margin' ? t('dashboard.cards.top.marginHint') : undefined}
      action={
        choices ? (
          <div className="flex shrink-0 gap-0.5 rounded-lg bg-muted p-0.5 text-xs">
            {(['quantity', 'margin'] as const).map((choice) => (
              <button
                key={choice}
                type="button"
                data-top-view={choice}
                aria-pressed={view === choice}
                onClick={() => setView(choice)}
                className={cn(
                  'min-h-8 rounded-md px-2 font-medium whitespace-nowrap text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring',
                  view === choice && 'bg-card text-foreground shadow-sm',
                )}
              >
                {t(
                  choice === 'quantity'
                    ? 'dashboard.cards.top.byQuantity'
                    : 'dashboard.cards.top.byMargin',
                )}
              </button>
            ))}
          </div>
        ) : undefined
      }
    >
      <ol className="space-y-2.5">
        {rows.map((row, index) => {
          const margin = shown(row.marginPercent)
          return (
            <li
              key={row.productId}
              data-top-product={row.name}
              className="flex items-center gap-3 text-sm"
            >
              <span className="w-4 shrink-0 text-center text-xs text-muted-foreground tabular-nums">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">
                <bdi>{row.name}</bdi>
              </span>
              <span className="shrink-0 text-muted-foreground">
                <bdi>{unitQuantity(row.quantity, row.unit as StandardUnit)}</bdi>
              </span>
              {margin !== null ? <MarginPill value={margin} /> : null}
            </li>
          )
        })}
      </ol>
    </Card>
  )
}

function Concerns({
  concerns,
  href,
}: {
  concerns: NonNullable<Cards['concerns']>
  href: string | null
}) {
  const { t } = useTranslation()
  return (
    <Card
      id="concerns"
      title={t('dashboard.cards.concerns.title')}
      hint={t('dashboard.cards.concerns.hint')}
      icon={CircleAlertIcon}
    >
      <ul className="space-y-2.5">
        {concerns.map((item) => {
          const margin = shown(item.marginPercent)
          const concern = shown(item.concern)
          return (
            <li
              key={item.productId}
              data-concern={item.name}
              className="flex items-center gap-3 text-sm"
            >
              <span className="min-w-0 flex-1 truncate font-medium">
                <bdi>{item.name}</bdi>
              </span>
              {concern ? (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t(
                    concern === 'loss'
                      ? 'dashboard.cards.concerns.loss'
                      : 'dashboard.cards.concerns.low',
                  )}
                </span>
              ) : null}
              {margin !== null ? <MarginPill value={margin} /> : null}
            </li>
          )
        })}
      </ul>
      {href ? (
        <div className="mt-3 border-t pt-2">
          <More href={href} label={t('dashboard.cards.concerns.open')} />
        </div>
      ) : null}
    </Card>
  )
}

function CostIncreases({ items }: { items: NonNullable<Cards['costIncreases']> }) {
  const { t } = useTranslation()
  const unitCost = useUnitCost()
  const percent = usePercent()
  return (
    <Card
      id="cost-increases"
      title={t('dashboard.cards.costIncreases.title')}
      hint={t('dashboard.cards.costIncreases.hint')}
      icon={ArrowUpRightIcon}
    >
      <ul className="space-y-2.5">
        {items.map((item) => {
          const before = shown(item.before)
          const now = shown(item.now)
          const rise = shown(item.percent)
          const per = t(`units.per.${item.unit}` as I18nKey)
          const priced = (value: string) => `${unitCost(value)} ${per}`.replaceAll(' ', NBSP)
          return (
            <li key={item.materialId} data-cost-increase={item.name} className="text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-medium">
                  <bdi>{item.name}</bdi>
                </span>
                {rise !== null ? (
                  <Badge tone="warning" className="tabular-nums">
                    <bdi>
                      {t('dashboard.cards.costIncreases.rise', { percent: percent(rise, 0) })}
                    </bdi>
                  </Badge>
                ) : null}
              </div>
              {before !== null && now !== null ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t('dashboard.cards.costIncreases.change', {
                    before: priced(before),
                    now: priced(now),
                  })}
                </p>
              ) : null}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

function Channels({ channels }: { channels: NonNullable<Cards['byChannel']> }) {
  const { t } = useTranslation()
  const percent = usePercent()
  const total = sumDecimals(channels.map((c) => c.sales))
  return (
    <Card id="channels" title={t('dashboard.cards.channels.title')}>
      <ul className="space-y-3">
        {channels.map((channel) => {
          const share = costRatio([channel.sales, '100'], [total])
          const margin = shown(channel.marginPercent)
          const width = share === null ? 0 : Math.max(0, Math.min(100, Number(share)))
          return (
            <li key={channel.channelId} data-channel={channel.name} className="text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-medium">
                  <bdi>{channel.name}</bdi>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <Amount value={channel.sales} />
                  {margin !== null ? <MarginPill value={margin} /> : null}
                </span>
              </div>
              <div aria-hidden className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-chart-1" style={{ width: `${width}%` }} />
              </div>
              {share !== null ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t('dashboard.cards.channels.share', { percent: percent(share, 0) })}
                </p>
              ) : null}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

type LookKind = keyof NonNullable<Cards['needsLook']>

function NeedsLook({
  look,
  hrefs,
}: {
  look: NonNullable<Cards['needsLook']>
  hrefs: Readonly<Record<LookKind, string | null>>
}) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const kinds = (
    [
      'unpricedMaterials',
      'channelsWithoutFees',
      'productsWithoutRecipe',
      'materialsInNoRecipe',
    ] as const
  ).filter((kind) => look[kind].length > 0)
  return (
    <Card id="needs-look" title={t('dashboard.cards.needsLook.title')} icon={SearchCheckIcon}>
      <ul className="space-y-3">
        {kinds.map((kind) => {
          const href = hrefs[kind]
          return (
            <li
              key={kind}
              data-needs-look={kind}
              className="rounded-xl bg-muted/50 px-3 py-2.5 text-sm"
            >
              <p className="font-medium">{t(`dashboard.cards.needsLook.${kind}`)}</p>
              <p className="mt-0.5 break-words">
                {formatList(
                  locale,
                  look[kind].map((item) => isolate(item.name)),
                )}
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {t(`dashboard.cards.needsLook.${kind}Hint`)}
              </p>
              {href ? (
                <Button asChild variant="outline" size="sm" className="mt-2 h-9 bg-card">
                  <Link href={href}>{t(`dashboard.cards.needsLook.actions.${kind}`)}</Link>
                </Button>
              ) : null}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/** The decision cards, for this month so far. */
export function DecisionCards({
  cards,
  businessId,
  context,
}: {
  cards: Cards
  businessId: string
  context: BusinessContextDto
}) {
  const { t } = useTranslation()
  const monthName = useBusinessMonth()
  const businessDate = useBusinessDate()
  const money = useMoney()
  const percent = usePercent()
  const headingId = useId()
  const page = (path: string) => `/b/${businessId}/${path}`
  const reportsOpen = moduleAccess(context.modules, 'reports', 'real_profit') === 'open'
  const salesOpen = moduleAccess(context.modules, 'sales', 'sales') === 'open'
  const vat = context.capabilities.vat_registered === true
  const profit = shown(cards.profit)
  const profitValue = profit ? shown(profit.profit) : null
  const lastProfit = profit ? shown(profit.lastMonthProfit) : null
  const margin = profit ? shown(profit.marginPercent) : null
  const concerns = shown(cards.concerns)
  const costIncreases = shown(cards.costIncreases)
  const needsLook = shown(cards.needsLook)
  const moneyWent = shown(cards.moneyWent)
  const days = cards.byDay?.days ?? []
  const dayProfit = days.some((day) => shown(day.profit) !== null)
  const said = (value: string) => money(value).replaceAll(' ', NBSP)
  const dayText = (value: string) => businessDate(value).replaceAll(' ', NBSP)
  // What the month's profit takes off so far (D-250): early in a month these costs can outweigh the
  // sales, so the tile says them, and says so plainly when they do.
  const monthCosts = profit ? shown(profit.monthCosts) : null
  const costsFrom = profit ? shown(profit.costsFrom) : null
  const sold = profit ? profit.sold !== false : true
  const salesSoFar = cards.sales?.value ?? moneyWent?.sales ?? null
  const costsAhead =
    monthCosts !== null && salesSoFar !== null && sold && compareDecimal(monthCosts, salesSoFar) > 0
  // The chart's hint: whether the days carry their share yet, and that the month's figure takes off
  // its costs so far (to a member who sees them).
  const rateState = cards.byDay ? shown(cards.byDay.rateState) : null
  const showsOn = cards.byDay ? shown(cards.byDay.showsOn) : null
  const chartHint = !dayProfit
    ? undefined
    : [
        rateState === 'applied' || rateState === 'none'
          ? t('dashboard.cards.chart.hint')
          : rateState === 'before_running_costs' && showsOn
            ? t('dashboard.cards.chart.hintBefore', { day: dayText(showsOn) })
            : null,
        monthCosts !== null && rateState !== 'off' ? t('dashboard.cards.chart.hintMonth') : null,
      ]
        .filter(Boolean)
        .join(' ') || undefined
  const lookHrefs: Record<LookKind, string | null> = {
    unpricedMaterials:
      hasModule(context, 'purchases') && can(context, 'purchases.documents.manage')
        ? page('purchases/new')
        : null,
    channelsWithoutFees: can(context, 'sales.channels.manage')
      ? sectionPath(businessId, 'channels')
      : null,
    productsWithoutRecipe:
      hasModule(context, 'products') && can(context, 'products.items.view')
        ? page('products')
        : null,
    materialsInNoRecipe:
      hasModule(context, 'products') && can(context, 'products.items.view')
        ? page('products')
        : null,
  }

  return (
    <section aria-labelledby={headingId} data-decision-cards className="space-y-4">
      <h2 id={headingId} className="text-lg font-semibold tracking-tight">
        {t('dashboard.cards.title', { month: monthName(cards.month) })}
      </h2>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {profit && profitValue !== null ? (
          <Tile
            id="profit"
            icon={sold && isLoss(profitValue) ? TrendingDownIcon : TrendingUpIcon}
            label={t(
              sold && isLoss(profitValue)
                ? 'dashboard.cards.profit.loss'
                : 'dashboard.cards.profit.title',
            )}
            // Nothing sold this month yet: no figure to call a loss, only the costs so far below.
            value={sold ? withoutMinus(profitValue) : null}
            words={t('dashboard.cards.profit.noSales')}
            loss={sold && isLoss(profitValue)}
            href={reportsOpen ? page('reports/profit?by=day') : null}
            lines={
              <>
                {sold && margin !== null ? (
                  <p>
                    {isLoss(margin)
                      ? t('dashboard.cards.profit.lossMargin', {
                          percent: percent(withoutMinus(margin)),
                        })
                      : t('dashboard.cards.profit.margin', { percent: percent(margin) })}
                  </p>
                ) : null}
                {monthCosts !== null && costsFrom !== null ? (
                  <p data-costs-so-far>
                    {costsFrom === profit.from
                      ? t('dashboard.cards.profit.costsSoFar', { amount: said(monthCosts) })
                      : // A first month counts its costs from the first sale (D-237).
                        t('dashboard.cards.profit.costsSince', {
                          day: dayText(costsFrom),
                          amount: said(monthCosts),
                        })}
                  </p>
                ) : null}
                {costsAhead ? (
                  <p data-costs-ahead className="font-medium text-foreground">
                    {t('dashboard.cards.profit.costsAhead')}
                  </p>
                ) : null}
                {lastProfit !== null ? (
                  <p>
                    {isLoss(lastProfit)
                      ? t('dashboard.cards.profit.lastMonthLoss', {
                          amount: said(withoutMinus(lastProfit)),
                        })
                      : t('dashboard.cards.profit.lastMonth', { amount: said(lastProfit) })}
                  </p>
                ) : null}
                {profit.complete === false ? (
                  <Badge tone="warning" className="mt-1">
                    {t('dashboard.cards.profit.incomplete')}
                  </Badge>
                ) : null}
                {profit.beforeRunningCosts === true ? (
                  <p>{t('dashboard.cards.profit.beforeRunning')}</p>
                ) : null}
              </>
            }
          />
        ) : null}
        {cards.sales ? (
          <Tile
            id="sales"
            icon={BanknoteIcon}
            label={t(vat ? 'dashboard.cards.sales.titleBeforeVat' : 'dashboard.cards.sales.title')}
            value={cards.sales.value}
            href={salesOpen ? page('sales') : null}
            lines={
              cards.sales.lastMonth !== null ? (
                <p>
                  {t('dashboard.cards.sales.lastMonth', { amount: said(cards.sales.lastMonth) })}
                </p>
              ) : null
            }
          />
        ) : null}
        {moneyWent ? <MoneyWent money={moneyWent} context={context} /> : null}
      </div>
      {days.length > 0 ? (
        <Card
          id="by-day"
          title={t(dayProfit ? 'dashboard.cards.chart.title' : 'dashboard.cards.chart.titleSales')}
          hint={chartHint}
          action={
            reportsOpen ? (
              <More
                href={page('reports/profit?by=day')}
                label={t(
                  dayProfit ? 'dashboard.cards.profit.open' : 'dashboard.cards.chart.openSales',
                )}
              />
            ) : undefined
          }
        >
          <SalesProfitChart
            days={days.map((day) => ({
              day: day.day,
              sales: day.sales,
              profit: shown(day.profit),
            }))}
          />
        </Card>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {cards.topProducts && cards.topProducts.byQuantity.length > 0 ? (
          <TopProducts top={cards.topProducts} />
        ) : null}
        {concerns && concerns.length > 0 ? (
          <Concerns
            concerns={concerns}
            href={
              reportsOpen
                ? page('reports/profit?by=product&show=low_margin&sort=margin_percent_asc')
                : null
            }
          />
        ) : null}
        {costIncreases && costIncreases.length > 0 ? <CostIncreases items={costIncreases} /> : null}
        {cards.byChannel && cards.byChannel.length > 1 ? (
          <Channels channels={cards.byChannel} />
        ) : null}
        {needsLook ? <NeedsLook look={needsLook} hrefs={lookHrefs} /> : null}
      </div>
    </section>
  )
}
