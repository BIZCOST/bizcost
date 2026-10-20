'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { InvoiceDto, ProductDto } from '@bizcost/contracts'
import {
  invoiceCounts,
  invoiceKindFor,
  newId,
  subtractDecimals,
  sumDecimals,
  taxDocumentDueBy,
  taxDocumentLate,
  type CurrencyCode,
} from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftIcon } from 'lucide-react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { Required } from '@/components/form/required'
import { TextField } from '@/components/form/text-field'
import { sameData } from '@/components/form/unsaved'
import { useBeforeNavigate, useUnsavedChanges } from '@/components/form/unsaved-changes'
import { PageContainer } from '@/components/shell/page-container'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import type { FieldError } from '@/features/catalog/numbers'
import { CustomerPicker } from '@/features/customers/customer-picker'
import { mayAddCustomers } from '@/features/customers/data'
import { useBusinessDate, useMoney } from '@/features/documents/amounts'
import { BranchField } from '@/features/quotations/branch-field'
import { Panel } from '@/features/documents/panel'
import { hasModule } from '@/features/purchasing/data'
import { DocumentLineList } from '@/features/quotations/document-line-list'
import { DocumentLines } from '@/features/quotations/document-lines'
import { PictureError, useSaveLinePictures } from '@/features/quotations/line-pictures'
import { amountsKey } from '@/features/quotations/quotation-draft'
import { QuotationTotals } from '@/features/quotations/quotation-totals'
import { totalsOf } from '@/features/quotations/totals'
import { TotalsEditor } from '@/features/quotations/totals-editor'
import { defaultChannelId, useAllProducts, useChannels } from '@/features/sales/data'
import { can } from '@/features/settings/sections'
import { useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { CountedQuestion } from './counted-question'
import { invoiceKindKey, useRefreshInvoices } from './data'
import {
  checkInvoice,
  INVOICE_MISSING,
  invoiceDraft,
  isScratch,
  type InvoiceDraft,
  type InvoiceFields,
} from './invoice-draft'
import { useBillsSummary } from './invoice-words'

// A new invoice, or a draft changed (M3 Step 8; Q3, Q22, Q26). Made from scratch: the customer
// (picked or added on the spot), its lines as a quotation's (D-299), a discount and "Round the total";
// made from a quotation, an order or a sale: what it bills and its lines as they are, its header only.
// The header holds the date of supply (a tax invoice is due within 14 days of it, VAT DL Art. 67(1): a
// note says so once it is late), the due date, the customer's LPO, the channel its sale posts on (with
// several), and "Is this sale already in your recorded sales?" when the invoice asks it (Q3; required
// before the issue, never preselected). Multi-column on a desktop, stacked on a phone with the amount
// to pay and Save at the foot. Saved, it opens on its page, where it is issued.

export function InvoiceEditor({
  invoice,
  today,
  startFrom,
}: {
  /** Absent: a new invoice from scratch. */
  invoice?: InvoiceDto
  today: string
  /** A new invoice: the ways to start from a quotation, an order or a sale, above the form. */
  startFrom?: ReactNode
}) {
  const { t } = useTranslation()
  const term = useTerminology()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  const beforeNavigate = useBeforeNavigate()
  const refresh = useRefreshInvoices()
  const savePictures = useSaveLinePictures('invoice_line')
  const billsOf = useBillsSummary()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const { channels } = useChannels()
  const scratch = invoice === undefined || isScratch(invoice)
  // A draft is worked out again on every save, with the business's VAT registration now.
  const vatRegistered = context?.capabilities.vat_registered === true
  const canSeeProducts =
    scratch &&
    context !== undefined &&
    hasModule(context, 'products') &&
    can(context, 'products.items.view')
  const canAddProducts = context !== undefined && can(context, 'products.items.manage')
  const { products: loaded } = useAllProducts(canSeeProducts)
  const create = useMutation(trpc.invoice.create.mutationOptions())
  const update = useMutation(trpc.invoice.update.mutationOptions())

  const [invoiceId] = useState(() => invoice?.id ?? newId())
  const [initial] = useState<InvoiceDraft>(() => {
    const draft = invoiceDraft(invoice, {
      locationId:
        context && !context.locationScope.all ? (context.locationScope.ids[0] ?? null) : null,
    })
    // A new invoice starts on the business's own way of selling when it has several channels.
    return invoice ? draft : { ...draft, channelId: defaultChannelId(channels) ?? '' }
  })
  const [draft, setDraft] = useState<InvoiceDraft>(initial)
  const [baseline, setBaseline] = useState<InvoiceDraft>(initial)
  const [roundedOn, setRoundedOn] = useState<string>(() => amountsKey(initial))
  const [added, setAdded] = useState<ProductDto[]>([])
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<I18nKey | null>(null)
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState(invoice?.version ?? null)
  const form = useRef<HTMLFormElement>(null)
  const phoneBar = useRef<HTMLDivElement>(null)

  const products = useMemo(
    () =>
      added.length === 0
        ? loaded
        : new Map<string, ProductDto>([...loaded, ...added.map((p) => [p.id, p] as const)]),
    [loaded, added],
  )
  const currency = (invoice?.currency ?? context?.currency ?? 'AED') as CurrencyCode
  const asks = invoice?.asksCountedElsewhere ?? false
  // Its sale posts when issued (Q3), so it needs its channel when the business has several.
  const counts = invoiceCounts({
    fromOrder: invoice?.orderId != null,
    fromSale: invoice?.saleId != null,
    isDeposit: invoice?.isDeposit ?? false,
    countedElsewhere:
      asks && draft.countedElsewhere !== '' ? draft.countedElsewhere === 'yes' : null,
  })
  const needsChannel =
    counts && channels.length > 1 && invoice?.orderId == null && invoice?.saleId == null
  const check = useMemo(
    () =>
      checkInvoice(draft, {
        currency,
        vatRegistered,
        today,
        products,
        sourced: !scratch,
        asks,
        needsChannel,
      }),
    [draft, currency, vatRegistered, today, products, scratch, asks, needsChannel],
  )
  const profile = context?.terminologyProfile ?? 'general'
  const shown = (error: FieldError | undefined): string | undefined =>
    error && (submitted || !INVOICE_MISSING.has(error.key))
      ? term(error.key, profile, error.values)
      : undefined
  const listHref = `/b/${businessId}/invoices`
  const formatMoney = (amount: string) => money(amount, currency)
  const set = (patch: Partial<InvoiceDraft>) => setDraft((d) => ({ ...d, ...patch }))

  function errorKey(error: unknown): I18nKey {
    return apiErrorCode(error) === 'conflict'
      ? 'documents.invoices.editor.conflict'
      : apiErrorKey(error)
  }

  /** Saves the draft (then its lines' pictures); its result once saved, null otherwise. */
  async function save(): Promise<InvoiceDto | null> {
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
          ? await update.mutateAsync({ id: invoiceId, version, ...fields })
          : await create.mutateAsync({ id: invoiceId, ...(fields as InvoiceFields) })
      setVersion(result.version)
      if (scratch) {
        try {
          if ((await savePictures(snapshot.lines)) > 0) {
            result = await queryClient.fetchQuery(trpc.invoice.get.queryOptions({ id: invoiceId }))
          }
        } catch (caught) {
          toast.error(t(caught instanceof PictureError ? caught.key : 'errors.internal'))
        }
      }
      setBaseline(snapshot)
      queryClient.setQueryData(trpc.invoice.get.queryKey({ id: invoiceId }), result)
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
      invoice ? t('documents.invoices.editor.saved') : t('documents.invoices.editor.created'),
    )
    await beforeNavigate()
    router.replace(`${listHref}/${result.id}`)
  }

  if (!context) return null
  const hasShownErrors = submitted && check.fields === null
  const kind = invoice?.kind ?? invoiceKindFor(vatRegistered)
  const tax = kind === 'tax_invoice'
  const supply = draft.supplyDate.trim() !== '' ? draft.supplyDate : today
  const late = tax && /^\d{4}-\d{2}-\d{2}$/.test(supply) && taxDocumentLate(supply, today)
  const roundingStale =
    scratch &&
    draft.roundTo.trim() !== '' &&
    check.rounding !== null &&
    amountsKey(draft) !== roundedOn
  const amounts = check.amounts
  const totals = scratch
    ? totalsOf({
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
    : totalsOf({
        currency,
        lines: invoice!.lines.map((line) => ({
          subtotal: line.subtotal,
          discount: line.lineDiscount,
          priceIncludesVat: line.priceIncludesVat,
          vatRate: line.vatRate,
        })),
        documentDiscount: subtractDecimals(
          invoice!.discountTotal,
          sumDecimals(invoice!.lines.map((line) => line.lineDiscount)),
        ),
        adjustment: invoice!.adjustment,
        net: invoice!.netTotal,
        rates: invoice!.vatRates,
        total: invoice!.total,
        difference: invoice!.roundingDifference,
        payable: invoice!.payable,
      })
  const payable = scratch ? (amounts?.payable ?? '0') : invoice!.payable
  const kindName = t(invoiceKindKey(kind))
  const title = invoice
    ? t('documents.invoices.editor.editTitle', { kind: kindName })
    : t('documents.invoices.editor.newTitle')

  const saveBar = (
    <div className="flex items-center gap-3 rounded-2xl bg-card/95 p-3 shadow-lg ring-1 ring-foreground/10 backdrop-blur">
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{t('documents.invoices.editor.toPay')}</p>
        <p data-running-total className="truncate font-semibold tabular-nums">
          {formatMoney(payable)}
        </p>
      </div>
      <Button type="submit" disabled={busy}>
        {busy
          ? t('status.saving')
          : invoice
            ? t('documents.invoices.editor.saveChanges')
            : t('documents.invoices.editor.save')}
      </Button>
    </div>
  )

  return (
    <PageContainer>
      <Link
        href={invoice ? `${listHref}/${invoice.id}` : listHref}
        className="-ms-2 -mt-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
        {invoice
          ? t('documents.invoices.view.draftTitle', { kind: kindName })
          : t('common.nav.invoices')}
      </Link>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        <p className="mt-1.5 max-w-2xl text-muted-foreground">
          {t(
            tax ? 'documents.invoices.editor.pageIntroTax' : 'documents.invoices.editor.pageIntro',
          )}
        </p>
      </header>
      {startFrom}

      <form
        ref={form}
        method="post"
        noValidate
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-x-6 xl:grid-cols-[minmax(0,1fr)_24rem]"
      >
        <div className="order-1 min-w-0 space-y-5 lg:col-start-1 lg:row-start-1">
          {serverError ? <FormAlert tone="error">{term(serverError, profile)}</FormAlert> : null}
          {hasShownErrors && !serverError ? (
            <FormAlert tone="error">{t('catalog.form.fixErrors')}</FormAlert>
          ) : null}
          {late ? (
            <FormAlert tone="error">
              <span data-invoice-late>
                {t('documents.invoices.editor.late', {
                  date: businessDate(taxDocumentDueBy(supply)),
                })}
              </span>
            </FormAlert>
          ) : null}

          <Panel title={t('documents.invoices.editor.forWhom')}>
            <div className="grid gap-4 sm:grid-cols-2">
              {scratch ? (
                <TextField
                  label={<Required>{t('documents.invoices.editor.customer')}</Required>}
                  error={shown(check.errors.customer)}
                  render={(a11y) => (
                    <CustomerPicker
                      value={draft.customer}
                      label={t('documents.invoices.editor.customer')}
                      invalid={a11y['aria-invalid']}
                      describedBy={a11y['aria-describedby']}
                      canAdd={mayAddCustomers(context)}
                      onChange={(customer) => set({ customer })}
                    />
                  )}
                  hint={
                    tax
                      ? (id) => (
                          <p id={id} className="text-sm text-muted-foreground">
                            {t('documents.invoices.editor.customerHintTax')}
                          </p>
                        )
                      : undefined
                  }
                />
              ) : (
                <div className="min-w-0 sm:col-span-2">
                  <p className="text-sm text-muted-foreground">
                    {t('documents.invoices.editor.customer')}
                  </p>
                  <p className="mt-0.5 font-medium break-words">
                    <bdi>{invoice!.customer.name}</bdi>
                  </p>
                  <p data-invoice-bills className="mt-2 text-sm">
                    {billsOf(invoice!)}
                  </p>
                </div>
              )}
              <TextField
                label={t('documents.invoices.editor.lpo')}
                autoComplete="off"
                dir="ltr"
                className="[unicode-bidi:plaintext]"
                value={draft.lpoReference}
                onChange={(event) => set({ lpoReference: event.target.value })}
                error={shown(check.errors.lpoReference)}
                hint={(id) => (
                  <p id={id} className="text-sm text-muted-foreground">
                    {t('documents.invoices.editor.lpoHint')}
                  </p>
                )}
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
                label={t('documents.invoices.editor.supplyDate')}
                type="date"
                max={today}
                value={draft.supplyDate}
                onChange={(event) => set({ supplyDate: event.target.value })}
                error={shown(check.errors.supplyDate)}
                hint={(id) => (
                  <p id={id} className="text-sm text-muted-foreground">
                    {t('documents.invoices.editor.supplyDateHint')}
                  </p>
                )}
              />
              <TextField
                label={t('documents.invoices.editor.dueDate')}
                type="date"
                min={draft.supplyDate || today}
                value={draft.dueDate}
                onChange={(event) => set({ dueDate: event.target.value })}
                error={shown(check.errors.dueDate)}
                hint={(id) => (
                  <p id={id} className="text-sm text-muted-foreground">
                    {t('documents.invoices.editor.dueDateHint')}
                  </p>
                )}
              />
              {scratch ? (
                <BranchField
                  context={context}
                  today={today}
                  value={draft.locationId}
                  onChange={(locationId) => set({ locationId })}
                />
              ) : null}
              {needsChannel ? (
                <TextField
                  label={<Required>{term('orders.editor.channel', profile)}</Required>}
                  error={shown(check.errors.channel)}
                  render={(a11y) => (
                    <NativeSelect
                      {...a11y}
                      data-invoice-channel
                      value={draft.channelId}
                      onChange={(event) => set({ channelId: event.target.value })}
                    >
                      <option value="" disabled>
                        {t('documents.invoices.editor.channelPick')}
                      </option>
                      {channels.map((channel) => (
                        <option key={channel.id} value={channel.id}>
                          {channel.name}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                  hint={(id) => (
                    <p id={id} className="text-sm text-muted-foreground">
                      {t('documents.invoices.editor.channelHint')}
                    </p>
                  )}
                />
              ) : null}
            </div>
          </Panel>

          {asks ? (
            <CountedQuestion
              value={draft.countedElsewhere}
              onChange={(countedElsewhere) => set({ countedElsewhere })}
            />
          ) : null}

          <Panel
            title={t('documents.invoices.editor.lines')}
            hint={
              scratch
                ? term('documents.invoices.editor.linesHint', profile)
                : t('documents.invoices.editor.sourcedLines')
            }
          >
            {scratch ? (
              <DocumentLines
                lines={draft.lines}
                setLines={(change) => setDraft((d) => ({ ...d, lines: change(d.lines) }))}
                products={products}
                onProductSaved={(product) => {
                  if (!loaded.has(product.id)) {
                    setAdded((current) => [...current.filter((p) => p.id !== product.id), product])
                  }
                }}
                errors={check.errors.lines}
                shown={shown}
                lineAmounts={check.lineAmounts}
                vatRegistered={vatRegistered}
                profile={profile}
                canSeeProducts={canSeeProducts}
                canAddProducts={canAddProducts}
                form={form}
                phoneBar={phoneBar}
                typedLabel={t('documents.invoices.editor.typed')}
              />
            ) : (
              <DocumentLineList
                lines={invoice!.lines}
                currency={currency}
                vat={invoice!.vatRegistered}
                typedLabel={null}
              />
            )}
          </Panel>
        </div>

        <aside className="order-2 min-w-0 space-y-5 lg:sticky lg:top-24 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start">
          <div className="hidden lg:block">{saveBar}</div>
          <Panel title={t('documents.invoices.editor.totalsTitle')}>
            {scratch ? (
              <TotalsEditor
                discountKind={draft.discountKind}
                discount={draft.discount}
                roundTo={draft.roundTo}
                discountError={shown(check.errors.discount)}
                roundToError={shown(check.errors.roundTo)}
                rounding={check.rounding}
                stale={roundingStale}
                carried={null}
                vatRegistered={vatRegistered}
                totals={totals}
                money={formatMoney}
                onDiscount={(next) => set({ discountKind: next.kind, discount: next.value })}
                onRoundTo={(roundTo) => {
                  set({ roundTo })
                  setRoundedOn(amountsKey(draft))
                }}
                onKeep={() => setRoundedOn(amountsKey(draft))}
                discountLabel={t('documents.invoices.editor.discount')}
                addDiscountLabel={t('documents.invoices.editor.addDiscount')}
              />
            ) : (
              <QuotationTotals
                values={totals}
                vatRegistered={invoice!.vatRegistered}
                money={formatMoney}
              />
            )}
          </Panel>
        </aside>

        <div className="order-3 min-w-0 space-y-5 lg:col-start-1 lg:row-start-2">
          <Panel
            title={t('documents.invoices.editor.wordsTitle')}
            hint={t('documents.invoices.editor.wordsHint')}
          >
            <div className="space-y-4">
              {(
                [
                  ['terms', 'termsPlaceholder', 3],
                  ['notes', 'notesPlaceholder', 2],
                ] as const
              ).map(([field, placeholder, rows]) => (
                <div key={field} className="space-y-1.5">
                  <p className="text-sm font-medium">{t(`documents.invoices.editor.${field}`)}</p>
                  <Textarea
                    aria-label={t(`documents.invoices.editor.${field}`)}
                    aria-invalid={Boolean(shown(check.errors[field]))}
                    className="[unicode-bidi:plaintext]"
                    rows={rows}
                    placeholder={t(`documents.invoices.editor.${placeholder}`)}
                    value={draft[field]}
                    onChange={(event) =>
                      set({ [field]: event.target.value } as Partial<InvoiceDraft>)
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
        </div>

        {/* The amount to pay and Save: at the foot of a phone's screen, at the top of the desktop's
            totals column. */}
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
