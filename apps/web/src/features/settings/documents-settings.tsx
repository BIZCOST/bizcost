'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import {
  DOCUMENT_FIRST_NUMBER_MAX,
  DOCUMENT_FOOTER_MAX_LENGTH,
  DOCUMENT_IMAGE_CONTENT_TYPES,
  DOCUMENT_IMAGE_MAX_BYTES,
  DOCUMENT_PREFIX_MAX_LENGTH,
  DOCUMENT_SIGNATORY_MAX_LENGTH,
  QUOTATION_TERMS_MAX_LENGTH,
  withoutControlCharacters,
  type BusinessProfileDto,
  type DocumentImageContentType,
  type DocumentImageKind,
  type DocumentSettingsDto,
} from '@bizcost/contracts'
import {
  DOCUMENT_ACCENT_KEYS,
  DOCUMENT_ACCENTS,
  DOCUMENT_NUMBER_PADDING_MAX,
  documentNumber,
  QUOTATION_VALID_DAYS_MAX,
  type DocumentAccent,
  type DocumentSeries,
} from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, ImageUpIcon, Loader2Icon, Trash2Icon } from 'lucide-react'
import Link from 'next/link'
import { useId, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { TextField } from '@/components/form/text-field'
import { sameData } from '@/components/form/unsaved'
import { useUnsavedChanges } from '@/components/form/unsaved-changes'
import { LoadError, SectionSkeleton } from '@/components/states/query-state'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Section } from '@/features/account/section'
import { hasModule } from '@/features/purchasing/data'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { shrinkPicture } from '@/features/documents/shrink-picture'
import { LetterheadPreview } from './letterhead-preview'
import { useProfile } from './profile-data'
import { isSectionVisible, sectionPath } from './sections'
import { SectionPage } from './settings-shell'

// Settings → Documents (M3 Step 7; Q25; the owner's document requests of 2026-10-16): the business's
// own letterhead, previewed as its quotations and invoices print it (its names, logo, accent colour,
// TRN and licence, contact lines, signature and stamp), the accent colour (a small palette, black
// included) and the logo's watermark; who signs the documents with their signature and the stamp
// (images uploaded once: PNG, JPEG or WebP, checked like the logo); each series' prefix and first
// number (set once, before its first document); the footer with the bank details, a new quotation's
// terms and how long it is valid; and whole amounts without ".00". The contact lines come from the
// business profile. For the Owner and the Admin, with Quotations or Invoices on.

interface SeriesDraft {
  readonly series: DocumentSeries
  readonly prefix: string
  readonly padding: string
  readonly firstNo: string
  readonly started: boolean
}

interface DocumentsDraft {
  readonly accent: DocumentAccent
  readonly watermark: boolean
  readonly wholeAmounts: boolean
  readonly signatory: string
  readonly footer: string
  readonly quotationTerms: string
  readonly quotationValidDays: string
  readonly series: readonly SeriesDraft[]
}

function draftOf(settings: DocumentSettingsDto): DocumentsDraft {
  return {
    accent: (DOCUMENT_ACCENT_KEYS as readonly string[]).includes(settings.accent)
      ? (settings.accent as DocumentAccent)
      : 'navy',
    watermark: settings.watermark,
    wholeAmounts: settings.wholeAmounts,
    signatory: settings.signatory ?? '',
    footer: settings.footer ?? '',
    quotationTerms: settings.quotationTerms ?? '',
    quotationValidDays: String(settings.quotationValidDays),
    series: settings.series.map((series) => ({
      series: series.series,
      prefix: series.prefix,
      padding: String(series.padding),
      firstNo: String(series.firstNo),
      started: series.started,
    })),
  }
}

const WHOLE = /^\d+$/

/** A whole number from `min` to `max` as typed, or null. */
function wholeNumber(value: string, min: number, max: number): number | null {
  const text = value.trim()
  if (!WHOLE.test(text)) return null
  const number = Number(text)
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : null
}

type Errors = Partial<
  Record<'signatory' | 'footer' | 'quotationTerms' | 'quotationValidDays', I18nKey>
> & {
  series: Partial<
    Record<DocumentSeries, Partial<Record<'prefix' | 'padding' | 'firstNo', I18nKey>>>
  >
}

