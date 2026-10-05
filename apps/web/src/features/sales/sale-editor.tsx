'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { ProductDto, SaleDto, SaleResultDto } from '@bizcost/contracts'
import { newId, sumDecimals, type CurrencyCode } from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftIcon, CheckCheckIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { TextField } from '@/components/form/text-field'
import { sameData } from '@/components/form/unsaved'
import { useBeforeNavigate, useUnsavedChanges } from '@/components/form/unsaved-changes'
import { PageContainer } from '@/components/shell/page-container'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { FieldError } from '@/features/catalog/numbers'
import { ProductSheet } from '@/features/catalog/product-sheet'
import { useBusinessDate, useMoney } from '@/features/documents/amounts'
import { closedFor, firstOpenDay } from '@/features/documents/books'
import { ConfirmDialog } from '@/features/documents/confirm-dialog'
import { MoneyInput } from '@/features/documents/line-editor'
import { Panel } from '@/features/documents/panel'
import { StatusBadge } from '@/features/documents/status-badge'
import { Totals } from '@/features/documents/totals'
import { hasModule } from '@/features/purchasing/data'
import { can } from '@/features/settings/sections'
import { useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import {
  defaultChannelId,
  useAllProducts,
  useChannels,
  useCountedAmount,
  useRefreshSales,
  useSaleLocations,
} from './data'
import {
  checkSale,
  MISSING_KEYS,
  newItemLine,
  saleDraft,
  type ItemLineDraft,
  type SaleDraft,
  type SaleFields,
} from './sale-draft'
import { ItemLineRow } from './sale-lines'

// One sale («عملية بيع», M3 Step 2; Q9, D-230): a new one or a saved draft, for a job or a single
// customer. The day (never after today), the channel only with two or more, the branch only with
// branches; what was sold, each line a product or service (added on the spot), how many, the price
// and a discount; delivery yes or no, and yes asks for the area, what the customer was charged and
// what it actually cost. The totals follow as it is typed (the domain's sale maths, as the API stores
// them). "Save draft" changes nothing else; «اعتمد نهائيًا» (sales.documents.post) saves it and
// finalizes it after a confirmation that says what it counts. Leaving with changes asks first.

export function SaleEditor({
  sale,
  today,
  closedThrough,
}: {
  /** Absent: a new sale. */
  sale?: SaleDto
  /** Today in the business's time zone (books.get). */
  today: string
  /** The books-closed date: said next to the date before Finalize (D-143). */
  closedThrough: string | null
}) {
  const { t } = useTranslation()
  const term = useTerminology()
  const money = useMoney()
  const countedOf = useCountedAmount()
  const businessDate = useBusinessDate()
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  const beforeNavigate = useBeforeNavigate()
  const refreshSales = useRefreshSales()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const vatRegistered = context?.capabilities.vat_registered === true
  const canPost = context ? can(context, 'sales.documents.post') : false
  const canSeeProducts =
    context !== undefined && hasModule(context, 'products') && can(context, 'products.items.view')
  const canAddProducts = context !== undefined && can(context, 'products.items.manage')
  // A new product can be bought ready to sell while the member may add materials too (D-117).
  const resale =
    context !== undefined &&
    hasModule(context, 'materials') &&
    can(context, 'materials.items.manage')
      ? 'offered'
      : 'none'
  const seesCosts = context?.visibleCategories.includes('cost') === true
  const { channels } = useChannels()
  const { products: loaded, ready: productsReady } = useAllProducts(canSeeProducts)
  const create = useMutation(trpc.sale.create.mutationOptions())
  const update = useMutation(trpc.sale.update.mutationOptions())
  const post = useMutation(trpc.sale.post.mutationOptions())
  const discard = useMutation(trpc.sale.discard.mutationOptions())

  const [saleId] = useState(() => sale?.id ?? newId())
  const [version, setVersion] = useState<number | null>(sale?.version ?? null)
  const [initial] = useState<SaleDraft>(() =>
    saleDraft(sale, {
      today,
      channelId: null,
      locationId:
        context && !context.locationScope.all ? (context.locationScope.ids[0] ?? null) : null,
    }),
  )
  const [draft, setDraft] = useState<SaleDraft>(initial)
  const [baseline, setBaseline] = useState<SaleDraft>(initial)
  // Products and services added from a line, until the list has read them.
  const [added, setAdded] = useState<ProductDto[]>([])
  const [quickAdd, setQuickAdd] = useState<{ lineId: string; name: string } | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<I18nKey | null>(null)
  const [confirm, setConfirm] = useState<'finalize' | 'discard' | null>(null)
  const [confirmError, setConfirmError] = useState<I18nKey | null>(null)
  const [busy, setBusy] = useState<'saving' | 'finalizing' | 'discarding' | null>(null)
  const [finalizeBlocked, setFinalizeBlocked] = useState(false)
  const form = useRef<HTMLFormElement>(null)
  const deliveryId = useId()

  // Two or more channels: one is picked (the business's own way of selling until then); one: its only
  // channel.
  const channelId = draft.channelId ?? defaultChannelId(channels)
  const locations = useSaleLocations(context, today, channelId)
  const products = useMemo(
    () =>
      added.length === 0
        ? loaded
        : new Map<string, ProductDto>([...loaded, ...added.map((p) => [p.id, p] as const)]),
    [loaded, added],
  )
  const currency = (sale?.currency ?? context?.currency ?? 'AED') as CurrencyCode
  // The delivery cost is the member's to type on their own sale, or with the costs switch (D-230).
  const deliveryCostShown = sale === undefined || sale.mine || seesCosts
  const check = useMemo(
    () =>
      checkSale(
        { ...draft, channelId },
        {
          currency,
          vatRegistered,
          today,
          products,
          deliveryCostShown,
          storedDeliveryCost: initial.deliveryCost,
        },
      ),
    [draft, channelId, currency, vatRegistered, today, products, deliveryCostShown, initial],
  )
  const profile = context?.terminologyProfile ?? 'general'
  const shown = (error: FieldError | undefined): string | undefined =>
    error && (submitted || !MISSING_KEYS.has(error.key))
      ? term(error.key, profile, error.values)
      : undefined
  const listHref = `/b/${businessId}/sales`
  const closed = canPost ? closedFor(draft.businessDate, today, closedThrough) : null
  const closedNote =
    closed && closedThrough
      ? t(closed === 'today' ? 'sales.editor.closedToday' : 'sales.editor.closedEarlier', {
          date: businessDate(closedThrough),
        })
      : null
  const pickable = useMemo(() => {
    const named = new Set(draft.lines.map((line) => line.productId))
    return [...products.values()].filter((p) => p.archivedAt === null || named.has(p.id))
  }, [products, draft.lines])

  const set = (patch: Partial<SaleDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const setLine = (next: ItemLineDraft) =>
    setDraft((d) => ({ ...d, lines: d.lines.map((line) => (line.id === next.id ? next : line)) }))
  const removeLine = (id: string) =>
    setDraft((d) => ({ ...d, lines: d.lines.filter((line) => line.id !== id) }))

  /** The product a line's quick-add saved: the line names it at its usual price. */
  function pickAdded(lineId: string, product: ProductDto) {
    if (!loaded.has(product.id)) {
      setAdded((current) => [...current.filter((p) => p.id !== product.id), product])
    }
    setDraft((d) => ({
      ...d,
      lines: d.lines.map((line) =>
        line.id === lineId
          ? { ...line, productId: product.id, price: product.defaultPrice ?? line.price }
          : line,
      ),
    }))
  }

  const focusFirstError = () =>
    setTimeout(() => {
      const field = form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
      field?.focus({ preventScroll: true })
      field?.scrollIntoView({ block: 'center' })
    })

  function errorKey(error: unknown): I18nKey {
    return apiErrorCode(error) === 'conflict' ? 'sales.editor.conflict' : apiErrorKey(error)
  }

  async function save(fields: SaleFields): Promise<SaleResultDto> {
    const snapshot = draft
    const result =
      version === null
        ? await create.mutateAsync({ id: saleId, source: 'single', ...fields })
        : await update.mutateAsync({ id: saleId, version, ...fields })
    setVersion(result.data.version)
    setBaseline(snapshot)
    queryClient.setQueryData(trpc.sale.get.queryKey({ id: saleId }), result)
    void queryClient.invalidateQueries({ queryKey: trpc.sale.list.pathKey() })
    return result
  }

  function ready(): boolean {
    setSubmitted(true)
    setServerError(null)
    if (!check.fields) {
      focusFirstError()
      return false
    }
    return true
  }

  async function saveHere(): Promise<boolean> {
    if (busy || !ready()) return false
    setBusy('saving')
    try {
      await save(check.fields!)
      toast.success(t('sales.editor.saved'))
      return true
    } catch (error) {
      setServerError(errorKey(error))
      return false
    } finally {
      setBusy(null)
    }
  }

  const dirty = !sameData(draft, baseline)
  useUnsavedChanges({ dirty, save: saveHere })

  /** A new sale, once saved, opens at its own address. */
  async function openSaved() {
    await beforeNavigate()
    router.replace(`${listHref}/${saleId}`)
  }

  async function saveDraft(event: FormEvent) {
    event.preventDefault()
    const isNew = version === null
    if (!(await saveHere())) return
    if (isNew) await openSaved()
  }

  function askFinalize() {
    if (busy || !ready()) return
    if (!check.hasItem) {
      setServerError('sales.editor.errors.noItem')
      return
    }
    if (closed) {
      setFinalizeBlocked(true)
      setTimeout(() => form.current?.querySelector<HTMLElement>('input[type="date"]')?.focus())
      return
    }
    setFinalizeBlocked(false)
    setConfirmError(null)
    setConfirm('finalize')
  }

  async function finalize() {
    if (!check.fields) return
    setBusy('finalizing')
    setConfirmError(null)
    const isNew = version === null
    let saved: SaleResultDto | null = null
    try {
      saved = await save(check.fields)
      const posted = await post.mutateAsync({ id: saleId, version: saved.data.version })
      queryClient.setQueryData(trpc.sale.get.queryKey({ id: saleId }), posted)
      void refreshSales()
      toast.success(
        t('sales.confirm.finalized', {
          amount: countedOf(posted.data),
          date: businessDate(posted.data.businessDate),
        }),
      )
      setConfirm(null)
      if (isNew) await openSaved()
    } catch (error) {
      if (isNew && saved) {
        toast.error(t('sales.editor.savedNotFinalized', { reason: t(errorKey(error)) }))
        setConfirm(null)
        await openSaved()
      } else setConfirmError(errorKey(error))
    } finally {
      setBusy(null)
    }
  }

  async function discardDraft() {
    if (version === null) return
    setBusy('discarding')
    setConfirmError(null)
    try {
      await discard.mutateAsync({ id: saleId, version })
      setBaseline(draft)
      void refreshSales()
      toast.success(t('sales.confirm.discarded'))
      await beforeNavigate()
      router.replace(listHref)
    } catch (error) {
      setConfirmError(errorKey(error))
      setBusy(null)
    }
  }

  if (!context) return null
  const hasShownErrors = submitted && check.fields === null
  const amounts = check.amounts
  const counted = vatRegistered
    ? `${money(amounts?.net ?? '0', currency)} ${t('sales.list.beforeVat')}`
    : money(amounts?.total ?? '0', currency)
  const addLabel = (name: string) =>
    term(
      context.sellsOnlyServices ? 'sales.editor.addOption_services' : 'sales.editor.addOption',
      profile,
      { name },
    )

  return (
    <PageContainer>
      <Link
        href={listHref}
        className="-ms-2 -mt-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
        {t('common.nav.sales')}
      </Link>
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {version === null ? t('sales.editor.newTitle') : t('sales.editor.draftTitle')}
            </h1>
            {version === null ? null : <StatusBadge status="draft" kind="sale" />}
          </div>
          <p className="mt-1.5 max-w-2xl text-muted-foreground">{t('sales.editor.intro')}</p>
        </div>
        {version === null ? null : (
          <Button
            type="button"
            variant="ghost"
            className="self-start text-destructive hover:text-destructive"
            onClick={() => {
              setConfirmError(null)
              setConfirm('discard')
            }}
          >
            <Trash2Icon aria-hidden />
            {t('sales.editor.discard')}
          </Button>
        )}
      </header>
      {sale?.copiedFromId ? (
        <FormAlert tone="info" className="mb-4">
          {t('sales.editor.copiedFrom')}{' '}
          <Link
            href={`${listHref}/${sale.copiedFromId}`}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {t('sales.editor.openOriginal')}
          </Link>
        </FormAlert>
      ) : null}

      <form
        ref={form}
        method="post"
        noValidate
        onSubmit={(event) => void saveDraft(event)}
        className="space-y-5"
      >
        {serverError ? <FormAlert tone="error">{term(serverError, profile)}</FormAlert> : null}
        {finalizeBlocked && closedNote ? <FormAlert tone="error">{closedNote}</FormAlert> : null}
        {hasShownErrors && !serverError ? (
          <FormAlert tone="error">{t('catalog.form.fixErrors')}</FormAlert>
        ) : null}

        <Panel title={t('sales.editor.details')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label={t('sales.editor.date')}
              type="date"
              min={canPost ? firstOpenDay(today, closedThrough) : undefined}
              max={today}
              value={draft.businessDate}
              onChange={(event) => set({ businessDate: event.target.value })}
              error={
                shown(check.errors.businessDate) ??
                (closed === 'earlier' && closedNote ? closedNote : undefined)
              }
              hint={
                closed === 'today' && closedNote
                  ? (id) => (
                      <div id={id}>
                        <FormAlert tone="info">{closedNote}</FormAlert>
                      </div>
                    )
                  : undefined
              }
            />
            {channels.length > 1 ? (
              <TextField
                label={t('sales.editor.channel')}
                render={(a11y) => (
                  <NativeSelect
                    {...a11y}
                    value={channelId ?? ''}
                    onChange={(event) => set({ channelId: event.target.value || null })}
                  >
                    {channels.map((channel) => (
                      <option key={channel.id} value={channel.id}>
                        {channel.name}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              />
            ) : null}
            {locations && locations.length > 1 ? (
              <TextField
                label={t('sales.editor.location')}
                render={(a11y) => (
                  <NativeSelect
                    {...a11y}
                    value={
                      draft.locationId ??
                      locations.find((location) => location.isDefault)?.id ??
                      locations[0]!.id
                    }
                    onChange={(event) => set({ locationId: event.target.value || null })}
                  >
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              />
            ) : null}
          </div>
        </Panel>

        <Panel title={t('sales.editor.items')}>
          {!canSeeProducts ? (
            <FormAlert tone="info" className="mb-3">
              {t('sales.editor.noProductAccess')}
            </FormAlert>
          ) : productsReady && pickable.length === 0 ? (
            <FormAlert tone="info" className="mb-3">
              {canAddProducts ? t('sales.editor.noProductsYet') : t('sales.editor.noProductsAsk')}
            </FormAlert>
          ) : null}
          <div className="space-y-3">
            {draft.lines.map((line, index) => (
              <ItemLineRow
                key={line.id}
                index={index}
                line={line}
                products={products}
                pickable={pickable}
                errors={check.errors.lines[line.id]}
                shown={shown}
                amounts={check.lineAmounts.get(line.id)}
                vatRegistered={vatRegistered}
                addLabel={addLabel}
                onChange={setLine}
                onRemove={draft.lines.length > 1 ? () => removeLine(line.id) : undefined}
                onAdd={
                  canAddProducts ? (name) => setQuickAdd({ lineId: line.id, name }) : undefined
                }
              />
            ))}
            <Button
              type="button"
              variant="outline"
              onClick={() => set({ lines: [...draft.lines, newItemLine()] })}
            >
              <PlusIcon aria-hidden />
              {t('sales.editor.addItem')}
            </Button>
          </div>
        </Panel>

        <Panel title={t('sales.editor.delivery')}>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">
              {t('sales.editor.deliveryQuestion')}
            </legend>
            <div className="grid max-w-xs grid-cols-2 gap-1 rounded-lg bg-muted p-1">
              {[false, true].map((needed) => (
                <label key={String(needed)} className="relative min-w-0">
                  <input
                    type="radio"
                    name={`${deliveryId}-needed`}
                    value={needed ? 'yes' : 'no'}
                    checked={draft.deliveryNeeded === needed}
                    onChange={() => set({ deliveryNeeded: needed })}
                    className="peer sr-only"
                  />
                  <span
                    className={cn(
                      'flex min-h-11 cursor-pointer items-center justify-center rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground transition-colors',
                      'peer-checked:bg-card peer-checked:text-foreground peer-checked:shadow-sm',
                      'peer-focus-visible:ring-3 peer-focus-visible:ring-ring',
                    )}
                  >
                    {needed ? t('sales.editor.deliveryYes') : t('sales.editor.deliveryNo')}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {draft.deliveryNeeded ? (
            <div data-delivery className="mt-4 grid gap-4 sm:grid-cols-2">
              <TextField
                label={t('sales.editor.deliveryArea')}
                autoComplete="off"
                className="[unicode-bidi:plaintext]"
                placeholder={t('sales.editor.deliveryAreaPlaceholder')}
                value={draft.deliveryArea}
                onChange={(event) => set({ deliveryArea: event.target.value })}
                error={shown(check.errors.deliveryArea)}
              />
              <TextField
                label={t('sales.editor.deliveryCharged')}
                error={shown(check.errors.deliveryCharged)}
                hint={(id) => (
                  <p id={id} className="text-sm text-muted-foreground">
                    {t('sales.editor.deliveryChargedHint')}
                  </p>
                )}
                render={(a11y) => (
                  <MoneyInput
                    id={a11y.id}
                    invalid={a11y['aria-invalid']}
                    describedBy={a11y['aria-describedby']}
                    value={draft.deliveryCharged}
                    onChange={(deliveryCharged) => set({ deliveryCharged })}
                  />
                )}
              />
              {vatRegistered ? (
                <div className="flex items-center justify-between gap-4 sm:col-start-2">
                  <label htmlFor={`${deliveryId}-vat`} className="text-sm">
                    {t('sales.editor.deliveryIncludesVat')}
                  </label>
                  <Switch
                    id={`${deliveryId}-vat`}
                    checked={draft.deliveryIncludesVat}
                    onCheckedChange={(deliveryIncludesVat) => set({ deliveryIncludesVat })}
                  />
                </div>
              ) : null}
              {deliveryCostShown ? (
                <TextField
                  label={t('sales.editor.deliveryCost')}
                  error={shown(check.errors.deliveryCost)}
                  hint={(id) => (
                    <p id={id} className="text-sm text-muted-foreground">
                      {t('sales.editor.deliveryCostHint')}
                    </p>
                  )}
                  render={(a11y) => (
                    <MoneyInput
                      id={a11y.id}
                      invalid={a11y['aria-invalid']}
                      describedBy={a11y['aria-describedby']}
                      value={draft.deliveryCost}
                      onChange={(deliveryCost) => set({ deliveryCost })}
                    />
                  )}
                />
              ) : null}
            </div>
          ) : null}
        </Panel>

        <Panel title={t('purchasing.totals.title')}>
          <Totals
            subtotal={amounts ? sumDecimals(amounts.lines.map((l) => l.subtotal)) : '0'}
            discount={amounts ? sumDecimals(amounts.lines.map((l) => l.discount)) : '0'}
            net={amounts?.net ?? '0'}
            vat={amounts?.vat ?? '0'}
            total={amounts?.total ?? '0'}
            vatRegistered={vatRegistered}
            money={(amount) => money(amount, currency)}
          />
        </Panel>

        <Panel title={t('sales.editor.moreDetails')}>
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('sales.editor.notes')}</p>
            <Textarea
              aria-label={t('sales.editor.notes')}
              aria-invalid={Boolean(shown(check.errors.notes))}
              className="[unicode-bidi:plaintext]"
              rows={3}
              placeholder={t('sales.editor.notesHint')}
              value={draft.notes}
              onChange={(event) => set({ notes: event.target.value })}
            />
            {shown(check.errors.notes) ? (
              <p role="alert" className="mt-1.5 text-sm text-destructive">
                {shown(check.errors.notes)}
              </p>
            ) : null}
          </div>
        </Panel>

        <div className="sticky bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-10 flex items-center gap-3 rounded-2xl bg-card/95 p-3 shadow-lg ring-1 ring-foreground/10 backdrop-blur md:bottom-4">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">{t('purchasing.totals.total')}</p>
            <p data-running-total className="truncate font-semibold tabular-nums">
              {money(amounts?.total ?? '0', currency)}
            </p>
          </div>
          <Button type="submit" variant="outline" disabled={busy !== null}>
            {busy === 'saving' ? t('status.saving') : t('sales.editor.save')}
          </Button>
          {canPost ? (
            <Button type="button" disabled={busy !== null} onClick={askFinalize}>
              <CheckCheckIcon aria-hidden />
              {t('sales.editor.finalize')}
            </Button>
          ) : null}
        </div>
      </form>

      <ConfirmDialog
        open={confirm === 'finalize'}
        icon={CheckCheckIcon}
        title={t('sales.confirm.finalizeTitle')}
        body={t('sales.confirm.finalizeBody', {
          date: businessDate(draft.businessDate),
          amount: counted,
        })}
        note={t('sales.confirm.finalizeNote')}
        action={t('sales.editor.finalize')}
        busyLabel={t('sales.confirm.finalizing')}
        busy={busy === 'finalizing'}
        error={confirmError}
        onConfirm={() => void finalize()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'discard'}
        icon={Trash2Icon}
        title={t('sales.confirm.discardTitle')}
        body={t('sales.confirm.discardBody')}
        action={t('sales.confirm.discardAction')}
        busyLabel={t('status.deleting')}
        busy={busy === 'discarding'}
        error={confirmError}
        destructive
        onConfirm={() => void discardDraft()}
        onClose={() => setConfirm(null)}
      />
      {quickAdd ? (
        <ProductSheet
          name={quickAdd.name}
          profile={profile}
          resale={resale}
          onSaved={(product) => pickAdded(quickAdd.lineId, product)}
          onClose={() => setQuickAdd(null)}
        />
      ) : null}
    </PageContainer>
  )
}
