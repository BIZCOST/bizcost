'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { SaleDto, SaleLineDto, SaleResultDto } from '@bizcost/contracts'
import {
  compareDecimal,
  newId,
  subtractDecimals,
  sumDecimals,
  type TerminologyProfile,
} from '@bizcost/domain'
import { formatList, type I18nKey } from '@bizcost/i18n'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftIcon,
  CalendarCheckIcon,
  CheckCheckIcon,
  CopyIcon,
  Trash2Icon,
  TruckIcon,
  Undo2Icon,
} from 'lucide-react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { useUnsavedChanges } from '@/components/form/unsaved-changes'
import { isolate } from '@/components/form/use-message'
import { PageContainer } from '@/components/shell/page-container'
import { Button } from '@/components/ui/button'
import { readAmount } from '@/features/catalog/numbers'
import { useUnitQuantity } from '@/features/catalog/unit-parts'
import { NBSP } from '@/features/catalog/units'
import { Locked, Money, useBusinessDate, useMoney } from '@/features/documents/amounts'
import { closedFor, nextDay } from '@/features/documents/books'
import { ConfirmDialog } from '@/features/documents/confirm-dialog'
import { MoneyInput } from '@/features/documents/line-editor'
import { Panel } from '@/features/documents/panel'
import { StatusBadge } from '@/features/documents/status-badge'
import { Totals } from '@/features/documents/totals'
import { can } from '@/features/settings/sections'
import { useLocale, useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { useCountedAmount, useRefreshSales } from './data'
import { sheetHref } from './sheet-params'

// A sale as it was recorded (M3 Step 2; D-227, D-230, D-231): a finalized or reversed one, or a draft
// the member does not edit here (another member's, or their own sheet, which opens in Today's sales).
// Its details, what was sold with, for members who see costs, what each line cost and what it earned
// before running costs and fees (a lock otherwise: a hidden value is absent, never 0), its delivery
// (charged and what it actually cost, entered once when missing), and its totals. A finalized sale
// can be reversed ("as if it was never finalized") or corrected (reversed, and a copy opened as a new
// draft); each asks first, saying in plain words what changes.

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium break-words">{children}</dd>
    </div>
  )
}

/** The sale's title: "Sale of 8 Oct 2026", "Sales of 8 Oct 2026", "Sales of 1–30 Sep 2026". */
export function useSaleTitle() {
  const { t } = useTranslation()
  const businessDate = useBusinessDate()
  return (sale: Pick<SaleDto, 'source' | 'businessDate' | 'periodFrom'>) =>
    sale.source === 'single'
      ? t('sales.view.title', { date: businessDate(sale.businessDate) })
      : sale.periodFrom
        ? t('sales.view.sheetPeriodTitle', {
            from: businessDate(sale.periodFrom),
            to: businessDate(sale.businessDate),
          })
        : t('sales.view.sheetTitle', { date: businessDate(sale.businessDate) })
}

/** A product sold without what it uses while Materials is on: its cost is not known (D-223). */
function missesRecipe(line: SaleLineDto): boolean {
  return line.costBasis === 'none' && line.noRecipe === true
}

/** The line's cost of what was sold is known: priced, or nothing to cost (never a missing recipe). */
function costKnownOf(line: SaleLineDto): boolean {
  if (line.cost !== null && line.cost !== undefined) return true
  return line.costBasis === 'none' && !missesRecipe(line)
}

/** The owner's minutes on the line (none, or hidden: no time to count). */
function minutesOf(line: SaleLineDto): string | null {
  const minutes = line.timeMinutes ?? null
  return minutes !== null && compareDecimal(minutes, '0') > 0 ? minutes : null
}

/**
 * What a finalized line cost and earned, for a member who sees costs (a lock otherwise): its
 * materials (or "no price yet" for those never bought; "no recipe yet" for a product sold without
 * what it uses while Materials is on, whose profit is then incomplete, D-223), the owner's time
 * without a team, and what it earned before running costs and fees.
 */
