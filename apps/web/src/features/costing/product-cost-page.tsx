'use client'

import { apiErrorCode, useTRPC } from '@bizcost/app-core'
import type { ProductCostBreakdownDto, ProductCostLineDto } from '@bizcost/contracts'
import { compareDecimal, type IncompleteReason, type TerminologyProfile } from '@bizcost/domain'
import { formatList } from '@bizcost/i18n'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftIcon,
  CircleAlertIcon,
  CookingPotIcon,
  ListChecksIcon,
  PencilIcon,
  SearchXIcon,
} from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { FormAlert } from '@/components/form/form-alert'
import { ModuleGate } from '@/components/shell/module-gate'
import { PageContainer } from '@/components/shell/page-container'
import { LoadError, SectionSkeleton } from '@/components/states/query-state'
import { StatePanel } from '@/components/states/state-panel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ProductSheet } from '@/features/catalog/product-sheet'
import { RecipeSheet } from '@/features/catalog/recipe-sheet'
import { useFormatQuantity, useUnitQuantity } from '@/features/catalog/unit-parts'
import { NBSP } from '@/features/catalog/units'
import {
  Locked,
  useBusinessDate,
  useBusinessMonth,
  useMoney,
  useUnitCost,
} from '@/features/documents/amounts'
import { Panel } from '@/features/documents/panel'
import { hasModule } from '@/features/purchasing/data'
import { can, isSectionVisible, sectionPath } from '@/features/settings/sections'
import { useLocale, useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { invalidateProfit } from '@/features/reports/refresh'
import { useDuration, usePercent, useRatePercent, useRateWords, useReasonWords } from './words'

// One product's cost, line by line (ROADMAP.md M2 Step 6; D-115, D-119, D-178, D-202): what one unit
// sold costs and what is left of its price; each part of the cost with how it was worked out, in
// words (the materials of its recipe ÷ what it makes, its share of the running costs by its price,
// the owner's time); what is missing, with the way to add it; and each material of its recipe (how
// much, its average cost, the line's cost and its last purchase cost). The product and its recipe
// open from here, and the costs are read again once they close. Costs are `cost`, prices paid
// `supplier_price` and margins `profit_margin`, visible only together (D-187): a member who may not
// see them sees locks. While the cost is incomplete its margin is only "at most" (D-186). Until sales
// are recorded its share of running costs waits for them (D-202): its cost and margin say they are
// before running costs, and the margin is never green; when that share is its only line, its cost is
// worked out then, never "not worked out yet", and a service's optional materials are a hint on its
// materials line, never "what's missing" (D-203). Once sales are recorded (M3 Step 3, while Sales is
// served) the share is live: "AED 4.50 · 25% of its price (September 2026)", with which month's rate
// it is ("At September's rate until October ends"), and the margin is after running costs.

type Breakdown = ProductCostBreakdownDto['data']

/** A page on its way (also its loading.tsx). */
export function ProductCostLoading() {
  return (
    <PageContainer>
      <SectionSkeleton cards={3} />
    </PageContainer>
  )
}

function BackLink() {
  const { t } = useTranslation()
  const { businessId } = useParams<{ businessId: string }>()
  return (
    <Link
      href={`/b/${businessId}/product-costs`}
      className="-ms-2 -mt-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:underline"
    >
      <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
      {t('common.nav.product_costs')}
    </Link>
  )
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

/** "Not counted yet" and the like, where an amount would be. */
function Muted({ children }: { children: ReactNode }) {
  return <span className="font-normal text-muted-foreground">{children}</span>
}

/**
 * One unit's cost and what is left of its price, at the top of the page. The two figures stack on a
 * phone and in the side column (amounts in the thousands never run into each other). While the cost
 * is incomplete the margin is only "at most" (muted, never green); a loss is said as a loss, without
 * a minus.
 */
function Summary({ data, per }: { data: Breakdown; per: string }) {
  const { t } = useTranslation()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const percent = usePercent()
  const { cost, margin, price } = data
  const loss = typeof margin.amount === 'string' && compareDecimal(margin.amount, '0') < 0
  const upTo = cost.complete === false && typeof margin.amount === 'string' && !loss
  // Its share of running costs is not in them yet (awaiting sales, D-202): never read as final.
  const before = cost.beforeRunningCosts === true
  const stripped = compareDecimal(price.vatRate, '0') > 0 && price.beforeVat !== null
  const awaiting = cost.complete === true && cost.runningCosts.state === 'awaiting_sales'
  const soon = cost.complete === true && cost.runningCosts.state === 'before_running_costs'
  const shownMargin =
    typeof margin.amount === 'string' && loss ? margin.amount.replace(/^-/, '') : margin.amount
  return (
    <section
      aria-label={t('costing.detail.cost', { per })}
      className="rounded-2xl bg-card p-5 shadow-sm ring-1 ring-foreground/[0.06]"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-1">
        <div data-summary="cost" className="min-w-0">
          <p className="text-sm text-muted-foreground">
            {t(before ? 'costing.detail.costBefore' : 'costing.detail.cost', { per })}
          </p>
          <p className="mt-1 text-2xl font-semibold sm:text-3xl">
            {cost.total === undefined ? (
              <Locked category="cost" className="text-base" />
            ) : cost.total === null ? (
              <Muted>
                <span className="text-base">
                  {cost.tooLarge
                    ? t('costing.list.row.tooLarge')
                    : awaiting
                      ? t('costing.list.row.awaiting')
                      : soon
                        ? t('costing.list.row.soon')
                        : t('costing.list.row.notCounted')}
                </span>
              </Muted>
            ) : (
              <Amount value={cost.total} />
            )}
          </p>
          {cost.complete === false ? (
            <Badge tone="warning" className="mt-1.5">
              {t('costing.detail.incompleteShort')}
            </Badge>
          ) : null}
        </div>
        <div data-summary="margin" className="min-w-0">
          <p className="text-sm text-muted-foreground">
            {t(
              loss
                ? before
                  ? 'costing.detail.lossBefore'
                  : 'costing.detail.loss'
                : before
                  ? 'costing.detail.marginBefore'
                  : 'costing.detail.margin',
              { per },
            )}
          </p>
          <p
            className={cn(
              'mt-1 text-2xl font-semibold sm:text-3xl',
              loss
                ? 'text-destructive'
                : upTo
                  ? 'text-muted-foreground'
                  : before
                    ? 'text-foreground'
                    : 'text-success',
            )}
          >
            {margin.amount === undefined ? (
              <Locked category="profit_margin" className="text-base" />
            ) : shownMargin === null || shownMargin === undefined ? (
              <Muted>—</Muted>
            ) : (
              <>
                {upTo ? (
                  <span data-at-most className="me-1.5 text-base font-normal whitespace-nowrap">
                    {t('costing.list.row.atMost')}
                  </span>
                ) : null}
                <Amount value={shownMargin} />
              </>
            )}
          </p>
          {typeof margin.percent === 'string' ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {upTo
                ? t(stripped ? 'costing.detail.atMost' : 'costing.detail.atMostNoVat', {
                    percent: percent(margin.percent),
                  })
                : t(stripped ? 'costing.detail.ofPrice' : 'costing.detail.ofPriceNoVat', {
                    // A loss is said as a loss: without a minus, as its amount.
                    percent: percent(loss ? margin.percent.replace(/^-/, '') : margin.percent),
                  })}
            </p>
          ) : null}
          {upTo ? (
            <p data-margin-at-most className="mt-1 text-sm text-muted-foreground">
              {t('costing.detail.marginAtMost')}
            </p>
          ) : null}
          {cost.runningCosts.state === 'awaiting_sales' ? (
            <p data-before-running className="mt-1 text-sm text-muted-foreground">
              {t(
                data.type === 'service'
                  ? 'costing.detail.beforeRunningService'
                  : 'costing.detail.beforeRunning',
              )}
            </p>
          ) : cost.runningCosts.state === 'before_running_costs' && data.monthCosts.showsOn ? (
            <p data-before-running className="mt-1 text-sm text-muted-foreground">
              {t('costing.detail.beforeRunningSoon', {
                day: businessDate(data.monthCosts.showsOn).replaceAll(' ', NBSP),
              })}
            </p>
          ) : null}
        </div>
      </div>
      <p data-at-price className="mt-4 border-t pt-3 text-sm text-muted-foreground">
        {price.defaultPrice === null
          ? t('costing.detail.noPrice')
          : stripped && price.beforeVat
            ? t('costing.detail.atPriceBeforeVat', {
                price: money(price.defaultPrice),
                beforeVat: money(price.beforeVat),
              })
            : t('costing.detail.atPrice', { price: money(price.defaultPrice) })}
      </p>
    </section>
  )
}

/** One part of the cost: its label and amount on a line, how it was worked out under it. */
function CostLine({
  id,
  label,
  value,
  children,
  strong = false,
}: {
  id: string
  label: string
  value: ReactNode
  children?: ReactNode
  strong?: boolean
}) {
  return (
    <div data-line={id} className={cn('py-3', strong && 'border-t-2')}>
      <div className="flex items-baseline justify-between gap-4">
        <dt className={cn('min-w-0', strong ? 'font-semibold' : 'font-medium')}>{label}</dt>
        <dd className={cn('shrink-0 text-end', strong ? 'text-lg font-semibold' : 'font-medium')}>
          {value}
        </dd>
      </div>
      {children ? (
        <div className="mt-1 space-y-1 text-sm leading-relaxed text-muted-foreground">
          {children}
        </div>
      ) : null}
    </div>
  )
}

/** A value of a line: a lock when hidden, the words when there is none, else the amount. */
function lineValue(
  value: string | null | undefined,
  none: string,
  category: 'cost' | 'profit_margin' = 'cost',
): ReactNode {
  if (value === undefined) return <Locked category={category} />
  if (value === null) return <Muted>{none}</Muted>
  return <Amount value={value} />
}

/** The parts of the cost, with how each was worked out in words, then the total and the margin. */
function CostLines({
  data,
  per,
  profile,
  onEditProduct,
}: {
  data: Breakdown
  per: string
  profile: TerminologyProfile
  onEditProduct: (() => void) | null
}) {
  const { t } = useTranslation()
  const term = useTerminology()
  const money = useMoney()
  const percent = usePercent()
  const unitQuantity = useUnitQuantity()
  const duration = useDuration()
  const rateWords = useRateWords()
  const ratePercent = useRatePercent()
  const monthName = useBusinessMonth()
  const businessDate = useBusinessDate()
  const { data: context } = useBusinessContext()
  const runningCostsOn = context ? hasModule(context, 'running_costs') : false
  const { cost, margin, price, materials } = data
  const notCounted = t('costing.detail.lines.notCounted')
  const running = cost.runningCosts
  const time = cost.ownerTime
  const stripped = compareDecimal(price.vatRate, '0') > 0 && price.beforeVat !== null
  // The share of running costs is not in the total yet (D-202): the total and margin say so.
  const before = cost.beforeRunningCosts === true

  let materialsLine: ReactNode = null
  if (materials !== null) {
    const resale = data.kind === 'resale'
    const noRecipe = !resale && materials.lines.length === 0
    // A service may use none: said as such, never "not counted".
    const noneUsed = noRecipe && data.type === 'service'
    const yieldQty = materials.yieldQty
    materialsLine = (
      <CostLine
        id="materials"
        label={
          resale
            ? t('costing.detail.lines.resale')
            : term('costing.detail.lines.materials', profile)
        }
        value={
          noneUsed && cost.materials !== undefined ? (
            <Muted>{t('costing.list.row.none')}</Muted>
          ) : (
            lineValue(cost.materials, noRecipe ? notCounted : t('costing.detail.lines.noPrice'))
          )
        }
      >
        {noneUsed && cost.materials !== undefined ? (
          <p>{t('costing.detail.lines.noMaterials')}</p>
        ) : null}
        {resale ? <p>{t('costing.detail.lines.resaleHint')}</p> : null}
        {!resale && compareDecimal(yieldQty, '1') !== 0 && typeof materials.total === 'string' ? (
          <p data-whole>
            {term('costing.detail.lines.whole', profile, {
              total: money(materials.total),
              qty: unitQuantity(yieldQty, data.unit),
            })}
          </p>
        ) : null}
        {materials.unpricedLines > 0 && typeof cost.materials === 'string' ? (
          <p>{t('costing.detail.lines.withoutUnpriced')}</p>
        ) : null}
      </CostLine>
    )
  }

  let runningLine: ReactNode = null
  if (running.state !== 'off') {
    // By its price (D-202): once sales are recorded, its share at this month's rate, live ("AED 4.50
    // · 25% of its price (September 2026)", M3 Step 3); until then worked out once sales are
    // recorded, or once 7 days of sales exist; without a price, none can be worked out by it: said
    // plainly, with the way to add it.
    const words = rateWords(data.monthCosts, runningCostsOn, data.today)
    const share = typeof running.amount === 'string' ? running.amount : null
    const rate = typeof data.monthCosts.rate === 'string' ? data.monthCosts.rate : null
    const soFar = data.monthCosts.basis === 'so_far'
    const shareKey = soFar
      ? stripped
        ? 'costing.detail.lines.shareSoFarBeforeVat'
        : 'costing.detail.lines.shareSoFar'
      : stripped
        ? 'costing.detail.lines.shareBeforeVat'
        : 'costing.detail.lines.share'
    runningLine = (
      <CostLine
        id="running"
        label={t('costing.detail.lines.running')}
        value={
          running.state === undefined ? (
            <Locked category="cost" />
          ) : (running.state === 'applied' || running.state === 'none') && share !== null ? (
            <Amount value={share} />
          ) : (
            <Muted>{notCounted}</Muted>
          )
        }
      >
        {running.state === 'no_price' ? (
          <p data-no-price>{t('costing.detail.lines.runningNoPrice')}</p>
        ) : running.state === 'awaiting_sales' ? (
          <p data-awaiting className="font-medium text-foreground">
            {t('costing.detail.lines.runningAwaiting')}
          </p>
        ) : running.state === 'before_running_costs' ? (
          <p data-awaiting className="font-medium text-foreground">
            {t('costing.detail.lines.runningBefore', {
              day: data.monthCosts.showsOn
                ? businessDate(data.monthCosts.showsOn).replaceAll(' ', NBSP)
                : '',
            })}
          </p>
        ) : running.state === 'none' ? (
          <p data-share>{t('costing.detail.lines.runningNone')}</p>
        ) : running.state === 'applied' && share !== null && rate !== null ? (
          <p data-share className="font-medium text-foreground">
            {t(shareKey, {
              amount: money(share).replaceAll(' ', NBSP),
              percent: ratePercent(rate),
              month: monthName(data.monthCosts.month).replaceAll(' ', NBSP),
            })}
          </p>
        ) : null}
        {words?.basis ? <p data-basis>{words.basis}</p> : null}
        {words ? <p data-rate>{words.rule}</p> : null}
      </CostLine>
    )
  }

  let timeLine: ReactNode = null
  if (time.state !== 'team' && data.ownerTime.applies) {
    const minutes = typeof time.minutes === 'string' ? duration(time.minutes) : null
    timeLine = (
      <CostLine
        id="time"
        label={t('costing.detail.lines.time')}
        value={
          time.state === undefined ? (
            <Locked category="cost" />
          ) : time.state === 'none' ? (
            <Muted>{t('costing.list.row.none')}</Muted>
          ) : (
            lineValue(time.amount, notCounted)
          )
        }
      >
        {time.state === 'applied' && minutes && typeof data.ownerTime.hourlyRate === 'string' ? (
          <p>
            {t('costing.detail.lines.timeApplied', {
              minutes,
              rate: money(data.ownerTime.hourlyRate),
            })}
          </p>
        ) : time.state === 'rate_not_set' && minutes ? (
          <p>{t('costing.detail.lines.timeRateNotSet', { minutes })}</p>
        ) : time.state === 'none' ? (
          <>
            <p>{t('costing.detail.lines.timeNone')}</p>
            {onEditProduct ? (
              <div className="pt-1">
                <Button variant="outline" size="sm" className="h-9" onClick={onEditProduct}>
                  <PencilIcon aria-hidden />
                  {t('costing.detail.editProduct')}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </CostLine>
    )
  }

  const priceLine = (
    <CostLine
      id="price"
      label={t(stripped ? 'costing.detail.lines.priceBeforeVat' : 'costing.detail.lines.price')}
      value={
        price.defaultPrice === null ? (
          <Muted>{t('catalog.products.noPrice')}</Muted>
        ) : (
          <Amount value={stripped && price.beforeVat ? price.beforeVat : price.defaultPrice} />
        )
      }
    />
  )
  const loss = typeof margin.amount === 'string' && compareDecimal(margin.amount, '0') < 0
  // While the cost is incomplete the margin is only "at most" (a loss stays a loss).
  const upTo = cost.complete === false && typeof margin.amount === 'string' && !loss
  return (
    <Panel title={t('costing.detail.lines.title')}>
      <dl className="-my-3 divide-y">
        {materialsLine}
        {runningLine}
        {timeLine}
        <CostLine
          id="total"
          strong
          label={t(before ? 'costing.detail.lines.totalBefore' : 'costing.detail.lines.total', {
            per,
          })}
          value={
            cost.total === undefined ? (
              <Locked category="cost" />
            ) : cost.total === null ? (
              <Muted>
                {cost.tooLarge
                  ? t('costing.list.row.tooLarge')
                  : cost.complete === true && running.state === 'awaiting_sales'
                    ? t('costing.list.row.awaiting')
                    : cost.complete === true && running.state === 'before_running_costs'
                      ? t('costing.list.row.soon')
                      : t('costing.list.row.notCounted')}
              </Muted>
            ) : (
              <Amount value={cost.total} />
            )
          }
        >
          {cost.complete === false ? <p>{t('costing.detail.incomplete')}</p> : null}
        </CostLine>
        {priceLine}
        <CostLine
          id="margin"
          label={t(before ? 'costing.detail.lines.marginBefore' : 'costing.detail.lines.margin')}
          value={
            margin.amount === undefined ? (
              <Locked category="profit_margin" />
            ) : margin.amount === null ? (
              <Muted>—</Muted>
            ) : (
              <span className={cn(loss && 'text-destructive', upTo && 'text-muted-foreground')}>
                {upTo ? (
                  <span data-at-most className="me-1.5 text-sm font-normal whitespace-nowrap">
                    {t('costing.list.row.atMost')}
                  </span>
                ) : null}
                <Amount value={margin.amount} />
                {typeof margin.percent === 'string' ? (
                  <span className="ms-2 text-sm font-normal text-muted-foreground">
                    <bdi>{percent(margin.percent)}</bdi>
                  </span>
                ) : null}
              </span>
            )
          }
        />
      </dl>
    </Panel>
  )
}

/**
 * What is missing from the cost, each in a sentence with the way to add it where there is one; the
 * materials with no price yet by name.
 */
function Missing({
  data,
  profile,
  action,
}: {
  data: Breakdown
  profile: TerminologyProfile
  action: (reason: IncompleteReason) => ReactNode
}) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const words = useReasonWords()
  // Complete with a reason left: only a service's optional materials, said on its materials line.
  const reasons = data.cost.complete === true ? [] : (data.cost.reasons ?? [])
  const unpriced = [
    ...new Set(
      (data.materials?.lines ?? [])
        .filter((line) => line.cost === null)
        .map((line) => line.materialName),
    ),
  ]
  const sentence = (reason: IncompleteReason) =>
    reason === 'unpriced_materials' && unpriced.length > 0 && data.kind === 'recipe'
      ? t('costing.reasons.long.unpriced_named', { names: formatList(locale, unpriced) })
      : words.long(reason, profile, data.type)
  if (reasons.length === 0) return null
  return (
    <Panel title={t('costing.detail.missing.title')}>
      <ul className="space-y-3">
        {reasons.map((reason) => {
          const button = action(reason)
          return (
            <li key={reason} data-reason={reason} className="flex items-start gap-2.5">
              <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
              <div className="min-w-0 space-y-2 text-sm leading-relaxed">
                <p>{sentence(reason)}</p>
                {button}
              </div>
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}

/** "AED 0.065 per g": a cost per the material's unit. */
function usePerUnit() {
  const { t } = useTranslation()
  const unitCost = useUnitCost()
  return (amount: string, unit: ProductCostLineDto['materialUnit']) =>
    `${unitCost(amount)}${NBSP}${t(`units.per.${unit}`)}`.replaceAll(' ', NBSP)
}

/** Each material of the recipe: how much, its average, the line's cost, its last purchase cost. */
function MaterialLines({
  data,
  profile,
  per,
}: {
  data: Breakdown
  profile: TerminologyProfile
  per: string
}) {
  const { t } = useTranslation()
  const term = useTerminology()
  const format = useFormatQuantity()
  const unitQuantity = useUnitQuantity()
  const perUnit = usePerUnit()
  const businessDate = useBusinessDate()
  const { data: context } = useBusinessContext()
  const seesCosts = context?.visibleCategories.includes('cost') === true
  const materials = data.materials
  if (!materials || data.kind === 'resale' || materials.lines.length === 0) return null
  const yieldQty = materials.yieldQty
  const makes = compareDecimal(yieldQty, '1') !== 0
  const qtyOf = (line: ProductCostLineDto) =>
    line.unit
      ? unitQuantity(line.qty, line.unit)
      : `${format(line.qty)}${NBSP}${line.packName ?? ''}`
  const average = (line: ProductCostLineDto) =>
    line.cost === null ? (
      <Muted>{t('catalog.recipes.noPrice')}</Muted>
    ) : line.cost.perUnit === undefined ? (
      <Locked category="cost" />
    ) : (
      <>
        <bdi className="tabular-nums">{perUnit(line.cost.perUnit, line.materialUnit)}</bdi>
        {line.cost.basis === 'last_purchase' ? (
          <span className="block text-xs text-muted-foreground">
            {t('costing.detail.materials.lastBasis')}
          </span>
        ) : null}
      </>
    )
  const lineCost = (line: ProductCostLineDto) =>
    line.cost === null ? (
      <Muted>—</Muted>
    ) : line.cost.lineCost === undefined ? (
      <Locked category="cost" />
    ) : (
      <Amount value={line.cost.lineCost} className="font-medium" />
    )
  const last = (line: ProductCostLineDto) =>
    line.lastPurchase === null ? (
      <Muted>{t('costing.detail.materials.neverBought')}</Muted>
    ) : line.lastPurchase.pricePerUnit === undefined ? (
      <Locked category="supplier_price" />
    ) : (
      <>
        <bdi className="tabular-nums">
          {perUnit(line.lastPurchase.pricePerUnit, line.materialUnit)}
        </bdi>
        <span className="block text-xs text-muted-foreground">
          {businessDate(line.lastPurchase.businessDate).replaceAll(' ', NBSP)}
        </span>
      </>
    )
  const cell = 'px-3 py-3 align-top'
  return (
    <Panel
      title={term('catalog.recipes.title', profile)}
      hint={
        makes
          ? term('catalog.recipes.makes', profile, { qty: unitQuantity(yieldQty, data.unit) })
          : undefined
      }
    >
      {/* A table from 768 px; each material a small card on a phone. */}
      <table className="hidden w-full text-sm md:table">
        <thead>
          <tr className="text-xs text-muted-foreground">
            <th scope="col" className="px-3 pb-2 text-start font-medium">
              {term('catalog.recipes.material', profile)}
            </th>
            <th scope="col" className="px-3 pb-2 text-end font-medium">
              {t('costing.detail.materials.qty')}
            </th>
            <th scope="col" className="px-3 pb-2 text-end font-medium">
              {t('costing.detail.materials.average')}
            </th>
            <th scope="col" className="px-3 pb-2 text-end font-medium">
              {t('costing.detail.materials.line')}
            </th>
            <th scope="col" className="px-3 pb-2 text-end font-medium">
              {t('costing.detail.materials.last')}
            </th>
          </tr>
        </thead>
        <tbody>
          {materials.lines.map((line) => (
            <tr key={line.materialId} data-material-line={line.materialName} className="border-t">
              <td className={cn(cell, 'font-medium')}>
                <span dir="auto" className="break-words">
                  {line.materialName}
                </span>
              </td>
              <td className={cn(cell, 'text-end whitespace-nowrap')}>
                <bdi>{qtyOf(line)}</bdi>
              </td>
              <td className={cn(cell, 'text-end')}>{average(line)}</td>
              <td className={cn(cell, 'text-end')}>{lineCost(line)}</td>
              <td className={cn(cell, 'text-end')}>{last(line)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="-mx-1 divide-y md:hidden">
        {materials.lines.map((line) => (
          <li key={line.materialId} data-material-line={line.materialName} className="px-1 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span dir="auto" className="min-w-0 font-medium break-words">
                {line.materialName}
              </span>
              <span className="shrink-0 font-medium">{lineCost(line)}</span>
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              <bdi>{qtyOf(line)}</bdi>
            </p>
            <dl className="mt-2 grid grid-cols-2 gap-3 text-sm">
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">
                  {t('costing.detail.materials.average')}
                </dt>
                <dd>{average(line)}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">
                  {t('costing.detail.materials.last')}
                </dt>
                <dd>{last(line)}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>
      <dl className="mt-2 space-y-1.5 border-t pt-3 text-sm">
        {makes ? (
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">
              {term('catalog.recipes.totalWhole', profile, {
                qty: unitQuantity(yieldQty, data.unit),
              })}
            </dt>
            <dd data-recipe-total className="font-medium">
              {lineValue(materials.total, t('costing.detail.lines.noPrice'))}
            </dd>
          </div>
        ) : null}
        <div className="flex items-baseline justify-between gap-4">
          <dt className="font-medium">{term('catalog.recipes.perUnitCost', profile, { per })}</dt>
          <dd data-recipe-per-unit className="font-semibold">
            {lineValue(materials.perUnit, t('costing.detail.lines.noPrice'))}
          </dd>
        </div>
      </dl>
      {/* Where the costs come from, to a member who sees them. */}
      {seesCosts ? (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          {t('costing.detail.materials.basis', {
            from: businessDate(materials.averageFrom),
            to: businessDate(materials.averageTo),
          })}
        </p>
      ) : null}
    </Panel>
  )
}

function Breakdown({ productId }: { productId: string }) {
  const { t } = useTranslation()
  const term = useTerminology()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const breakdown = useQuery(trpc.productCost.get.queryOptions({ productId }))
  const canEditProduct = context !== undefined && can(context, 'products.items.manage')
  const canOpenRecipe =
    context !== undefined &&
    hasModule(context, 'materials') &&
    can(context, 'materials.items.view') &&
    can(context, 'products.recipes.view')
  const [open, setOpen] = useState<'product' | 'recipe' | null>(null)
  // The product itself, for its form and its recipe (only once one is asked for).
  const product = useQuery({
    ...trpc.product.get.queryOptions({ id: productId }),
    enabled: open !== null,
  })
  if (!context) return null
  if (breakdown.isPending) return <ProductCostLoading />
  if (breakdown.isError) {
    return (
      <PageContainer>
        {apiErrorCode(breakdown.error) === 'not_found' ? (
          <StatePanel
            icon={SearchXIcon}
            title={t('costing.detail.notFound.title')}
            body={t('costing.detail.notFound.body')}
          >
            <Button asChild variant="outline" size="lg">
              <Link href={`/b/${businessId}/product-costs`}>
                {t('states.goTo', { section: t('common.nav.product_costs') })}
              </Link>
            </Button>
          </StatePanel>
        ) : (
          <LoadError error={breakdown.error} onRetry={() => void breakdown.refetch()} />
        )}
      </PageContainer>
    )
  }
  const data = breakdown.data.data
  const profile = context.terminologyProfile
  const per = t(`units.per.${data.unit}`)
  // Costs, margins and supplier prices are visible only together (D-187).
  const seesCosts = context.visibleCategories.includes('cost')
  const recipeProduct = data.kind === 'recipe' && canOpenRecipe
  const close = () => {
    setOpen(null)
    void invalidateProfit(queryClient, trpc)
  }
  const settingsLink = (label: string) =>
    isSectionVisible(context, 'costing') ? (
      <Button asChild variant="outline" size="sm" className="h-9">
        <Link href={sectionPath(businessId, 'costing')}>{label}</Link>
      </Button>
    ) : (
      <span className="text-muted-foreground">{t('costing.how.askOwner')}</span>
    )
  const recipeButton = recipeProduct ? (
    <Button variant="outline" onClick={() => setOpen('recipe')}>
      {profile === 'food' ? <CookingPotIcon aria-hidden /> : <ListChecksIcon aria-hidden />}
      {term('catalog.recipes.title', profile)}
    </Button>
  ) : null
  const action = (reason: IncompleteReason): ReactNode => {
    switch (reason) {
      case 'no_recipe':
      case 'unpriced_materials':
        return recipeButton
      case 'hourly_rate_not_set':
        return settingsLink(t('costing.how.setRate'))
      case 'no_price':
        return canEditProduct ? (
          <Button variant="outline" size="sm" className="h-9" onClick={() => setOpen('product')}>
            <PencilIcon aria-hidden />
            {t('costing.detail.addPrice')}
          </Button>
        ) : null
      default:
        return null
    }
  }

  return (
    <PageContainer>
      <BackLink />
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xl font-semibold tracking-tight sm:text-3xl">
            <span dir="auto" className="min-w-0 break-words">
              {data.name}
            </span>
            {data.type === 'service' ? (
              <Badge tone="primary" className="text-sm">
                {t('catalog.products.type.service')}
              </Badge>
            ) : data.kind === 'resale' ? (
              <Badge className="text-sm">{t('catalog.products.resale.badge')}</Badge>
            ) : null}
            {data.archived ? (
              <Badge className="text-sm">{t('catalog.list.archivedBadge')}</Badge>
            ) : null}
          </h1>
          <p className="mt-1.5 text-muted-foreground">{t('costing.detail.intro', { per })}</p>
        </div>
        {canEditProduct || recipeButton ? (
          <div className="flex shrink-0 flex-wrap gap-2">
            {recipeButton}
            {canEditProduct ? (
              <Button variant="outline" onClick={() => setOpen('product')}>
                <PencilIcon aria-hidden />
                {t('costing.detail.editProduct')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </header>
      {!seesCosts ? (
        <FormAlert tone="info" className="mb-5">
          <span data-costs-hidden>{t('costing.hidden')}</span>
        </FormAlert>
      ) : null}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] xl:items-start">
        <div className="space-y-5 xl:col-start-2 xl:row-start-1">
          <Summary data={data} per={per} />
          <Missing data={data} profile={profile} action={action} />
        </div>
        <div className="min-w-0 space-y-5 xl:col-start-1 xl:row-start-1">
          <CostLines
            data={data}
            per={per}
            profile={profile}
            onEditProduct={canEditProduct ? () => setOpen('product') : null}
          />
          <MaterialLines data={data} profile={profile} per={per} />
        </div>
      </div>
      {open === 'product' && product.data ? (
        <ProductSheet
          key={product.data.id}
          product={product.data}
          profile={profile}
          onClose={close}
        />
      ) : null}
      {open === 'recipe' && product.data ? (
        <RecipeSheet
          key={product.data.id}
          product={product.data}
          profile={profile}
          onClose={close}
        />
      ) : null}
    </PageContainer>
  )
}

/** The Product costs breakdown of one product, inside the Cost Engine's gate. */
export function ProductCostPage({ productId }: { productId: string }) {
  return (
    <ModuleGate moduleId="cost_engine" entryId="product_costs">
      <Breakdown productId={productId} />
    </ModuleGate>
  )
}
