'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type {
  DaySheetDto,
  DaySheetInput,
  SaleDto,
  SaleResultDto,
  SalesChannelDto,
} from '@bizcost/contracts'
import { nameKey, newId, type CurrencyCode } from '@bizcost/domain'
import { formatList, type I18nKey } from '@bizcost/i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftIcon,
  CheckCheckIcon,
  LockKeyholeIcon,
  MinusIcon,
  PlusIcon,
  SearchIcon,
  TagIcon,
} from 'lucide-react'
import Link from 'next/link'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { sameData } from '@/components/form/unsaved'
import { useConfirmLeave, useUnsavedChanges } from '@/components/form/unsaved-changes'
import { isolate } from '@/components/form/use-message'
import { ModuleGate } from '@/components/shell/module-gate'
import { PageContainer } from '@/components/shell/page-container'
import { LoadError, SectionSkeleton } from '@/components/states/query-state'
import { StatePanel } from '@/components/states/state-panel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { withLatinDigits, type FieldError } from '@/features/catalog/numbers'
import { useBusinessDate, useMoney } from '@/features/documents/amounts'
import { closedFor } from '@/features/documents/books'
import { ConfirmDialog } from '@/features/documents/confirm-dialog'
import { LineMessages, MoneyInput } from '@/features/documents/line-editor'
import { Panel } from '@/features/documents/panel'
import { StatusBadge } from '@/features/documents/status-badge'
import { Totals } from '@/features/documents/totals'
import { can } from '@/features/settings/sections'
import { useLocale } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import {
  defaultChannelId,
  mayEnterSales,
  useBooks,
  useChannels,
  useCountedAmount,
  useRefreshSales,
} from './data'
import {
  checkSheet,
  sheetDraft,
  sheetItems,
  stepQty,
  type SheetDraft,
  type SheetItem,
} from './day-sheet-draft'
import {
  daysFor,
  isPeriod,
  previousDay,
  readSheetParams,
  sheetDays,
  writeSheetParams,
  type SheetDays,
  type SheetParams,
} from './sheet-params'

// Today's sales («مبيعات اليوم», M3 Step 2; Q9, Q10, D-231), phone first: the member's own sheet for a
// day, a channel and a branch. "These sales are for: today / another day / several days (within one
// month)", never after today; the channel only with two or more, the branch only with branches. Each
// product of the branch with − / + and the price filled in (changed for the day on its row), and the
// running total. Save keeps it as a draft; «اعتمد نهائيًا» finalizes it (with sales.documents.post),
// after a confirmation that says what it counts. The books-closed date is said before Finalize.
// Leaving with changes asks first (D-161), changing the day, channel or branch too.

/** Products a sheet lists before it offers to find one by name. */
const FIND_FROM = 10

