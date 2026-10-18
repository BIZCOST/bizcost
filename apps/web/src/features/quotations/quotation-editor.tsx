'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { ProductDto, QuotationDto } from '@bizcost/contracts'
import {
  areaBlocks,
  areaKey,
  areaNames,
  compareDecimal,
  newId,
  type CurrencyCode,
} from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftIcon, LayersIcon, PlusIcon } from 'lucide-react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { Required } from '@/components/form/required'
import { TextField } from '@/components/form/text-field'
import { sameData } from '@/components/form/unsaved'
import { useBeforeNavigate, useUnsavedChanges } from '@/components/form/unsaved-changes'
import { isolate, ltrIsolate } from '@/components/form/use-message'
import { PageContainer } from '@/components/shell/page-container'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { FieldError } from '@/features/catalog/numbers'
import { ProductSheet } from '@/features/catalog/product-sheet'
import { CustomerPicker } from '@/features/customers/customer-picker'
import { mayAddCustomers } from '@/features/customers/data'
import { useMoney } from '@/features/documents/amounts'
import { Caption, DiscountRow, MoneyInput } from '@/features/documents/line-editor'
import { Panel } from '@/features/documents/panel'
import { hasModule } from '@/features/purchasing/data'
import { Receipts } from '@/features/purchasing/receipts'
import { useAllProducts } from '@/features/sales/data'
import { can } from '@/features/settings/sections'
import { useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import {
  addLineTo,
  areaTaken,
  canMoveArea,
  canMoveLine,
  moveArea,
  moveLine,
  renameArea,
  setLineArea,
} from './areas'
import { useRefreshQuotations } from './data'
import { PictureError, useSaveLinePictures } from './line-pictures'
import {
  checkQuotation,
  isBlankLine,
  newQuotationLine,
  QUOTATION_MISSING,
  quotationDraft,
  type LinePicture,
  type QuotationDraft,
  type QuotationLineDraft,
  amountsKey,
  carriedRounding,
} from './quotation-draft'
import { AreaNameDialog, AreaSection } from './quotation-areas'
import { QuotationLineRow } from './quotation-lines'
import { QuotationStages } from './quotation-stages'
import { QuotationTotals } from './quotation-totals'
import { totalsOf } from './totals'

// A new quotation, or a draft changed (M3 Step 7; Q21–Q25; the owner's document requests of
// 2026-10-16). Multi-column on a desktop (the lines and their words beside the totals, the rounding
// and the payment terms), stacked on a phone with the amount to pay and Save at the foot. The
// customer is picked by name (or added on the spot); each line by type-ahead from Products & Services,
// or typed ("Save as a work item"), with its area, details, highlighted note and picture; the lines are
// grouped under their areas (D-299: "Add an area", a line moved into another area or out of any, lines
// and areas moved up and down with buttons, each area with how many lines it has); % or amount
// discounts; "Round the total" («تقريب الإجمالي») shows the adjustment before VAT and any rounding
// difference («فرق التقريب») as the PDF prints them; the VAT of each rate only for a VAT-registered
// business; payment stages; the greeting, the sentence after it, the terms, how long it is valid;
// files once saved. Leaving with changes asks first.

export function QuotationEditor({
  quotation,
  today,
}: {
  /** Absent: a new quotation. */
  quotation?: QuotationDto
  /** Today in the business's time zone (books.get). */
  today: string
}) {
  const { t } = useTranslation()
  const term = useTerminology()
  const money = useMoney()
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  const beforeNavigate = useBeforeNavigate()
  const refresh = useRefreshQuotations()
  const savePictures = useSaveLinePictures()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  // A draft is worked out again on every save, with the business's VAT registration now.
  const vatRegistered = context?.capabilities.vat_registered === true
  const canSeeProducts =
    context !== undefined && hasModule(context, 'products') && can(context, 'products.items.view')
  const canAddProducts = context !== undefined && can(context, 'products.items.manage')
  const { products: loaded } = useAllProducts(canSeeProducts)
  const create = useMutation(trpc.quotation.create.mutationOptions())
  const update = useMutation(trpc.quotation.update.mutationOptions())

  const [quotationId] = useState(() => quotation?.id ?? newId())
  const [initial] = useState<QuotationDraft>(() =>
    quotationDraft(quotation, {
      today,
      locationId:
        context && !context.locationScope.all ? (context.locationScope.ids[0] ?? null) : null,
    }),
  )
  const [draft, setDraft] = useState<QuotationDraft>(initial)
  const [baseline, setBaseline] = useState<QuotationDraft>(initial)
  // "Round the total" keeps the total typed while the lines change (D-221): the editor says so as soon
  // as the lines differ from those the total was rounded on, and at once on a revision or a copy that
  // carried a rounded total over (D-297), saying where it was rounded, with a choice to keep it
  // or take it off.
  const carried = carriedRounding(quotation)
  const [roundedOn, setRoundedOn] = useState<string | null>(() =>
    carried ? null : amountsKey(initial),
  )
  const [added, setAdded] = useState<ProductDto[]>([])
  const [saveAsItem, setSaveAsItem] = useState<QuotationLineDraft | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<I18nKey | null>(null)
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState(quotation?.version ?? null)
  const form = useRef<HTMLFormElement>(null)
  // The amount to pay and Save at the foot of a phone's screen (hidden on a desktop).
  const phoneBar = useRef<HTMLDivElement>(null)

  const products = useMemo(
    () =>
      added.length === 0
        ? loaded
        : new Map<string, ProductDto>([...loaded, ...added.map((p) => [p.id, p] as const)]),
    [loaded, added],
  )
  const currency = (quotation?.currency ?? context?.currency ?? 'AED') as CurrencyCode
  const saved = version !== null
  const check = useMemo(
    () => checkQuotation(draft, { currency, vatRegistered, today, products, saved }),
    [draft, currency, vatRegistered, today, products, saved],
  )
  const pickable = useMemo(() => {
    const named = new Set(draft.lines.map((line) => line.productId))
    return [...products.values()].filter((p) => p.archivedAt === null || named.has(p.id))
  }, [products, draft.lines])
  const areas = useMemo(() => areaNames(draft.lines), [draft.lines])
  const blocks = useMemo(() => areaBlocks(draft.lines), [draft.lines])
  const numbers = useMemo(
    () => new Map(draft.lines.map((line, index) => [line.id, index] as const)),
    [draft.lines],
  )
  // The name asked for a new area (from "Add an area", or for a line), or for one renamed.
  const [naming, setNaming] = useState<
    { kind: 'add' } | { kind: 'line'; lineId: string } | { kind: 'rename'; area: string } | null
  >(null)
  // What a move did, said to a screen reader (the buttons keep the focus).
  const [announcement, setAnnouncement] = useState('')
  const profile = context?.terminologyProfile ?? 'general'
  const shown = (error: FieldError | undefined): string | undefined =>
    error && (submitted || !QUOTATION_MISSING.has(error.key))
      ? term(error.key, profile, error.values)
      : undefined
  const listHref = `/b/${businessId}/quotations`
  const formatMoney = (amount: string) => money(amount, currency)

  const set = (patch: Partial<QuotationDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const setLine = (next: QuotationLineDraft) =>
    setDraft((d) => ({ ...d, lines: d.lines.map((line) => (line.id === next.id ? next : line)) }))
  /**
   * Changes only line `id`'s picture, from the picture it has now: a picture framed while the line
   * changed (its title typed, its area changed) never brings back the line as it was.
   */
  const setLinePicture = (id: string, change: (picture: LinePicture) => LinePicture) =>
    setDraft((d) => ({
      ...d,
      lines: d.lines.map((line) =>
        line.id === id ? { ...line, picture: change(line.picture) } : line,
      ),
    }))
  const removeLine = (id: string) =>
    setDraft((d) => ({ ...d, lines: d.lines.filter((line) => line.id !== id) }))
  const setLines = (change: (lines: readonly QuotationLineDraft[]) => QuotationLineDraft[]) =>
    setDraft((d) => ({ ...d, lines: change(d.lines) }))
  /**
   * Focuses the first of `selectors` that is on the page and can take it, once React has drawn, and
   * scrolls it into view clear of the bars: the top bar and a phone's tab bar (the page's scroll
   * padding), and a phone's save bar above the tab bar (WCAG 2.4.11), where a line moved down lands.
   */
  const focusSoon = (...selectors: string[]) =>
    setTimeout(() => {
      for (const selector of selectors) {
        const target = form.current?.querySelector<HTMLElement>(selector)
        if (target && !(target as HTMLButtonElement).disabled) {
          target.focus({ preventScroll: true })
          target.scrollIntoView({ block: 'nearest' })
          const bar = phoneBar.current
          if (bar && bar.offsetParent !== null) {
            const under = target.getBoundingClientRect().bottom - bar.getBoundingClientRect().top
            if (under > -8) target.scrollIntoView({ block: 'center' })
          }
          return
        }
      }
    })
  /** A new line at the end of `area` (null: at the end, in no area), its title focused. */
  const addLine = (area: string | null = null) => {
    const line = newQuotationLine()
    setLines((lines) => addLineTo(lines, line, area))
    focusSoon(`[data-line-id="${line.id}"] [role="combobox"][aria-autocomplete]`)
  }
  const lineAt = (id: string) => numbers.get(id) ?? -1
  function moveLineBy(id: string, step: -1 | 1) {
    const next = moveLine(draft.lines, id, step)
    set({ lines: next })
    const to = next.findIndex((line) => line.id === id) + 1
    setAnnouncement(t('documents.quotations.editor.areas.lineMoved', { number: to }))
    const there = `[data-line-id="${id}"] [data-line-move="${step < 0 ? 'up' : 'down'}"]`
    const back = `[data-line-id="${id}"] [data-line-move="${step < 0 ? 'down' : 'up'}"]`
    focusSoon(there, back)
  }
  function moveAreaBy(name: string, step: -1 | 1) {
    set({ lines: moveArea(draft.lines, name, step) })
    setAnnouncement(t('documents.quotations.editor.areas.areaMoved', { area: isolate(name) }))
    const section = `[data-area-key="${CSS.escape(areaKey(name))}"]`
    focusSoon(
      `${section} [data-area-move="${step < 0 ? 'up' : 'down'}"]`,
      `${section} [data-area-move="${step < 0 ? 'down' : 'up'}"]`,
    )
  }
  function putLineIn(id: string, area: string | null) {
    const number = lineAt(id) + 1
    // An area started with an empty line (nothing entered in it) takes the line in its place.
    set({ lines: setLineArea(draft.lines, id, area, isBlankLine) })
    setAnnouncement(
      area === null
        ? t('documents.quotations.editor.areas.lineToNone', { number })
        : t('documents.quotations.editor.areas.lineToArea', { number, area: isolate(area) }),
    )
    focusSoon(`[data-line-id="${id}"] [data-line-area]`)
  }
  function named(name: string) {
    if (!naming) return
    if (naming.kind === 'add') {
      // A line nothing was entered in yet, without an area, goes into the new area (a new
      // quotation's first line); else the area starts with a new line.
      const blank = draft.lines.findLast((line) => line.area === null && isBlankLine(line))
      if (blank) {
        set({ lines: setLineArea(draft.lines, blank.id, name) })
        focusSoon(`[data-line-id="${blank.id}"] [role="combobox"][aria-autocomplete]`)
      } else addLine(name)
    } else if (naming.kind === 'line') putLineIn(naming.lineId, name)
    else {
      set({ lines: renameArea(draft.lines, naming.area, name) })
      // The area's section is drawn again under its new name: the focus goes back to its button.
      focusSoon(`[data-area-key="${CSS.escape(areaKey(name))}"] [data-area-rename]`)
    }
    setNaming(null)
  }

  function savedAsItem(lineId: string, product: ProductDto) {
    if (!loaded.has(product.id)) {
      setAdded((current) => [...current.filter((p) => p.id !== product.id), product])
    }
    setDraft((d) => ({
      ...d,
      lines: d.lines.map((line) =>
        line.id === lineId
          ? {
              ...line,
              productId: product.id,
              title: product.name,
              unit: product.unit,
              vatCategory: product.vatCategory,
              price: line.price.trim() !== '' ? line.price : (product.defaultPrice ?? ''),
            }
          : line,
      ),
    }))
  }

  function errorKey(error: unknown): I18nKey {
    return apiErrorCode(error) === 'conflict'
      ? 'documents.quotations.editor.conflict'
      : apiErrorKey(error)
  }

  /** Saves the quotation (then its lines' pictures); its result once saved, null otherwise. */
  async function save(): Promise<QuotationDto | null> {
    if (busy) return null
    setSubmitted(true)
    setServerError(null)
    const fields = check.fields
    if (!fields) {
      setTimeout(() => {
        const field = form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
        field?.focus({ preventScroll: true })
        field?.scrollIntoView({ block: 'center' })
      })
      return null
    }
    setBusy(true)
    const snapshot = draft
    try {
      let result =
        version !== null
          ? await update.mutateAsync({ id: quotationId, version, ...fields })
          : await create.mutateAsync({ id: quotationId, ...fields })
      setVersion(result.version)
      try {
        if ((await savePictures(snapshot.lines)) > 0) {
          result = await queryClient.fetchQuery(
            trpc.quotation.get.queryOptions({ id: quotationId }),
          )
        }
      } catch (caught) {
        toast.error(t(caught instanceof PictureError ? caught.key : 'errors.internal'))
      }
      setBaseline(snapshot)
      queryClient.setQueryData(trpc.quotation.get.queryKey({ id: quotationId }), result)
      void refresh()
      return result
    } catch (error) {
      setServerError(errorKey(error))
      return null
    } finally {
      setBusy(false)
    }
  }

  const dirty = !sameData(draft, baseline)
  useUnsavedChanges({ dirty, save: async () => (await save()) !== null })

  async function submit(event: FormEvent) {
    event.preventDefault()
    const result = await save()
    if (!result) return
    toast.success(
      quotation
        ? t('documents.quotations.editor.saved')
        : t('documents.quotations.editor.created', { number: isolate(result.number) }),
    )
    await beforeNavigate()
    router.replace(`${listHref}/${result.id}`)
  }

  if (!context) return null
  const hasShownErrors = submitted && check.fields === null
  // A revision is the same quotation for the same customer: another customer is a copy (D-296).
  const customerLocked = (quotation?.revision ?? 1) > 1
  const roundingStale =
    draft.roundTo.trim() !== '' && check.rounding !== null && amountsKey(draft) !== roundedOn
  const amounts = check.amounts
  const totals = totalsOf({
    currency,
    lines: amounts?.lines ?? [],
    documentDiscount: amounts?.documentDiscount ?? '0',
    adjustment: amounts?.adjustment ?? '0',
    net: amounts?.net ?? '0',
    rates: amounts?.rates ?? [],
    total: amounts?.total ?? '0',
    difference: amounts?.roundingDifference ?? '0',
    payable: amounts?.payable ?? '0',
  })
  const title = quotation
    ? quotation.revision > 1
      ? t('documents.quotations.editor.editRevisionTitle', {
          number: isolate(quotation.number),
          revision: quotation.revision,
        })
      : t('documents.quotations.editor.editTitle', { number: isolate(quotation.number) })
    : t('documents.quotations.editor.newTitle')

  const totalsPanel = (
    <Panel title={t('documents.quotations.editor.totalsTitle')}>
      <div className="space-y-4">
        <div data-quotation-discount>
          <DiscountRow
            kind={draft.discountKind}
            value={draft.discount}
            invalid={Boolean(shown(check.errors.discount))}
            addLabel={t('documents.quotations.editor.addDiscount')}
            label={t('documents.quotations.editor.discount')}
            onChange={(next) => set({ discountKind: next.kind, discount: next.value })}
          />
          {shown(check.errors.discount) ? (
            <p role="alert" className="mt-1.5 text-sm text-destructive">
              {shown(check.errors.discount)}
            </p>
          ) : null}
        </div>
        <div data-round-total>
          <Caption>{t('documents.quotations.editor.roundTo')}</Caption>
          <MoneyInput
            label={t('documents.quotations.editor.roundTo')}
            value={draft.roundTo}
            invalid={Boolean(shown(check.errors.roundTo))}
            onChange={(roundTo) => {
              set({ roundTo })
              setRoundedOn(amountsKey(draft))
            }}
          />
          {roundingStale && check.rounding ? (
            <div
              data-rounding-stale
              role="status"
              className="mt-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-950 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-100 dark:ring-amber-800"
            >
              <p className="font-medium">
                {t('documents.quotations.editor.roundStaleTitle', {
                  total: ltrIsolate(formatMoney(check.rounding.wanted)),
                })}
              </p>
              <p className="mt-1">
                {t(
                  roundedOn === null
                    ? carried === 'copy'
                      ? 'documents.quotations.editor.roundCarriedCopy'
                      : 'documents.quotations.editor.roundCarried'
                    : 'documents.quotations.editor.roundStale',
                  { amount: ltrIsolate(formatMoney(check.rounding.adjustment)) },
                )}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setRoundedOn(amountsKey(draft))}
                >
                  {t('documents.quotations.editor.roundKeep', {
                    total: ltrIsolate(formatMoney(check.rounding.wanted)),
                  })}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => set({ roundTo: '' })}
                >
                  {t('documents.quotations.editor.roundRemove')}
                </Button>
              </div>
            </div>
          ) : null}
          {shown(check.errors.roundTo) ? (
            <p role="alert" className="mt-1.5 text-sm text-destructive">
              {shown(check.errors.roundTo)}
            </p>
          ) : check.rounding ? (
            <div data-rounding className="mt-1.5 space-y-0.5 text-sm text-muted-foreground">
              <p>
                {t(
                  vatRegistered
                    ? 'documents.quotations.editor.roundAdjustment'
                    : 'documents.quotations.editor.roundAdjustmentNoVat',
                  { amount: ltrIsolate(formatMoney(check.rounding.adjustment)) },
                )}
              </p>
              {compareDecimal(check.rounding.difference, '0') !== 0 ? (
                <p>
                  {t('documents.quotations.editor.roundDifference', {
                    amount: ltrIsolate(formatMoney(check.rounding.difference)),
                  })}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="mt-1.5 text-sm text-muted-foreground">
              {t('documents.quotations.editor.roundHint')}
            </p>
          )}
        </div>
        <div className="border-t pt-3">
          <QuotationTotals values={totals} vatRegistered={vatRegistered} money={formatMoney} />
        </div>
      </div>
    </Panel>
  )

  const saveBar = (
    <div className="flex items-center gap-3 rounded-2xl bg-card/95 p-3 shadow-lg ring-1 ring-foreground/10 backdrop-blur">
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{t('documents.quotations.editor.toPay')}</p>
        <p data-running-total className="truncate font-semibold tabular-nums">
          {formatMoney(amounts?.payable ?? '0')}
        </p>
        {roundingStale ? (
          <button
            type="button"
            data-rounding-stale-hint
            className="block max-w-full truncate text-start text-xs font-medium text-amber-700 underline-offset-2 hover:underline dark:text-amber-300"
            onClick={() =>
              form.current
                ?.querySelector('[data-rounding-stale]')
                ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
            }
          >
            {t('documents.quotations.editor.roundStaleHint')}
          </button>
        ) : null}
      </div>
      <Button type="submit" disabled={busy}>
        {busy
          ? t('status.saving')
          : quotation
            ? t('documents.quotations.editor.saveChanges')
            : t('documents.quotations.editor.save')}
      </Button>
    </div>
  )

  const stagesPanel = (
    <Panel
      title={t('documents.quotations.editor.stagesTitle')}
      hint={t('documents.quotations.editor.stagesHint')}
    >
      <QuotationStages
        stages={draft.stages}
        errors={check.errors.stages}
        rowErrors={check.errors.stageRows}
        shown={shown}
        amounts={check.stageAmounts}
        money={formatMoney}
        onChange={(stages) => set({ stages })}
      />
    </Panel>
  )

  return (
    <PageContainer>
      <Link
        href={quotation ? `${listHref}/${quotation.id}` : listHref}
        className="-ms-2 -mt-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
        {quotation
          ? t('documents.quotations.view.title', { number: isolate(quotation.number) })
          : t('common.nav.quotations')}
      </Link>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        <p className="mt-1.5 max-w-2xl text-muted-foreground">
          {term('documents.quotations.editor.pageIntro', profile)}
        </p>
      </header>

      <form
        ref={form}
        method="post"
        noValidate
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-x-6 xl:grid-cols-[minmax(0,1fr)_24rem]"
      >
        {/* On a phone: the customer and the lines, the totals and payment terms, then the words; on
            a desktop the totals and payment terms stay beside the rest. */}
        <div className="order-1 min-w-0 space-y-5 lg:col-start-1 lg:row-start-1">
          {serverError ? <FormAlert tone="error">{term(serverError, profile)}</FormAlert> : null}
          {hasShownErrors && !serverError ? (
            <FormAlert tone="error">{t('catalog.form.fixErrors')}</FormAlert>
          ) : null}

          <Panel title={t('documents.quotations.editor.forWhom')}>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label={<Required>{t('documents.quotations.editor.customer')}</Required>}
                error={shown(check.errors.customer)}
                render={(a11y) => (
                  <CustomerPicker
                    value={draft.customer}
                    label={t('documents.quotations.editor.customer')}
                    invalid={a11y['aria-invalid']}
                    describedBy={a11y['aria-describedby']}
                    canAdd={mayAddCustomers(context)}
                    disabled={customerLocked}
                    onChange={(customer) => set({ customer })}
                  />
                )}
                hint={
                  customerLocked
                    ? (id) => (
                        <p id={id} className="text-sm text-muted-foreground">
                          {t('documents.quotations.editor.customerLocked')}
                        </p>
                      )
                    : undefined
                }
              />
              <TextField
                label={term('documents.quotations.editor.site', profile)}
                autoComplete="off"
                className="[unicode-bidi:plaintext]"
                placeholder={term('documents.quotations.editor.sitePlaceholder', profile)}
                value={draft.site}
                onChange={(event) => set({ site: event.target.value })}
                error={shown(check.errors.site)}
              />
              <TextField
                label={t('documents.quotations.editor.customerRef')}
                autoComplete="off"
                className="[unicode-bidi:plaintext]"
                value={draft.customerRef}
                onChange={(event) => set({ customerRef: event.target.value })}
                error={shown(check.errors.customerRef)}
                hint={(id) => (
                  <p id={id} className="text-sm text-muted-foreground">
                    {t('documents.quotations.editor.customerRefHint')}
                  </p>
                )}
              />
              <div className="grid grid-cols-2 gap-4">
                <TextField
                  label={t('documents.quotations.editor.date')}
                  type="date"
                  max={today}
                  value={draft.businessDate}
                  onChange={(event) => set({ businessDate: event.target.value })}
                  error={shown(check.errors.businessDate)}
                />
                <TextField
                  label={t('documents.quotations.editor.validUntil')}
                  type="date"
                  min={draft.businessDate || undefined}
                  value={draft.validUntil}
                  onChange={(event) => set({ validUntil: event.target.value })}
                  error={shown(check.errors.validUntil)}
                />
              </div>
              {saved ? null : (
                <p className="text-sm text-muted-foreground sm:col-span-2">
                  {t('documents.quotations.editor.validUntilHint')}
                </p>
              )}
            </div>
          </Panel>

          <Panel
            title={term('documents.quotations.editor.lines', profile)}
            hint={term('documents.quotations.editor.linesHint', profile)}
          >
            {!canSeeProducts ? (
              <FormAlert tone="info" className="mb-3">
                {t('documents.quotations.editor.typedOnly')}
              </FormAlert>
            ) : null}
            <div className="space-y-3">
              {blocks.map((block, b) => {
                const rows = block.lines.map((line) => (
                  <div key={line.id} data-line-id={line.id}>
                    <QuotationLineRow
                      index={lineAt(line.id)}
                      line={line}
                      products={products}
                      pickable={pickable}
                      areas={areas}
                      errors={check.errors.lines[line.id]}
                      shown={shown}
                      amounts={check.lineAmounts.get(line.id)}
                      vatRegistered={vatRegistered}
                      profile={profile}
                      onChange={setLine}
                      onPicture={(change) => setLinePicture(line.id, change)}
                      onRemove={draft.lines.length > 1 ? () => removeLine(line.id) : undefined}
                      onSaveAsItem={
                        canAddProducts && canSeeProducts ? () => setSaveAsItem(line) : undefined
                      }
                      onArea={(area) => putLineIn(line.id, area)}
                      onNewArea={() => setNaming({ kind: 'line', lineId: line.id })}
                      canMove={(step) => canMoveLine(draft.lines, line.id, step)}
                      onMove={(step) => moveLineBy(line.id, step)}
                    />
                  </div>
                ))
                if (block.area === null) return rows
                const name = block.area
                return (
                  <div key={`area:${areaKey(name)}`} data-area-key={areaKey(name)}>
                    <AreaSection
                      name={name}
                      count={block.lines.length}
                      canUp={b > 0 && canMoveArea(draft.lines, name, -1)}
                      canDown={canMoveArea(draft.lines, name, 1)}
                      onRename={() => setNaming({ kind: 'rename', area: name })}
                      onMove={(step) => moveAreaBy(name, step)}
                      onAddLine={() => addLine(name)}
                    >
                      {rows}
                    </AreaSection>
                  </div>
                )
              })}
              <p className="sr-only" role="status" aria-live="polite">
                {announcement}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={() => addLine(null)}>
                  <PlusIcon aria-hidden />
                  {areas.length > 0
                    ? t('documents.quotations.editor.areas.addLineNoArea')
                    : t('documents.quotations.editor.addLine')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  data-area-add
                  onClick={() => setNaming({ kind: 'add' })}
                >
                  <LayersIcon aria-hidden />
                  {t('documents.quotations.editor.areas.add')}
                </Button>
              </div>
            </div>
          </Panel>
        </div>

        <aside className="order-2 min-w-0 space-y-5 lg:sticky lg:top-24 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start">
          <div className="hidden lg:block">{saveBar}</div>
          {totalsPanel}
          {stagesPanel}
        </aside>

        <div className="order-3 min-w-0 space-y-5 lg:col-start-1 lg:row-start-2">
          <Panel
            title={t('documents.quotations.editor.wordsTitle')}
            hint={t('documents.quotations.editor.wordsHint')}
          >
            <div className="space-y-4">
              <TextField
                label={t('documents.quotations.editor.greeting')}
                autoComplete="off"
                className="[unicode-bidi:plaintext]"
                placeholder={t('documents.quotations.editor.greetingPlaceholder')}
                value={draft.greeting}
                onChange={(event) => set({ greeting: event.target.value })}
                error={shown(check.errors.greeting)}
              />
              {(
                [
                  ['intro', 'introPlaceholder', 3],
                  ['terms', saved ? 'termsPlaceholder' : 'termsPlaceholderNew', 4],
                  ['notes', 'notesPlaceholder', 2],
                ] as const
              ).map(([field, placeholder, rows]) => (
                <div key={field} className="space-y-1.5">
                  <p className="text-sm font-medium">{t(`documents.quotations.editor.${field}`)}</p>
                  <Textarea
                    aria-label={t(`documents.quotations.editor.${field}`)}
                    aria-invalid={Boolean(shown(check.errors[field]))}
                    className="[unicode-bidi:plaintext]"
                    rows={rows}
                    placeholder={t(`documents.quotations.editor.${placeholder}`)}
                    value={draft[field]}
                    onChange={(event) =>
                      set({ [field]: event.target.value } as Partial<QuotationDraft>)
                    }
                  />
                  {shown(check.errors[field]) ? (
                    <p role="alert" className="text-sm text-destructive">
                      {shown(check.errors[field])}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </Panel>

          {hasModule(context, 'files') ? (
            <Panel
              title={t('documents.quotations.files.title')}
              hint={t('documents.quotations.files.hint')}
            >
              {saved ? (
                <Receipts entity="quotation" recordId={quotationId} canManage />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t('documents.quotations.files.afterSave')}
                </p>
              )}
            </Panel>
          ) : null}
        </div>

        {/* The amount to pay and Save: at the foot of a phone's screen, at the top of the desktop's
            totals column (where nothing covers the payment terms under it). */}
        <div
          ref={phoneBar}
          data-phone-save-bar
          className="sticky bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-10 order-4 md:bottom-4 lg:hidden"
        >
          {saveBar}
        </div>
      </form>

      {naming ? (
        <AreaNameDialog
          mode={naming.kind === 'rename' ? 'rename' : 'add'}
          initial={naming.kind === 'rename' ? naming.area : ''}
          profile={profile}
          taken={(name) =>
            areaTaken(draft.lines, name, naming.kind === 'rename' ? naming.area : null)
          }
          onCancel={() => setNaming(null)}
          onSubmit={named}
        />
      ) : null}

      {saveAsItem ? (
        <ProductSheet
          name={saveAsItem.title.trim()}
          start={{
            unit: saveAsItem.unit === '' ? undefined : saveAsItem.unit,
            price: saveAsItem.price.trim() || undefined,
            vatCategory: saveAsItem.vatCategory,
          }}
          profile={profile}
          resale="none"
          onSaved={(product) => savedAsItem(saveAsItem.id, product)}
          onClose={() => setSaveAsItem(null)}
        />
      ) : null}
    </PageContainer>
  )
}
