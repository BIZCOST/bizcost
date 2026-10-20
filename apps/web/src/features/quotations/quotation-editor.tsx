'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { ProductDto, QuotationDto } from '@bizcost/contracts'
import { newId, type CurrencyCode } from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftIcon } from 'lucide-react'
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
import { isolate } from '@/components/form/use-message'
import { PageContainer } from '@/components/shell/page-container'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { FieldError } from '@/features/catalog/numbers'
import { CustomerPicker } from '@/features/customers/customer-picker'
import { mayAddCustomers } from '@/features/customers/data'
import { useMoney } from '@/features/documents/amounts'
import { Panel } from '@/features/documents/panel'
import { hasModule } from '@/features/purchasing/data'
import { Receipts } from '@/features/purchasing/receipts'
import { useAllProducts } from '@/features/sales/data'
import { can } from '@/features/settings/sections'
import { useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { useRefreshQuotations } from './data'
import { DocumentLines } from './document-lines'
import { PictureError, useSaveLinePictures } from './line-pictures'
import {
  checkQuotation,
  QUOTATION_MISSING,
  quotationDraft,
  type QuotationDraft,
  type QuotationLineDraft,
  amountsKey,
  carriedRounding,
} from './quotation-draft'
import { QuotationStages } from './quotation-stages'
import { TotalsEditor } from './totals-editor'
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
  const profile = context?.terminologyProfile ?? 'general'
  const shown = (error: FieldError | undefined): string | undefined =>
    error && (submitted || !QUOTATION_MISSING.has(error.key))
      ? term(error.key, profile, error.values)
      : undefined
  const listHref = `/b/${businessId}/quotations`
  const formatMoney = (amount: string) => money(amount, currency)

  const set = (patch: Partial<QuotationDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const setLines = (change: (lines: readonly QuotationLineDraft[]) => QuotationLineDraft[]) =>
    setDraft((d) => ({ ...d, lines: change(d.lines) }))
  const productSaved = (product: ProductDto) => {
    if (!loaded.has(product.id)) {
      setAdded((current) => [...current.filter((p) => p.id !== product.id), product])
    }
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
      <TotalsEditor
        discountKind={draft.discountKind}
        discount={draft.discount}
        roundTo={draft.roundTo}
        discountError={shown(check.errors.discount)}
        roundToError={shown(check.errors.roundTo)}
        rounding={check.rounding}
        stale={roundingStale}
        carried={roundedOn === null ? carried : null}
        vatRegistered={vatRegistered}
        totals={totals}
        money={formatMoney}
        onDiscount={(next) => set({ discountKind: next.kind, discount: next.value })}
        onRoundTo={(roundTo) => {
          set({ roundTo })
          setRoundedOn(amountsKey(draft))
        }}
        onKeep={() => setRoundedOn(amountsKey(draft))}
      />
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
            <DocumentLines
              lines={draft.lines}
              setLines={setLines}
              products={products}
              onProductSaved={productSaved}
              errors={check.errors.lines}
              shown={shown}
              lineAmounts={check.lineAmounts}
              vatRegistered={vatRegistered}
              profile={profile}
              canSeeProducts={canSeeProducts}
              canAddProducts={canAddProducts}
              form={form}
              phoneBar={phoneBar}
            />
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
    </PageContainer>
  )
}