/** One product's row: its name, its price for the day, how many (− / +) and what that makes. */
function ProductRow({
  item,
  qty,
  price,
  amount,
  errors,
  shown,
  onChange,
}: {
  item: SheetItem
  qty: string
  price: string
  /** What the row comes to (as its prices are typed), once it reads. */
  amount: string | undefined
  errors: { qty?: FieldError; price?: FieldError } | undefined
  shown: (error: FieldError | undefined) => string | undefined
  onChange: (next: { qty?: string; price?: string }) => void
}) {
  const { t } = useTranslation()
  const money = useMoney()
  const messagesId = useId()
  const messages = [shown(errors?.qty), shown(errors?.price)].filter((m): m is string => Boolean(m))
  const describedBy = messages.length > 0 ? messagesId : undefined
  const name = isolate(item.name)
  return (
    <li
      data-sheet-row={item.productId}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0 md:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_auto_minmax(0,1fr)]"
    >
      {/* On a phone the name has the row's whole width, its amount at the end; from md, four columns. */}
      <div className="col-span-full flex items-start justify-between gap-3 md:contents">
        <div className="min-w-0 md:col-start-1 md:row-start-1">
          <p className="text-start font-medium break-words">
            <bdi>{item.name}</bdi>
          </p>
          {item.gone ? (
            <p className="text-xs text-muted-foreground">{t('sales.sheet.gone')}</p>
          ) : null}
        </div>
        <p
          data-row-amount
          className="shrink-0 text-end text-sm font-medium tabular-nums md:col-start-4 md:row-start-1"
        >
          {amount ? <bdi>{money(amount)}</bdi> : <span className="text-muted-foreground">—</span>}
        </p>
      </div>
      <MoneyInput
        label={t('sales.sheet.priceFor', { name })}
        value={price}
        invalid={Boolean(shown(errors?.price))}
        describedBy={describedBy}
        onChange={(value) => onChange({ price: value })}
        className="max-w-40 md:col-start-2 md:row-start-1 md:max-w-none"
      />
      <div className="flex items-center gap-1 justify-self-end md:col-start-3 md:row-start-1">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t('sales.sheet.less', { name })}
          onClick={() => onChange({ qty: stepQty(qty, -1) })}
          className="size-11 shrink-0 rounded-full"
        >
          <MinusIcon aria-hidden />
        </Button>
        <Input
          aria-label={t('sales.sheet.qtyFor', { name })}
          aria-invalid={Boolean(shown(errors?.qty))}
          aria-describedby={describedBy}
          inputMode="decimal"
          dir="ltr"
          autoComplete="off"
          spellCheck={false}
          placeholder="0"
          value={qty}
          onChange={(event) => onChange({ qty: event.target.value })}
          onBlur={() => onChange({ qty: withLatinDigits(qty) })}
          className="w-16 text-center tabular-nums"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t('sales.sheet.more', { name })}
          onClick={() => onChange({ qty: stepQty(qty, 1) })}
          className="size-11 shrink-0 rounded-full"
        >
          <PlusIcon aria-hidden />
        </Button>
      </div>
      <LineMessages id={messagesId} messages={messages} className="col-span-full mt-0" />
    </li>
  )
}

/**
 * A finalized sheet: what it came to, and the way to it. It changes only by a correction, so more
 * sales of the day go in as One sale; the correction is said only to members who may make one.
 */
function FinalSheet({ sale }: { sale: SaleDto }) {
  const { t } = useTranslation()
  const money = useMoney()
  const counted = useCountedAmount()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const corrects =
    context !== undefined &&
    can(context, 'sales.documents.reverse') &&
    can(context, 'sales.documents.manage')
  return (
    <Panel title={t('sales.sheet.finalTitle')}>
      <FormAlert tone="success">{t('sales.sheet.final', { amount: counted(sale) })}</FormAlert>
      <ul className="mt-4 divide-y" aria-label={t('sales.sheet.finalTitle')}>
        {sale.lines.map((line) => (
          <li key={line.id} className="flex items-baseline justify-between gap-3 py-2.5 text-sm">
            <span className="min-w-0 text-start break-words">
              <bdi>{line.description}</bdi>
            </span>
            <span className="shrink-0 text-muted-foreground tabular-nums">
              <bdi>
                {line.qty} × {money(line.unitPrice, sale.currency)}
              </bdi>
            </span>
          </li>
        ))}
      </ul>
      <p data-final-hint className="mt-4 text-sm text-muted-foreground">
        {t('sales.sheet.finalMore')}
        {corrects ? <> {t('sales.sheet.finalHint')}</> : null}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button asChild>
          <Link href={`/b/${businessId}/sales/new`}>
            <PlusIcon aria-hidden />
            {t('sales.list.newSale')}
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href={`/b/${businessId}/sales/${sale.id}`}>{t('sales.sheet.finalAction')}</Link>
        </Button>
      </div>
    </Panel>
  )
}