function check(draft: DocumentsDraft): Errors {
  const errors: Errors = { series: {} }
  if (draft.signatory.trim().length > DOCUMENT_SIGNATORY_MAX_LENGTH) {
    errors.signatory = 'settings.documents.errors.tooLong'
  }
  if (draft.footer.trim().length > DOCUMENT_FOOTER_MAX_LENGTH) {
    errors.footer = 'settings.documents.errors.tooLong'
  }
  if (draft.quotationTerms.trim().length > QUOTATION_TERMS_MAX_LENGTH) {
    errors.quotationTerms = 'settings.documents.errors.tooLong'
  }
  if (wholeNumber(draft.quotationValidDays, 1, QUOTATION_VALID_DAYS_MAX) === null) {
    errors.quotationValidDays = 'settings.documents.errors.validDays'
  }
  for (const series of draft.series) {
    const own: Partial<Record<'prefix' | 'padding' | 'firstNo', I18nKey>> = {}
    if (series.prefix.length > DOCUMENT_PREFIX_MAX_LENGTH)
      own.prefix = 'settings.documents.errors.prefix'
    if (wholeNumber(series.padding, 0, DOCUMENT_NUMBER_PADDING_MAX) === null) {
      own.padding = 'settings.documents.errors.padding'
    }
    if (!series.started && wholeNumber(series.firstNo, 1, DOCUMENT_FIRST_NUMBER_MAX) === null) {
      own.firstNo = 'settings.documents.errors.firstNo'
    }
    if (Object.keys(own).length > 0) errors.series[series.series] = own
  }
  return errors
}

const hasErrors = (errors: Errors) =>
  Object.entries(errors).some(([key, value]) =>
    key === 'series' ? Object.keys(value as object).length > 0 : value !== undefined,
  )

/** The image kinds a signature or stamp may be (as the logo's; never SVG). */
function isImageType(type: string): type is DocumentImageContentType {
  return (DOCUMENT_IMAGE_CONTENT_TYPES as readonly string[]).includes(type)
}