function LineCost({
  line,
  currency,
  profile,
}: {
  line: SaleLineDto
  currency: string
  profile: TerminologyProfile | null | undefined
}) {
  const { t } = useTranslation()
  const term = useTerminology()
  const { locale } = useLocale()
  const money = useMoney()
  if (line.cost === undefined) {
    return (
      <p className="mt-1 text-sm">
        {t('sales.view.cost')} <Locked category="cost" />
      </p>
    )
  }
  const unpriced = (line.materials ?? []).filter((material) => material.cost === null)
  const hasTime = minutesOf(line) !== null
  const timeKnown = !hasTime || (line.timeCost !== null && line.timeCost !== undefined)
  const missingRecipe = missesRecipe(line)
  const costKnown = costKnownOf(line)
  const profit =
    costKnown && timeKnown
      ? subtractDecimals(
          line.net,
          ...(line.cost !== null ? [line.cost] : []),
          ...(hasTime && line.timeCost ? [line.timeCost] : []),
        )
      : null
  return (
    <div data-line-cost className="mt-1.5 space-y-0.5 text-sm">
      <p>
        {t('sales.view.cost')}{' '}
        {missingRecipe ? (
          <span className="text-warning">{term('catalog.products.cost.noRecipe', profile)}</span>
        ) : line.costBasis === 'none' ? (
          <span className="text-muted-foreground">{t('sales.view.noMaterials')}</span>
        ) : line.cost === null ? (
          <span className="text-warning">{t('sales.view.noPriceYet')}</span>
        ) : (
          <bdi className="font-medium tabular-nums">{money(line.cost, currency)}</bdi>
        )}
      </p>
      {unpriced.length > 0 ? (
        <p className="text-muted-foreground">
          {t('sales.view.unpriced', {
            names: formatList(
              locale,
              unpriced.map((material) => isolate(material.materialName)),
            ),
          })}
        </p>
      ) : null}
      {missingRecipe ? (
        <p data-no-recipe className="text-muted-foreground">
          {term('sales.view.noRecipeHint', profile)}
        </p>
      ) : null}
      {hasTime ? (
        <p className="text-muted-foreground">
          {line.timeCost
            ? t('sales.view.time', { amount: money(line.timeCost, currency) })
            : t('sales.view.timeNoRate')}
        </p>
      ) : null}
      {profit !== null ? (
        <p data-line-profit>
          {t('sales.view.profit')}{' '}
          <bdi
            className={cn(
              'font-medium tabular-nums',
              compareDecimal(profit, '0') < 0 ? 'text-loss' : 'text-profit',
            )}
          >
            {money(profit, currency)}
          </bdi>
        </p>
      ) : null}
    </div>
  )
}

/**
 * What a finalized sale's delivery actually cost, entered once while it is missing (D-230: the costs
 * switch and "enter sales"; also in a closed month, since it only completes a missing cost).
 */