/** The rows, the totals and Save / Finalize of the member's sheet. */
function SheetForm({
  data,
  input,
  onReload,
}: {
  data: DaySheetDto['data']
  /** What the sheet was asked for (its query's key: a null channel or branch stays null). */
  input: DaySheetInput
  /** The sheet changed elsewhere: read it again and start from what is stored. */
  onReload: () => void
}) {
  const { t } = useTranslation()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const refreshSales = useRefreshSales()
  const { data: context } = useBusinessContext()
  const create = useMutation(trpc.sale.create.mutationOptions())
  const update = useMutation(trpc.sale.update.mutationOptions())
  const post = useMutation(trpc.sale.post.mutationOptions())
  const vatRegistered = context?.capabilities.vat_registered === true
  const currency = (data.sheet?.currency ?? context?.currency ?? 'AED') as CurrencyCode
  const canPost = context ? can(context, 'sales.documents.post') : false
  const countedOf = useCountedAmount()

  const [items] = useState(() => sheetItems(data.products, data.sheet))
  const [initial] = useState<SheetDraft>(() => sheetDraft(items, data.products, data.sheet))
  const [draft, setDraft] = useState<SheetDraft>(initial)
  const [baseline, setBaseline] = useState<SheetDraft>(initial)
  const [sheetId] = useState(() => data.sheet?.id ?? newId())
  const [version, setVersion] = useState<number | null>(data.sheet?.version ?? null)
  const [posted, setPosted] = useState<SaleDto | null>(
    data.sheet && data.sheet.status !== 'draft' ? data.sheet : null,
  )
  const [find, setFind] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [notice, setNotice] = useState<I18nKey | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState<I18nKey | null>(null)
  const [busy, setBusy] = useState<'saving' | 'finalizing' | null>(null)
  // Finalize was tapped while the closed books stop it: said above the rows too.
  const [finalizeBlocked, setFinalizeBlocked] = useState(false)
  const list = useRef<HTMLUListElement>(null)

  const check = useMemo(
    () => checkSheet(items, draft, { currency, vatRegistered }),
    [items, draft, currency, vatRegistered],
  )
  const shown = (error: FieldError | undefined): string | undefined =>
    error && (submitted || error.key !== 'catalog.numbers.required')
      ? t(error.key, error.values)
      : undefined
  const closed = closedFor(data.businessDate, data.today, data.closedThrough)
  const dirty = !sameData(draft, baseline)
  const findKey = nameKey(find)
  const shownItems =
    findKey === '' ? items : items.filter((item) => nameKey(item.name).includes(findKey))
  const sheetKey = trpc.sale.daySheet.queryKey(input)

  function setRow(productId: string, next: { qty?: string; price?: string }) {
    setDraft((d) => ({ ...d, [productId]: { ...d[productId]!, ...next } }))
  }

  const focusFirstError = () =>
    setTimeout(() => {
      const field = list.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
      field?.focus({ preventScroll: true })
      field?.scrollIntoView({ block: 'center' })
    })

  function errorKey(error: unknown): I18nKey {
    return apiErrorCode(error) === 'conflict' ? 'sales.sheet.conflict' : apiErrorKey(error)
  }

  /** Saves the sheet as a draft; the saved sale, or null (the form says why). */
  async function saveSheet(): Promise<SaleResultDto | null> {
    setSubmitted(true)
    setNotice(null)
    if (!check.valid) {
      focusFirstError()
      return null
    }
    if (version === null && check.lines.length === 0) {
      setNotice('sales.sheet.nothing')
      return null
    }
    const snapshot = draft
    const fields = {
      businessDate: data.businessDate,
      periodFrom: data.periodFrom,
      locationId: data.locationId,
      channelId: data.channelId,
      notes: data.sheet?.notes ?? null,
      lines: check.lines,
    }
    try {
      const result =
        version === null
          ? await create.mutateAsync({ id: sheetId, source: 'day_sheet', ...fields })
          : await update.mutateAsync({ id: sheetId, version, ...fields })
      setVersion(result.data.version)
      setBaseline(snapshot)
      queryClient.setQueryData(sheetKey, (old: DaySheetDto | undefined) =>
        old ? { ...old, data: { ...old.data, sheet: result.data } } : old,
      )
      void queryClient.invalidateQueries({ queryKey: trpc.sale.list.pathKey() })
      return result
    } catch (error) {
      if (apiErrorCode(error) === 'conflict') {
        toast.error(t('sales.sheet.conflict'))
        onReload()
      } else setNotice(errorKey(error))
      return null
    }
  }

  async function saveHere(): Promise<boolean> {
    if (busy) return false
    setBusy('saving')
    try {
      const saved = await saveSheet()
      if (saved) toast.success(t('sales.sheet.saved'))
      return saved !== null
    } finally {
      setBusy(null)
    }
  }

  useUnsavedChanges({ dirty, save: saveHere })

  function askFinalize() {
    if (busy) return
    setSubmitted(true)
    setNotice(null)
    if (!check.valid) {
      focusFirstError()
      return
    }
    if (check.lines.length === 0) {
      setNotice('sales.sheet.nothing')
      return
    }
    if (closed) {
      setFinalizeBlocked(true)
      return
    }
    setConfirmError(null)
    setConfirming(true)
  }

  async function finalize() {
    setBusy('finalizing')
    setConfirmError(null)
    try {
      const saved = dirty || version === null ? await saveSheet() : null
      const at = saved?.data.version ?? version
      if (at === null) {
        setConfirming(false)
        return
      }
      const result = await post.mutateAsync({ id: sheetId, version: at })
      setPosted(result.data)
      setBaseline(draft)
      queryClient.setQueryData(sheetKey, (old: DaySheetDto | undefined) =>
        old ? { ...old, data: { ...old.data, sheet: result.data } } : old,
      )
      void refreshSales()
      toast.success(
        t('sales.confirm.finalizedSheet', {
          amount: countedOf(result.data),
          date: businessDate(result.data.businessDate),
        }),
      )
      setConfirming(false)
    } catch (error) {
      setConfirmError(errorKey(error))
    } finally {
      setBusy(null)
    }
  }

  if (posted) return <FinalSheet sale={posted} />

  if (items.length === 0) {
    return (
      <Panel title={t('sales.sheet.products')}>
        <p className="text-sm text-muted-foreground">{t('sales.sheet.noProducts')}</p>
      </Panel>
    )
  }

  const total = check.amounts?.total ?? '0'
  const counted = vatRegistered
    ? `${money(check.amounts?.net ?? '0', currency)} ${t('sales.list.beforeVat')}`
    : money(total, currency)
  return (
    <form
      method="post"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        void saveHere()
      }}
      className="space-y-5"
    >
      {notice ? <FormAlert tone="error">{t(notice)}</FormAlert> : null}
      {finalizeBlocked && closed && data.closedThrough ? (
        <FormAlert tone="error">
          {t('sales.sheet.closedFinalize', { date: businessDate(data.closedThrough) })}
        </FormAlert>
      ) : null}
      <Panel title={t('sales.sheet.products')} hint={t('sales.sheet.productsHint')}>
        {items.length > FIND_FROM ? (
          <div role="search" className="relative mb-4">
            <SearchIcon
              aria-hidden
              className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              aria-label={t('sales.sheet.find')}
              placeholder={t('sales.sheet.find')}
              autoComplete="off"
              value={find}
              onChange={(event) => setFind(event.target.value)}
              className="ps-9 [unicode-bidi:plaintext]"
            />
          </div>
        ) : null}
        <ul ref={list} aria-label={t('sales.sheet.products')} className="divide-y">
          {shownItems.map((item) => {
            const row = draft[item.productId]!
            return (
              <ProductRow
                key={item.productId}
                item={item}
                qty={row.qty}
                price={row.price}
                amount={check.lineAmounts.get(item.productId)?.subtotal}
                errors={check.errors[item.productId]}
                shown={shown}
                onChange={(next) => setRow(item.productId, next)}
              />
            )
          })}
        </ul>
        {shownItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('sales.sheet.noMatch')}</p>
        ) : null}
      </Panel>

      <Panel title={t('purchasing.totals.title')}>
        <Totals
          subtotal={check.amounts ? check.amounts.net : '0'}
          discount="0"
          net={check.amounts?.net ?? '0'}
          vat={check.amounts?.vat ?? '0'}
          total={total}
          vatRegistered={vatRegistered}
          money={(amount) => money(amount, currency)}
        />
      </Panel>

      <div className="sticky bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-10 flex items-center gap-3 rounded-2xl bg-card/95 p-3 shadow-lg ring-1 ring-foreground/10 backdrop-blur md:bottom-4">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">{t('purchasing.totals.total')}</p>
          <p data-running-total className="truncate font-semibold tabular-nums">
            {money(total, currency)}
          </p>
        </div>
        <Button type="submit" variant="outline" disabled={busy !== null}>
          {busy === 'saving' ? t('status.saving') : t('sales.sheet.save')}
        </Button>
        {canPost ? (
          <Button type="button" disabled={busy !== null} onClick={askFinalize}>
            <CheckCheckIcon aria-hidden />
            {t('sales.sheet.finalize')}
          </Button>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirming}
        icon={CheckCheckIcon}
        title={t('sales.confirm.finalizeSheetTitle')}
        body={
          data.periodFrom
            ? t('sales.confirm.finalizePeriodBody', {
                date: businessDate(data.businessDate),
                from: businessDate(data.periodFrom),
                to: businessDate(data.businessDate),
                amount: counted,
              })
            : t('sales.confirm.finalizeSheetBody', {
                date: businessDate(data.businessDate),
                amount: counted,
              })
        }
        note={t('sales.confirm.finalizeSheetNote')}
        action={t('sales.sheet.finalize')}
        busyLabel={t('sales.confirm.finalizing')}
        busy={busy === 'finalizing'}
        error={confirmError}
        onConfirm={() => void finalize()}
        onClose={() => setConfirming(false)}
      />
    </form>
  )
}