/** The signature or the stamp: its picture, Upload / Replace and Remove. */
function ImageField({
  kind,
  url,
  onSaved,
}: {
  kind: DocumentImageKind
  url: string | null
  onSaved: (settings: DocumentSettingsDto) => void
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const input = useRef<HTMLInputElement>(null)
  const uploadUrl = useMutation(trpc.document.imageUploadUrl.mutationOptions())
  const setImage = useMutation(trpc.document.setImage.mutationOptions())
  const removeImage = useMutation(trpc.document.removeImage.mutationOptions())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<I18nKey | null>(null)

  async function upload(picked: File) {
    setError(null)
    // Drawn again at most 1,200 px on a side (D-297): a signature or stamp prints 20 to 42 mm wide.
    const file = await shrinkPicture(picked, 1200)
    if (!isImageType(file.type)) return setError('settings.documents.images.wrongType')
    if (file.size > DOCUMENT_IMAGE_MAX_BYTES) return setError('settings.documents.images.tooBig')
    setBusy(true)
    try {
      const target = await uploadUrl.mutateAsync({ kind, contentType: file.type })
      const response = await fetch(target.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type, 'x-upsert': 'false' },
        body: file,
      })
      if (!response.ok) {
        setError(
          response.status === 413
            ? 'settings.documents.images.tooBig'
            : response.status === 400 || response.status === 415
              ? 'settings.documents.images.wrongType'
              : 'errors.internal',
        )
        return
      }
      onSaved(await setImage.mutateAsync({ kind, path: target.path }))
      toast.success(t(`settings.documents.images.${kind}Saved`))
    } catch (caught) {
      setError(caught instanceof TypeError ? 'errors.network' : apiErrorKey(caught))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setError(null)
    setBusy(true)
    try {
      onSaved(await removeImage.mutateAsync({ kind }))
      toast.success(t(`settings.documents.images.${kind}Removed`))
    } catch (caught) {
      setError(apiErrorKey(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-w-0 space-y-2">
      <p className="text-sm font-medium">{t(`settings.documents.images.${kind}`)}</p>
      <div className="flex items-center gap-3">
        <span className="relative flex h-20 w-28 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-white">
          {url ? (
            // A signed URL of the business's private bucket: a plain image.
            <img
              src={url}
              alt={t(`settings.documents.images.${kind}`)}
              data-document-image={kind}
              className="size-full object-contain p-1"
            />
          ) : (
            <span className="px-2 text-center text-xs text-muted-foreground">
              {t('settings.documents.images.none')}
            </span>
          )}
          {busy ? (
            <span className="absolute inset-0 flex items-center justify-center bg-card/70">
              <Loader2Icon aria-hidden className="size-5 animate-spin text-primary" />
            </span>
          ) : null}
        </span>
        <div className="flex flex-wrap gap-2">
          <input
            ref={input}
            type="file"
            accept={DOCUMENT_IMAGE_CONTENT_TYPES.join(',')}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            data-document-image-input={kind}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void upload(file)
            }}
          />
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            <ImageUpIcon aria-hidden />
            {url ? t('settings.documents.images.replace') : t('settings.documents.images.upload')}
          </Button>
          {url ? (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              className="text-muted-foreground"
              aria-label={t(`settings.documents.images.${kind}Remove`)}
              onClick={() => void remove()}
            >
              <Trash2Icon aria-hidden />
              {t('settings.documents.images.remove')}
            </Button>
          ) : null}
        </div>
      </div>
      {error ? <FormAlert tone="error">{t(error)}</FormAlert> : null}
    </div>
  )
}

function DocumentsForm({
  businessId,
  settings,
  profile,
  onReload,
}: {
  businessId: string
  settings: DocumentSettingsDto
  profile: BusinessProfileDto
  onReload: () => void
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: context } = useBusinessContext()
  const update = useMutation(trpc.document.updateSettings.mutationOptions())
  const letterheadId = useId()
  const watermarkId = useId()
  const wholeId = useId()
  const [initial, setInitial] = useState(() => draftOf(settings))
  const [draft, setDraft] = useState(initial)
  const [submitted, setSubmitted] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [busy, setBusy] = useState(false)
  const errors = check(draft)
  const shown = (key: I18nKey | undefined, values?: Record<string, unknown>) =>
    key && submitted ? t(key, values) : undefined
  const set = (patch: Partial<DocumentsDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const setSeries = (series: DocumentSeries, patch: Partial<SeriesDraft>) =>
    setDraft((d) => ({
      ...d,
      series: d.series.map((item) => (item.series === series ? { ...item, ...patch } : item)),
    }))

  const saved = (next: DocumentSettingsDto) => {
    queryClient.setQueryData(trpc.document.settings.queryKey(), next)
    void queryClient.invalidateQueries({ queryKey: trpc.business.profile.queryKey() })
  }

  /** Saves the form; true once saved. */
  async function persist(): Promise<boolean> {
    setSubmitted(true)
    setConflict(false)
    if (hasErrors(errors)) return false
    setBusy(true)
    try {
      const next = await update.mutateAsync({
        version: settings.version,
        accent: draft.accent,
        watermark: draft.watermark,
        wholeAmounts: draft.wholeAmounts,
        signatory: draft.signatory.trim() || null,
        footer: draft.footer.trim() || null,
        quotationTerms: draft.quotationTerms.trim() || null,
        quotationValidDays: Number(draft.quotationValidDays.trim()),
        series: draft.series.map((series) => ({
          series: series.series,
          prefix: withoutControlCharacters(series.prefix),
          padding: Number(series.padding.trim()),
          ...(series.started ? {} : { firstNo: Number(series.firstNo.trim()) }),
        })),
      })
      saved(next)
      const fresh = draftOf(next)
      setInitial(fresh)
      setDraft(fresh)
      setSubmitted(false)
      toast.success(t('settings.documents.saved'))
      return true
    } catch (caught) {
      if (apiErrorCode(caught) === 'conflict') setConflict(true)
      else toast.error(t(apiErrorKey(caught)))
      return false
    } finally {
      setBusy(false)
    }
  }

  const dirty = !sameData(draft, initial)
  useUnsavedChanges({ dirty, save: persist })

  function submit(event: FormEvent) {
    event.preventDefault()
    void persist()
  }

  if (!context) return null
  const letterhead = profile.letterhead
  // Each series with its module: quotations, orders, and invoices with their credit notes (M3 Step 8).
  const seriesShown = draft.series.filter((series) =>
    series.series === 'quotation'
      ? hasModule(context, 'quotations')
      : series.series === 'order'
        ? hasModule(context, 'orders')
        : hasModule(context, 'invoices'),
  )
  // A business that prints only statements (Customers with Payments, Release B) signs nothing and
  // quotes nothing: its letterhead, numbers and bank details only.
  const quoting = hasModule(context, 'quotations')
  const invoicing = hasModule(context, 'invoices')
  const issuing = quoting || invoicing
  // Each line in the words of what the business prints (Release B review): the signature on its
  // quotations, invoices and credit notes, the preview titled by its main document, no TRN without
  // VAT registration.
  const signatureDescription = quoting
    ? invoicing
      ? 'settings.documents.signature.descriptions.quotationsInvoices'
      : 'settings.documents.signature.descriptions.quotations'
    : 'settings.documents.signature.descriptions.invoices'
  const previewTitle = quoting
    ? 'settings.documents.preview.titles.quotation'
    : invoicing
      ? profile.vatRegistered
        ? 'settings.documents.preview.titles.taxInvoice'
        : 'settings.documents.preview.titles.invoice'
      : 'settings.documents.preview.titles.statement'

  return (
    <form method="post" noValidate onSubmit={submit} className="space-y-6">
      {/* The letterhead takes the section's whole width: the page drawn large enough to read. */}
      <section
        aria-labelledby={letterheadId}
        className="rounded-2xl bg-card p-5 shadow-sm ring-1 ring-foreground/[0.06] sm:p-6"
      >
        <h2 id={letterheadId} className="text-base font-semibold">
          {t('settings.documents.letterhead.title')}
        </h2>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          {t('settings.documents.letterhead.description')}
        </p>
        <div className="mt-5 grid items-start gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <LetterheadPreview
            title={t(previewTitle)}
            data={{
              locale: profile.defaultLocale,
              accent: DOCUMENT_ACCENTS[draft.accent],
              logoUrl: profile.logoUrl,
              watermark: draft.watermark,
              nameEn: profile.legalName,
              nameAr: profile.legalNameAr,
              trn: profile.vatRegistered ? profile.trn : null,
              tradeLicence: letterhead.tradeLicenceNo,
              phones: [letterhead.phone, letterhead.phone2].filter((p): p is string => Boolean(p)),
              email: letterhead.email,
              address: settings.letterheadAddress,
              // A statement is not signed: no signature on the letterhead of one that prints only those.
              signatory: issuing ? draft.signatory.trim() || null : null,
              signatureUrl: issuing ? settings.signatureUrl : null,
              stampUrl: issuing ? settings.stampUrl : null,
            }}
          />
          <div className="min-w-0 space-y-5">
            <fieldset>
              <legend className="text-sm font-medium">
                {t('settings.documents.accent.label')}
              </legend>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {t('settings.documents.accent.hint')}
              </p>
              <div className="mt-3 flex flex-wrap gap-2.5">
                {DOCUMENT_ACCENT_KEYS.map((accent) => (
                  <label
                    key={accent}
                    className="relative"
                    title={t(`settings.documents.accent.colors.${accent}`)}
                  >
                    <input
                      type="radio"
                      name="document-accent"
                      value={accent}
                      checked={draft.accent === accent}
                      onChange={() => set({ accent })}
                      className="peer sr-only"
                      aria-label={t(`settings.documents.accent.colors.${accent}`)}
                    />
                    <span
                      data-accent-swatch={accent}
                      className={cn(
                        'flex size-11 cursor-pointer items-center justify-center rounded-full ring-2 ring-transparent ring-offset-2 ring-offset-card transition',
                        'peer-checked:ring-foreground peer-focus-visible:ring-ring',
                      )}
                      style={{ background: DOCUMENT_ACCENTS[accent] }}
                    >
                      {draft.accent === accent ? (
                        <CheckIcon aria-hidden className="size-5 text-white" />
                      ) : null}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex items-start justify-between gap-4 rounded-xl border bg-background/60 p-4">
              <div className="min-w-0">
                <p id={`${watermarkId}-label`} className="font-medium">
                  {t('settings.documents.watermark.label')}
                </p>
                <p id={`${watermarkId}-hint`} className="mt-0.5 text-sm text-muted-foreground">
                  {profile.logoUrl
                    ? t('settings.documents.watermark.hint')
                    : t('settings.documents.watermark.noLogo')}
                </p>
              </div>
              <Switch
                checked={draft.watermark}
                onCheckedChange={(watermark) => set({ watermark })}
                aria-labelledby={`${watermarkId}-label`}
                aria-describedby={`${watermarkId}-hint`}
                className="mt-1"
              />
            </div>
            <div className="rounded-xl border bg-background/60 p-4 text-sm">
              <p className="font-medium">{t('settings.documents.contacts.title')}</p>
              <p className="mt-0.5 text-muted-foreground">
                {profile.vatRegistered
                  ? t('settings.documents.contacts.hint')
                  : t('settings.documents.contacts.hintNoTrn')}
              </p>
              <Link
                href={sectionPath(businessId, 'business')}
                className="mt-2 inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline"
              >
                {t('settings.documents.contacts.action')}
              </Link>
            </div>
          </div>
        </div>
      </section>

      {issuing ? (
        <Section
          title={t('settings.documents.signature.title')}
          description={t(signatureDescription)}
        >
          <div className="space-y-5">
            <TextField
              label={t('settings.documents.signature.signatory')}
              autoComplete="name"
              dir="auto"
              className="[unicode-bidi:plaintext]"
              value={draft.signatory}
              onChange={(event) => set({ signatory: event.target.value })}
              error={shown(errors.signatory, { count: DOCUMENT_SIGNATORY_MAX_LENGTH })}
            />
            <div className="grid gap-5 sm:grid-cols-2">
              <ImageField kind="signature" url={settings.signatureUrl} onSaved={saved} />
              <ImageField kind="stamp" url={settings.stampUrl} onSaved={saved} />
            </div>
            <p className="text-sm text-muted-foreground">{t('settings.documents.images.hint')}</p>
          </div>
        </Section>
      ) : null}

      {seriesShown.length > 0 ? (
        <Section
          title={t('settings.documents.numbers.title')}
          description={t('settings.documents.numbers.description')}
        >
          <div className="space-y-4">
            {seriesShown.map((series) => {
              const own = errors.series[series.series] ?? {}
              const padding = wholeNumber(series.padding, 0, DOCUMENT_NUMBER_PADDING_MAX)
              const first = wholeNumber(series.firstNo, 1, DOCUMENT_FIRST_NUMBER_MAX)
              const next = settings.series.find((item) => item.series === series.series)
              const example =
                padding !== null && (series.started ? next : first !== null)
                  ? documentNumber(
                      withoutControlCharacters(series.prefix),
                      series.started ? next!.nextNo : first!,
                      padding,
                    )
                  : null
              return (
                <fieldset
                  key={series.series}
                  data-series={series.series}
                  className="rounded-xl border bg-background/60 p-4"
                >
                  <legend className="sr-only">
                    {t(`settings.documents.numbers.series.${series.series}`)}
                  </legend>
                  <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-medium">
                      {t(`settings.documents.numbers.series.${series.series}`)}
                    </p>
                    {example ? (
                      <p className="text-sm text-muted-foreground">
                        {t('settings.documents.numbers.next')}{' '}
                        <bdi
                          dir="ltr"
                          data-series-example
                          className="font-semibold text-foreground"
                        >
                          {example}
                        </bdi>
                      </p>
                    ) : null}
                  </div>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <TextField
                      label={t('settings.documents.numbers.prefix')}
                      dir="ltr"
                      autoComplete="off"
                      spellCheck={false}
                      value={series.prefix}
                      onChange={(event) => setSeries(series.series, { prefix: event.target.value })}
                      error={shown(own.prefix, { count: DOCUMENT_PREFIX_MAX_LENGTH })}
                    />
                    <TextField
                      label={t('settings.documents.numbers.padding')}
                      inputMode="numeric"
                      dir="ltr"
                      autoComplete="off"
                      className="tabular-nums rtl:text-end"
                      value={series.padding}
                      onChange={(event) =>
                        setSeries(series.series, { padding: event.target.value })
                      }
                      error={shown(own.padding, { max: DOCUMENT_NUMBER_PADDING_MAX })}
                    />
                    <TextField
                      label={t('settings.documents.numbers.firstNo')}
                      inputMode="numeric"
                      dir="ltr"
                      autoComplete="off"
                      className="tabular-nums rtl:text-end"
                      readOnly={series.started}
                      value={series.firstNo}
                      onChange={(event) =>
                        setSeries(series.series, { firstNo: event.target.value })
                      }
                      error={shown(own.firstNo)}
                      hint={(id) => (
                        <p id={id} className="text-sm text-muted-foreground">
                          {series.started
                            ? t('settings.documents.numbers.started')
                            : t('settings.documents.numbers.firstNoHint')}
                        </p>
                      )}
                    />
                  </div>
                </fieldset>
              )
            })}
          </div>
        </Section>
      ) : null}

      <Section
        title={
          quoting
            ? t('settings.documents.footer.title')
            : t('settings.documents.footer.titleNoTerms')
        }
        description={
          quoting
            ? t('settings.documents.footer.description')
            : t('settings.documents.footer.descriptionNoTerms')
        }
      >
        <div className="space-y-5">
          {(
            [
              [
                'footer',
                'settings.documents.footer.bank',
                'settings.documents.footer.bankPlaceholder',
                DOCUMENT_FOOTER_MAX_LENGTH,
                4,
              ],
              [
                'quotationTerms',
                'settings.documents.footer.terms',
                'settings.documents.footer.termsPlaceholder',
                QUOTATION_TERMS_MAX_LENGTH,
                5,
              ],
            ] as const
          )
            .filter(([field]) => quoting || field !== 'quotationTerms')
            .map(([field, label, placeholder, max, rows]) => (
              <div key={field} className="space-y-1.5">
                <p className="text-sm font-medium">{t(label)}</p>
                <Textarea
                  aria-label={t(label)}
                  aria-invalid={Boolean(shown(errors[field]))}
                  dir="auto"
                  rows={rows}
                  className="[unicode-bidi:plaintext]"
                  placeholder={t(placeholder)}
                  value={draft[field]}
                  onChange={(event) =>
                    set({ [field]: event.target.value } as Partial<DocumentsDraft>)
                  }
                />
                {shown(errors[field], { count: max }) ? (
                  <p role="alert" className="text-sm text-destructive">
                    {shown(errors[field], { count: max })}
                  </p>
                ) : null}
              </div>
            ))}
          {quoting ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label={t('settings.documents.footer.validDays')}
                inputMode="numeric"
                dir="ltr"
                autoComplete="off"
                className="tabular-nums rtl:text-end"
                value={draft.quotationValidDays}
                onChange={(event) => set({ quotationValidDays: event.target.value })}
                error={shown(errors.quotationValidDays, { max: QUOTATION_VALID_DAYS_MAX })}
                hint={(id) => (
                  <p id={id} className="text-sm text-muted-foreground">
                    {t('settings.documents.footer.validDaysHint')}
                  </p>
                )}
              />
            </div>
          ) : null}
          {issuing ? (
            <div className="flex items-start justify-between gap-4 rounded-xl border bg-background/60 p-4">
              <div className="min-w-0">
                <p id={`${wholeId}-label`} className="font-medium">
                  {t('settings.documents.whole.label')}
                </p>
                <p id={`${wholeId}-hint`} className="mt-0.5 text-sm text-muted-foreground">
                  {t('settings.documents.whole.hint')}
                </p>
              </div>
              <Switch
                checked={draft.wholeAmounts}
                onCheckedChange={(wholeAmounts) => set({ wholeAmounts })}
                aria-labelledby={`${wholeId}-label`}
                aria-describedby={`${wholeId}-hint`}
                className="mt-1"
              />
            </div>
          ) : null}
        </div>
      </Section>

      {conflict ? (
        <FormAlert tone="error">
          <p>{t('settings.documents.conflict')}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2 h-9 bg-card"
            onClick={onReload}
          >
            {t('settings.business.reload')}
          </Button>
        </FormAlert>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={!dirty || busy}
          onClick={() => setDraft(initial)}
        >
          {t('actions.cancel')}
        </Button>
        <Button type="submit" className="min-w-28" disabled={!dirty || busy}>
          {busy ? t('status.saving') : t('settings.documents.save')}
        </Button>
      </div>
    </form>
  )
}

export function DocumentsSettings({ businessId }: { businessId: string }) {
  const trpc = useTRPC()
  const { data: context } = useBusinessContext()
  const visible = context ? isSectionVisible(context, 'documents') : false
  const settings = useQuery({ ...trpc.document.settings.queryOptions(), enabled: visible })
  const profile = useProfile(visible)
  const error = settings.error ?? profile.error
  return (
    <SectionPage businessId={businessId} section="documents">
      {error && (!settings.data || !profile.data) ? (
        <LoadError
          error={error}
          onRetry={() => {
            void settings.refetch()
            void profile.refetch()
          }}
        />
      ) : !settings.data || !profile.data ? (
        <SectionSkeleton cards={3} />
      ) : (
        <DocumentsForm
          businessId={businessId}
          settings={settings.data}
          profile={profile.data}
          onReload={() => {
            void settings.refetch()
            void profile.refetch()
          }}
        />
      )}
    </SectionPage>
  )
}