function FillDeliveryCost({
  saleId,
  onDone,
  onClose,
}: {
  saleId: string
  onDone: () => Promise<void>
  onClose: () => void
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const fill = useMutation(trpc.sale.fillDeliveryCost.mutationOptions())
  const [value, setValue] = useState('')
  const [tried, setTried] = useState(false)
  const [error, setError] = useState<I18nKey | null>(null)
  const read = readAmount(value)
  const fieldError: I18nKey | null = tried && !read.ok ? read.error.key : null

  async function save(): Promise<boolean> {
    setTried(true)
    setError(null)
    if (!read.ok) return false
    try {
      const filled = await fill.mutateAsync({ id: saleId, deliveryCost: read.value })
      queryClient.setQueryData(trpc.sale.get.queryKey({ id: saleId }), filled)
      setValue('')
      toast.success(t('sales.confirm.filled'))
      await onDone()
      return true
    } catch (failure) {
      setError(apiErrorKey(failure))
      return false
    }
  }

  // A cost typed and not saved is asked about before the dialog closes or the page is left (D-161).
  const guard = useUnsavedChanges({ dirty: value.trim() !== '', save, close: onClose })
  return (
    <ConfirmDialog
      open
      icon={TruckIcon}
      title={t('sales.confirm.fillTitle')}
      body={t('sales.confirm.fillBody')}
      note={t('sales.confirm.fillNote')}
      action={t('sales.confirm.fillAction')}
      busyLabel={t('status.saving')}
      busy={fill.isPending}
      error={error ?? fieldError}
      onConfirm={() => void save()}
      onClose={() => guard.requestLeave(onClose)}
    >
      <label className="block space-y-1.5 text-sm font-medium">
        <span>{t('sales.editor.deliveryCost')}</span>
        <MoneyInput
          label={t('sales.editor.deliveryCost')}
          value={value}
          invalid={fieldError !== null}
          onChange={setValue}
        />
      </label>
    </ConfirmDialog>
  )
}

export function SaleView({
  result,
  today,
  closedThrough,
}: {
  result: SaleResultDto
  today: string
  closedThrough: string | null
}) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const unitQuantity = useUnitQuantity()
  const saleTitle = useSaleTitle()
  const counted = useCountedAmount()
  const refreshSales = useRefreshSales()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const sale = result.data
  const reverse = useMutation(trpc.sale.reverse.mutationOptions())
  const correct = useMutation(trpc.sale.correct.mutationOptions())
  const post = useMutation(trpc.sale.post.mutationOptions())
  const discard = useMutation(trpc.sale.discard.mutationOptions())
  const [confirm, setConfirm] = useState<
    'reverse' | 'correct' | 'finalize' | 'discard' | 'fill' | null
  >(null)
  const [confirmError, setConfirmError] = useState<I18nKey | null>(null)
  const [busy, setBusy] = useState(false)
  const [correctionId] = useState(() => newId())
  if (!context) return null

  const vatRegistered = sale.vatRegistered
  const canManage = can(context, 'sales.documents.manage')
  const canPost = can(context, 'sales.documents.post')
  const canReverse = can(context, 'sales.documents.reverse')
  const seesCosts = context.visibleCategories.includes('cost')
  const listHref = `/b/${businessId}/sales`
  const posted = sale.status === 'posted'
  const items = sale.lines.filter((line) => line.kind === 'item')
  const delivery = sale.lines.find((line) => line.kind === 'delivery')
  const names = formatList(
    locale,
    [...new Set(items.map((line) => line.description ?? ''))]
      .filter(Boolean)
      .slice(0, 3)
      .map((name) => isolate(name)),
  )
  // The reversal's day (D-227): the sale's own, or the first day after the closed books; a day after
  // today can't be (books closed up to today), so it waits for tomorrow or open books.
  const firstOpenDay =
    closedThrough && sale.businessDate <= closedThrough ? nextDay(closedThrough) : null
  const reverseBlocked = firstOpenDay !== null && firstOpenDay > today
  const reversalDay = reverseBlocked ? null : firstOpenDay
  const finalizeClosed =
    sale.status === 'draft' ? closedFor(sale.businessDate, today, closedThrough) : null
  // The delivery cost: one's own sale shows what was typed (D-181); otherwise it needs the costs
  // switch (undefined: hidden).
  const shownDeliveryCost = sale.mine ? sale.ownDeliveryCost : sale.deliveryCost
  const canFill =
    sale.status !== 'draft' &&
    sale.deliveryNeeded &&
    canManage &&
    seesCosts &&
    sale.deliveryCost === null
  // What the delivery earned or cost the business, before VAT (D-223): a free one charged nothing.
  const deliveryMargin =
    sale.deliveryNeeded && typeof shownDeliveryCost === 'string'
      ? subtractDecimals(delivery?.net ?? '0', shownDeliveryCost)
      : null
  // What the sale's items cost and earned, once every line's cost is known (costs switch only): the
  // cost of what was sold (materials), and apart from it the owner's time without a team (D-223).
  const costsShown = sale.status !== 'draft' && items.every((line) => line.cost !== undefined)
  const materialCosts = items.flatMap((line) => (line.cost ? [line.cost] : []))
  const timeCosts = items.flatMap((line) =>
    minutesOf(line) !== null && line.timeCost ? [line.timeCost] : [],
  )
  const materialsComplete = costsShown && items.every(costKnownOf)
  const timeShown = costsShown && items.some((line) => minutesOf(line) !== null)
  const timesComplete =
    costsShown &&
    items.every((line) => minutesOf(line) === null || (line.timeCost ?? null) !== null)
  const costsComplete = materialsComplete && timesComplete
  const itemsNet = sumDecimals(items.map((line) => line.net))
  // Nothing to cost on any line (Materials off, services, nothing it uses): said, not 0.00.
  const nothingToCost =
    materialsComplete &&
    materialCosts.length === 0 &&
    items.every((line) => line.costBasis === 'none')
  const costTotal = costsShown ? sumDecimals(materialCosts) : null
  const timeTotal = timeCosts.length > 0 ? sumDecimals(timeCosts) : null
  const profitTotal = costsComplete
    ? subtractDecimals(itemsNet, ...materialCosts, ...timeCosts)
    : null
  function errorKey(error: unknown): I18nKey {
    const code = apiErrorCode(error)
    if (code === 'conflict') return 'sales.editor.conflict'
    if (code === 'books_closed' && confirm !== 'finalize') return 'sales.confirm.reverseClosed'
    return apiErrorKey(error)
  }

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.sale.get.queryKey({ id: sale.id }) }),
      refreshSales(),
    ])
  }

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setConfirmError(null)
    try {
      await action()
      setConfirm(null)
    } catch (error) {
      setConfirmError(errorKey(error))
    } finally {
      setBusy(false)
    }
  }

  const doReverse = () =>
    run(async () => {
      const reversed = await reverse.mutateAsync({ id: sale.id })
      queryClient.setQueryData(trpc.sale.get.queryKey({ id: sale.id }), reversed)
      await refresh()
      toast.success(t('sales.confirm.reversed'))
    })

  const doCorrect = () =>
    run(async () => {
      const copy = await correct.mutateAsync({ id: sale.id, newId: correctionId })
      queryClient.setQueryData(trpc.sale.get.queryKey({ id: copy.data.id }), copy)
      await refresh()
      toast.success(t('sales.confirm.corrected'))
      // A sheet's copy is the corrector's sheet of those days: it opens in Today's sales.
      router.push(
        copy.data.source === 'day_sheet'
          ? sheetHref(
              businessId,
              {
                businessDate: copy.data.businessDate,
                periodFrom: copy.data.periodFrom,
                channelId: copy.data.channelId,
                locationId: copy.data.locationId,
              },
              today,
            )
          : `${listHref}/${copy.data.id}`,
      )
    })

  const doFinalize = () =>
    run(async () => {
      const done = await post.mutateAsync({ id: sale.id, version: sale.version })
      queryClient.setQueryData(trpc.sale.get.queryKey({ id: sale.id }), done)
      await refresh()
      toast.success(
        t('sales.confirm.finalized', {
          amount: counted(done.data),
          date: businessDate(done.data.businessDate),
        }),
      )
    })

  const doDiscard = () =>
    run(async () => {
      await discard.mutateAsync({ id: sale.id, version: sale.version })
      await refreshSales()
      toast.success(t('sales.confirm.discarded'))
      router.replace(listHref)
    })

  const open = (next: NonNullable<typeof confirm>) => {
    setConfirmError(null)
    setConfirm(next)
  }

  return (
    <PageContainer>
      <Link
        href={listHref}
        className="-ms-2 -mt-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
        {t('common.nav.sales')}
      </Link>
      <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{saleTitle(sale)}</h1>
            <StatusBadge status={sale.status} kind="sale" />
          </div>
          <p className="mt-1.5 text-muted-foreground">
            <bdi>{sale.channelName}</bdi>
            {context.capabilities.multi_location ? (
              <>
                {' · '}
                <bdi>{sale.locationName}</bdi>
              </>
            ) : null}
            {sale.enteredByName ? (
              <>
                {' · '}
                {t('sales.view.enteredBy', { name: isolate(sale.enteredByName) })}
              </>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {posted && canReverse && canManage ? (
            <Button variant="outline" onClick={() => open('correct')}>
              <CopyIcon aria-hidden />
              {t('sales.view.correct')}
            </Button>
          ) : null}
          {posted && canReverse ? (
            <Button variant="destructive" onClick={() => open('reverse')}>
              <Undo2Icon aria-hidden />
              {t('sales.view.reverse')}
            </Button>
          ) : null}
          {sale.status === 'draft' && sale.source === 'day_sheet' && sale.mine && canManage ? (
            <Button asChild>
              <Link
                href={sheetHref(
                  businessId,
                  {
                    businessDate: sale.businessDate,
                    periodFrom: sale.periodFrom,
                    channelId: sale.channelId,
                    locationId: sale.locationId,
                  },
                  today,
                )}
              >
                <CalendarCheckIcon aria-hidden />
                {t('sales.view.openSheet')}
              </Link>
            </Button>
          ) : null}
          {sale.status === 'draft' && canManage ? (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => open('discard')}
            >
              <Trash2Icon aria-hidden />
              {t('sales.editor.discard')}
            </Button>
          ) : null}
          {sale.status === 'draft' && canPost && !(sale.source === 'day_sheet' && sale.mine) ? (
            <Button onClick={() => open('finalize')}>
              <CheckCheckIcon aria-hidden />
              {t('sales.editor.finalize')}
            </Button>
          ) : null}
        </div>
      </header>

      <div className="space-y-5">
        {sale.status === 'reversed' ? (
          <FormAlert tone="info">
            {t('sales.view.reversedNote', {
              date: businessDate(sale.reversalBusinessDate ?? sale.businessDate),
            })}
          </FormAlert>
        ) : sale.status === 'draft' ? (
          <FormAlert tone="info">{t('sales.view.draftNote')}</FormAlert>
        ) : null}
        {sale.copiedFromId ? (
          <FormAlert tone="info">
            {t('sales.editor.copiedFrom')}{' '}
            <Link
              href={`${listHref}/${sale.copiedFromId}`}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {t('sales.editor.openOriginal')}
            </Link>
          </FormAlert>
        ) : null}
        {result.meta.redacted.length > 0 && sale.status !== 'draft' ? (
          <p className="text-sm text-muted-foreground">{t('sales.view.costsHidden')}</p>
        ) : null}

        <Panel title={t('sales.editor.details')}>
          <dl className="grid grid-cols-2 gap-4 lg:grid-cols-3">
            <Detail label={sale.periodFrom ? t('sales.view.days') : t('sales.editor.date')}>
              {sale.periodFrom
                ? t('sales.sheet.covers', {
                    from: businessDate(sale.periodFrom),
                    to: businessDate(sale.businessDate),
                  })
                : businessDate(sale.businessDate)}
            </Detail>
            <Detail label={t('sales.editor.channel')}>
              <bdi>{sale.channelName}</bdi>
            </Detail>
            {context.capabilities.multi_location ? (
              <Detail label={t('sales.editor.location')}>
                <bdi>{sale.locationName}</bdi>
              </Detail>
            ) : null}
            {sale.enteredByName ? (
              <Detail label={t('sales.view.enteredByLabel')}>
                <bdi>{sale.enteredByName}</bdi>
              </Detail>
            ) : null}
            <Detail label={t('sales.view.kind')}>
              {t(sale.source === 'day_sheet' ? 'sales.view.kindSheet' : 'sales.view.kindSingle')}
            </Detail>
          </dl>
          {sale.periodFrom ? (
            <p className="mt-4 text-sm text-muted-foreground">
              {t('sales.view.periodNote', { date: businessDate(sale.businessDate) })}
            </p>
          ) : null}
          {sale.notes ? (
            <p dir="auto" className="mt-4 text-sm whitespace-pre-line">
              {sale.notes}
            </p>
          ) : null}
        </Panel>

        <Panel title={t('sales.view.sold')}>
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('sales.view.nothingSold')}</p>
          ) : (
            <ul aria-label={t('sales.view.sold')} className="divide-y">
              {items.map((line) => (
                <li key={line.id} data-sale-line className="py-3 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-start font-medium break-words">
                        <bdi>{line.description}</bdi>
                      </p>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        <bdi>
                          {(line.unit ? unitQuantity(line.qty, line.unit) : line.qty).replaceAll(
                            ' ',
                            NBSP,
                          )}
                        </bdi>
                        {' × '}
                        <bdi className="tabular-nums">{money(line.unitPrice, sale.currency)}</bdi>
                        {vatRegistered && line.priceIncludesVat ? (
                          <> {t('sales.view.inclVat').replaceAll(' ', NBSP)}</>
                        ) : null}
                        {line.discount ? (
                          <>
                            {' · '}
                            {'percent' in line.discount
                              ? t('purchasing.view.discountPercent', {
                                  percent: line.discount.percent,
                                })
                              : t('purchasing.view.discountAmount', {
                                  amount: money(line.discount.amount, sale.currency),
                                })}
                          </>
                        ) : null}
                        {vatRegistered && line.vatRate !== null ? (
                          <>
                            {' · '}
                            {t(
                              line.vatCategory === 'zero_rated'
                                ? 'sales.view.vatZero'
                                : line.vatCategory === 'exempt'
                                  ? 'sales.view.vatExempt'
                                  : 'sales.view.vatRate',
                              { rate: line.vatRate },
                            ).replaceAll(' ', NBSP)}
                          </>
                        ) : null}
                      </p>
                      {sale.status !== 'draft' ? (
                        <LineCost
                          line={line}
                          currency={sale.currency}
                          profile={context.terminologyProfile}
                        />
                      ) : null}
                    </div>
                    <p className="shrink-0 pt-0.5 text-end font-medium">
                      <Money value={line.net} currency={sale.currency} />
                      {vatRegistered ? (
                        <span className="block text-xs font-normal text-muted-foreground">
                          {t('sales.list.beforeVat')}
                        </span>
                      ) : null}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {sale.deliveryNeeded ? (
          <Panel title={t('sales.editor.delivery')}>
            <dl className="grid grid-cols-2 gap-4 lg:grid-cols-3">
              {sale.deliveryArea ? (
                <Detail label={t('sales.editor.deliveryArea')}>
                  <bdi>{sale.deliveryArea}</bdi>
                </Detail>
              ) : null}
              <Detail label={t('sales.view.deliveryCharged')}>
                {delivery ? (
                  <>
                    <bdi className="tabular-nums">{money(delivery.net, sale.currency)}</bdi>
                    {vatRegistered ? (
                      <span className="block text-xs font-normal text-muted-foreground">
                        {t('sales.list.beforeVat')}
                      </span>
                    ) : null}
                  </>
                ) : (
                  t('sales.view.deliveryFree')
                )}
              </Detail>
              <Detail label={t('sales.editor.deliveryCost')}>
                {shownDeliveryCost === undefined ? (
                  <Locked category="cost" />
                ) : shownDeliveryCost === null ? (
                  <span className="font-normal text-muted-foreground">
                    {t('sales.view.deliveryCostMissing')}
                  </span>
                ) : (
                  <bdi data-delivery-cost className="tabular-nums">
                    {money(shownDeliveryCost, sale.currency)}
                  </bdi>
                )}
              </Detail>
            </dl>
            {deliveryMargin !== null && sale.status !== 'draft' ? (
              <p data-delivery-margin className="mt-4 text-sm">
                {compareDecimal(deliveryMargin, '0') < 0
                  ? t('sales.view.deliveryPaid', {
                      amount: money(subtractDecimals('0', deliveryMargin), sale.currency),
                    })
                  : t('sales.view.deliveryEarned', {
                      amount: money(deliveryMargin, sale.currency),
                    })}
              </p>
            ) : null}
            {canFill ? (
              <Button variant="outline" className="mt-4" onClick={() => open('fill')}>
                <TruckIcon aria-hidden />
                {t('sales.view.fillDeliveryCost')}
              </Button>
            ) : null}
          </Panel>
        ) : null}

        <Panel title={t('purchasing.totals.title')}>
          <Totals
            subtotal={sale.subtotal}
            discount={sale.discountTotal}
            net={sale.netTotal}
            vat={sale.vatTotal}
            total={sale.total}
            vatRegistered={vatRegistered}
            money={(amount) => money(amount, sale.currency)}
          />
          {sale.status !== 'draft' && items.length > 0 ? (
            <div className="mt-3 space-y-1 border-t pt-3 text-sm">
              <p data-cost-total>
                {t('sales.view.costTotal')}{' '}
                {!costsShown ? (
                  <Locked category="cost" />
                ) : nothingToCost ? (
                  <span className="text-muted-foreground">{t('sales.view.noMaterials')}</span>
                ) : materialsComplete ? (
                  <bdi className="font-medium tabular-nums">
                    {money(costTotal ?? '0', sale.currency)}
                  </bdi>
                ) : (
                  <span className="text-muted-foreground">{t('sales.view.costIncomplete')}</span>
                )}
              </p>
              {timeShown ? (
                <p data-time-total>
                  {t('sales.view.timeTotal')}{' '}
                  {timesComplete && timeTotal !== null ? (
                    <bdi className="font-medium tabular-nums">
                      {money(timeTotal, sale.currency)}
                    </bdi>
                  ) : (
                    <span className="text-muted-foreground">{t('sales.view.timeTotalNoRate')}</span>
                  )}
                </p>
              ) : null}
              {profitTotal !== null ? (
                <p data-profit-total>
                  {t('sales.view.profit')}{' '}
                  <bdi
                    className={cn(
                      'font-medium tabular-nums',
                      compareDecimal(profitTotal, '0') < 0 ? 'text-loss' : 'text-profit',
                    )}
                  >
                    {money(profitTotal, sale.currency)}
                  </bdi>
                </p>
              ) : null}
              {costsShown ? (
                <p className="text-muted-foreground">{t('sales.view.profitNote')}</p>
              ) : null}
            </div>
          ) : null}
        </Panel>
      </div>

      <ConfirmDialog
        open={confirm === 'reverse'}
        icon={Undo2Icon}
        title={t('sales.confirm.reverseTitle')}
        body={t('sales.confirm.reverseBody', { date: businessDate(sale.businessDate) })}
        note={
          <>
            {t('sales.confirm.reverseNote')}
            {reversalDay ? (
              <> {t('sales.confirm.reverseDated', { date: businessDate(reversalDay) })}</>
            ) : null}
          </>
        }
        action={t('sales.view.reverse')}
        busyLabel={t('sales.confirm.reversing')}
        busy={busy}
        error={confirmError ?? (reverseBlocked ? 'sales.confirm.reverseClosed' : null)}
        disabled={reverseBlocked}
        destructive
        onConfirm={() => void doReverse()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'correct'}
        icon={CopyIcon}
        title={t('sales.confirm.correctTitle')}
        body={
          sale.source === 'day_sheet'
            ? t('sales.confirm.correctSheetBody')
            : t('sales.confirm.correctBody', { names })
        }
        note={
          <>
            {t('sales.confirm.correctNote')}
            {reversalDay ? (
              <> {t('sales.confirm.reverseDated', { date: businessDate(reversalDay) })}</>
            ) : null}
          </>
        }
        action={t('sales.confirm.correctAction')}
        busyLabel={t('sales.confirm.correcting')}
        busy={busy}
        error={confirmError ?? (reverseBlocked ? 'sales.confirm.reverseClosed' : null)}
        disabled={reverseBlocked}
        onConfirm={() => void doCorrect()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'finalize'}
        icon={CheckCheckIcon}
        title={t('sales.confirm.finalizeTitle')}
        body={t('sales.confirm.finalizeBody', {
          date: businessDate(sale.businessDate),
          amount: counted(sale),
        })}
        note={t('sales.confirm.finalizeNote')}
        action={t('sales.editor.finalize')}
        busyLabel={t('sales.confirm.finalizing')}
        busy={busy}
        error={
          confirmError ??
          (finalizeClosed === 'today'
            ? 'sales.confirm.finalizeClosedToday'
            : finalizeClosed === 'earlier'
              ? 'errors.books_closed'
              : null)
        }
        disabled={finalizeClosed !== null}
        onConfirm={() => void doFinalize()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'discard'}
        icon={Trash2Icon}
        title={t('sales.confirm.discardTitle')}
        body={t('sales.confirm.discardBody')}
        action={t('sales.confirm.discardAction')}
        busyLabel={t('status.deleting')}
        busy={busy}
        error={confirmError}
        destructive
        onConfirm={() => void doDiscard()}
        onClose={() => setConfirm(null)}
      />
      {confirm === 'fill' ? (
        <FillDeliveryCost
          saleId={sale.id}
          onDone={async () => {
            await refresh()
            setConfirm(null)
          }}
          onClose={() => setConfirm(null)}
        />
      ) : null}
    </PageContainer>
  )
}