/**
 * "These sales are for", the channel and the branch: each change opens that sheet (asking first). On a
 * phone it stays folded behind "Change" (the header says what is chosen), so the products start on
 * the first screen at the counter (D-236); from md it is always open.
 */
function SheetChoice({
  id: sectionId,
  open,
  params,
  today,
  channels,
  data,
  onChange,
}: {
  id: string
  /** Unfolded on a phone. */
  open: boolean
  params: SheetParams
  today: string
  channels: readonly SalesChannelDto[]
  data: DaySheetDto['data'] | undefined
  onChange: (next: Partial<SheetParams>) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const days = sheetDays(params, today)
  const locations = data?.locations ?? null
  const choose = (choice: SheetDays) => {
    if (choice === days) return
    onChange(daysFor(choice, today))
  }
  const monthStart = `${params.businessDate.slice(0, 7)}-01`
  return (
    <section
      id={sectionId}
      aria-labelledby={`${id}-for`}
      className={cn(
        'mb-5 space-y-4 rounded-2xl bg-card p-4 shadow-sm ring-1 ring-foreground/[0.06] sm:p-5',
        !open && 'max-md:hidden',
      )}
    >
      <fieldset>
        <legend id={`${id}-for`} className="mb-2 font-semibold">
          {t('sales.sheet.for')}
        </legend>
        <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
          {(['today', 'day', 'days'] as const).map((choice) => (
            <label key={choice} className="relative min-w-0">
              <input
                type="radio"
                name={`${id}-days`}
                value={choice}
                checked={days === choice}
                onChange={() => choose(choice)}
                className="peer sr-only"
              />
              <span
                className={cn(
                  'flex min-h-11 cursor-pointer items-center justify-center rounded-md px-2 py-1.5 text-center text-sm font-medium text-muted-foreground transition-colors',
                  'peer-checked:bg-card peer-checked:text-foreground peer-checked:shadow-sm',
                  'peer-focus-visible:ring-3 peer-focus-visible:ring-ring',
                )}
              >
                {t(`sales.sheet.forChoice.${choice}`)}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {days === 'day' ? (
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t('sales.sheet.day')}
          <Input
            type="date"
            max={today}
            value={params.businessDate}
            onChange={(event) => {
              const value = event.target.value
              if (value && value <= today) onChange({ businessDate: value, periodFrom: null })
            }}
          />
        </label>
      ) : null}
      {days === 'days' ? (
        <div>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
              {t('sales.sheet.from')}
              <Input
                type="date"
                min={monthStart}
                max={previousDay(params.businessDate)}
                value={params.periodFrom ?? ''}
                onChange={(event) => {
                  const value = event.target.value
                  if (value && isPeriod(value, params.businessDate)) onChange({ periodFrom: value })
                }}
                className="min-w-0"
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
              {t('sales.sheet.to')}
              <Input
                type="date"
                max={today}
                value={params.businessDate}
                onChange={(event) => {
                  const value = event.target.value
                  if (!value || value > today) return
                  const from =
                    params.periodFrom && isPeriod(params.periodFrom, value)
                      ? params.periodFrom
                      : `${value.slice(0, 7)}-01`
                  if (isPeriod(from, value)) onChange({ businessDate: value, periodFrom: from })
                }}
                className="min-w-0"
              />
            </label>
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">{t('sales.sheet.daysHint')}</p>
        </div>
      ) : null}
      {channels.length > 1 || (locations && locations.length > 0) ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {channels.length > 1 ? (
            <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
              {t('sales.sheet.channel')}
              <NativeSelect
                value={data?.channelId ?? params.channelId ?? ''}
                onChange={(event) => onChange({ channelId: event.target.value || null })}
              >
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
          ) : null}
          {locations && locations.length > 1 ? (
            <label className="flex min-w-0 flex-col gap-1.5 text-sm font-medium">
              {t('sales.sheet.location')}
              <NativeSelect
                value={data?.locationId ?? params.locationId ?? ''}
                onChange={(event) => onChange({ locationId: event.target.value || null })}
              >
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
          ) : locations && locations.length === 1 ? (
            <p className="text-sm">
              <span className="text-muted-foreground">{t('sales.sheet.location')}: </span>
              <bdi className="font-medium">{locations[0]!.name}</bdi>
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

/** The sheet of the address's days, channel and branch, and the choice of another. */
function SheetLoader({ today, channels }: { today: string; channels: readonly SalesChannelDto[] }) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const trpc = useTRPC()
  const router = useRouter()
  const pathname = usePathname()
  const search = useSearchParams()
  const confirmLeave = useConfirmLeave()
  const businessDate = useBusinessDate()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const [generation, setGeneration] = useState(0)
  const [choiceOpen, setChoiceOpen] = useState(false)
  const choiceId = useId()
  const params = readSheetParams(search, today)
  // Two or more channels: the business's own way of selling until one is chosen; one: its only channel.
  const channelId = params.channelId ?? defaultChannelId(channels)
  // A member limited to some branches starts at one of theirs (the default may not be).
  const scope = context?.locationScope
  const locationId = params.locationId ?? (scope && !scope.all ? (scope.ids[0] ?? null) : null)
  const input = {
    businessDate: params.businessDate,
    periodFrom: params.periodFrom,
    channelId,
    locationId,
  }
  const sheet = useQuery(trpc.sale.daySheet.queryOptions(input))
  const data = sheet.data?.data

  async function change(next: Partial<SheetParams>) {
    if (!(await confirmLeave())) return
    const query = writeSheetParams({ ...params, channelId, locationId, ...next }, today)
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }

  const channelName =
    data?.channelName ?? channels.find((channel) => channel.id === channelId)?.name ?? ''
  const locationName =
    data?.locations && data.locations.length > 1
      ? data.locations.find((location) => location.id === data.locationId)?.name
      : undefined
  const others = data?.sheets ?? []
  const names = others.map((entry) => entry.enteredByName).filter((n): n is string => Boolean(n))
  const sheetsNote =
    data && (others.length > 1 || others.some((entry) => !entry.mine))
      ? names.length === others.length
        ? t('sales.sheet.sheets', {
            count: others.length,
            channel: isolate(data.channelName),
            date: businessDate(data.businessDate),
            names: formatList(
              locale,
              names.map((name) => isolate(name)),
            ),
          })
        : t('sales.sheet.sheetsNoNames', {
            count: others.length,
            channel: isolate(data.channelName),
            date: businessDate(data.businessDate),
          })
      : null
  const closed = data ? closedFor(data.businessDate, data.today, data.closedThrough) : null

  return (
    <PageContainer>
      <Link
        href={`/b/${businessId}/sales`}
        className="-ms-2 -mt-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
        {t('common.nav.sales')}
      </Link>
      <header className="mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {t('sales.sheet.title')}
          </h1>
          {data?.sheet ? <StatusBadge status={data.sheet.status} kind="sale" /> : null}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2">
          <p data-sheet-days className="text-muted-foreground">
            {params.periodFrom
              ? t('sales.sheet.covers', {
                  from: businessDate(params.periodFrom),
                  to: businessDate(params.businessDate),
                })
              : businessDate(params.businessDate)}
            {channels.length > 1 && channelName ? (
              <>
                {' · '}
                <bdi>{channelName}</bdi>
              </>
            ) : null}
            {locationName ? (
              <>
                {' · '}
                <bdi>{locationName}</bdi>
              </>
            ) : null}
          </p>
          <Button
            type="button"
            variant="link"
            aria-expanded={choiceOpen}
            aria-controls={choiceId}
            onClick={() => setChoiceOpen((value) => !value)}
            className="h-11 px-1 md:hidden"
          >
            {t('sales.sheet.change')}
          </Button>
        </div>
      </header>
      <SheetChoice
        id={choiceId}
        open={choiceOpen}
        params={{ ...params, channelId, locationId }}
        today={today}
        channels={channels}
        data={data}
        onChange={(next) => void change(next)}
      />
      {closed && data?.closedThrough ? (
        <FormAlert tone="info" className="mb-4">
          {t('sales.sheet.closed', { date: businessDate(data.closedThrough) })}
        </FormAlert>
      ) : null}
      {sheetsNote ? (
        <FormAlert tone="info" className="mb-4">
          <span data-sheets-note>{sheetsNote}</span>
        </FormAlert>
      ) : null}
      {sheet.isPending ? (
        <SectionSkeleton cards={2} />
      ) : sheet.isError ? (
        apiErrorCode(sheet.error) === 'forbidden' ? (
          <FormAlert tone="error">{t('sales.sheet.notYourBranch')}</FormAlert>
        ) : (
          <LoadError error={sheet.error} onRetry={() => void sheet.refetch()} />
        )
      ) : data ? (
        <SheetForm
          key={`${data.businessDate}|${data.periodFrom}|${data.channelId}|${data.locationId}|${generation}`}
          data={data}
          input={input}
          onReload={() => {
            void sheet.refetch().then(() => setGeneration((g) => g + 1))
          }}
        />
      ) : null}
    </PageContainer>
  )
}

function TodaySales() {
  const { t } = useTranslation()
  const { data: context } = useBusinessContext()
  const { businessId } = useParams<{ businessId: string }>()
  const books = useBooks()
  const { channels, query: channelsQuery } = useChannels()
  if (!context) return null
  if (!mayEnterSales(context)) {
    return (
      <PageContainer>
        <StatePanel
          icon={LockKeyholeIcon}
          title={t('states.forbidden.title')}
          body={t('states.forbidden.body')}
          documentTitle={`${t('states.forbidden.title')} · ${t('appName')}`}
        >
          <Button asChild variant="outline" size="lg">
            <Link href={`/b/${businessId}/sales`}>
              {t('states.goTo', { section: t('common.nav.sales') })}
            </Link>
          </Button>
        </StatePanel>
      </PageContainer>
    )
  }
  const error = books.error ?? channelsQuery.error
  if (error) {
    return (
      <PageContainer>
        <LoadError
          error={error}
          onRetry={() => {
            void books.refetch()
            void channelsQuery.refetch()
          }}
        />
      </PageContainer>
    )
  }
  if (!books.data || !channelsQuery.data) {
    return (
      <PageContainer>
        <SectionSkeleton cards={3} />
      </PageContainer>
    )
  }
  if (channels.length === 0) {
    return (
      <PageContainer>
        <StatePanel
          icon={TagIcon}
          title={t('sales.sheet.noChannel')}
          body={t('sales.sheet.noChannelBody')}
        />
      </PageContainer>
    )
  }
  return <SheetLoader today={books.data.today} channels={channels} />
}

/** Today's sales, inside the module's gate. */
export function TodaySalesPage() {
  return (
    <ModuleGate moduleId="sales" entryId="sales">
      <TodaySales />
    </ModuleGate>
  )
}
