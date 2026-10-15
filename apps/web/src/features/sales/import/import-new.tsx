'use client'

import { apiErrorCode, apiErrorKey, apiErrorNames, useTRPC } from '@bizcost/app-core'
import { IMPORT_ROWS_CHUNK, type CreateImportInput } from '@bizcost/contracts'
import {
  headerFingerprintSource,
  IMPORT_ERRORS_KEPT,
  importDate,
  importSales,
  mappingError,
  newId,
  shapeOf,
  vatQuestionAsked,
  type DateOrder,
  type ImportField,
  type ImportMapping,
  type ImportRowErrorCode,
} from '@bizcost/domain'
import { formatDate, type I18nKey } from '@bizcost/i18n'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  DownloadIcon,
  FileSpreadsheetIcon,
  FileUpIcon,
  LockKeyholeIcon,
  ShieldCheckIcon,
  UploadIcon,
} from 'lucide-react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { FormAlert } from '@/components/form/form-alert'
import { useUnsavedChanges } from '@/components/form/unsaved-changes'
import { ModuleGate } from '@/components/shell/module-gate'
import { PageContainer } from '@/components/shell/page-container'
import { SectionSkeleton } from '@/components/states/query-state'
import { StatePanel } from '@/components/states/state-panel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { useBusinessDate, useMoney } from '@/features/documents/amounts'
import { Panel } from '@/features/documents/panel'
import { can } from '@/features/settings/sections'
import { useLocale } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { defaultChannelId, useBooks, useChannels, useSaleLocations } from '../data'
import { columnName } from './column-name'
import { importHref, mayImport, seesCosts, useRefreshImports } from './data'
import { FileReadError, readImportFile, sha256Hex, type FileRead } from './read-file'
import { downloadTemplate } from './templates'
import {
  amountOf,
  chunksOf,
  columnLetter,
  columnsOf,
  datesOf,
  mappingDto,
  periodError,
  profileMapping,
  readWith,
  rowsToSend,
  startOf,
  stepsFor,
  withAmount,
  withField,
  type AmountKind,
  type WizardStep,
} from './wizard'

// Import sales from a file (M3 Step 4; the owner's answer Q15 of D-218), the first steps: 1 the file,
// the channel and the branch; 2 the columns, found from their names and confirmed (one click for the
// columns chosen last time for the same layout); 3 "These sales are for: a day / from–to" (a summary
// without a day column); 4 "Do these amounts include VAT?" (a VAT-registered business whose file has
// no column before VAT and no tax column; never preselected). The file is read on this device and
// never uploaded: only its rows summed by day and item go to the API, in chunks of 2,500, with its
// SHA-256 (the same file twice is refused) and the fingerprint of its headers. Then the import's own
// page settles the names (5) and shows the preview to finalize (6). Leaving with a file read asks
// first (D-161); "Save" makes the draft, to be continued from the Imports list. A time written with
// its offset from UTC is read as the business's day (its time zone); a fee column is offered only to
// a member who manages the channel's statements and sees costs (it becomes a statement, D-260).

/** A file read, and what the person chose for it. */
interface Choice {
  headerRow: number
  mapping: ImportMapping
  dateOrder: DateOrder
  ambiguousDays: boolean
  /** The layout's columns were chosen before (a saved profile fits). */
  saved: { headerRow: number; mapping: ImportMapping; dateOrder: DateOrder } | null
  usingSaved: boolean
  fingerprint: string
}

const ROW_ERRORS: Readonly<Record<ImportRowErrorCode, I18nKey>> = {
  name_missing: 'sales.import.rowErrors.name_missing',
  date_missing: 'sales.import.rowErrors.date_missing',
  date_invalid: 'sales.import.rowErrors.date_invalid',
  number_invalid: 'sales.import.rowErrors.number_invalid',
  qty_too_large: 'sales.import.rowErrors.qty_too_large',
}

/** A choice of radio buttons in one group (cards on a phone). */
function Choices<T extends string>({
  legend,
  value,
  options,
  onChange,
  name,
}: {
  legend: string
  value: T | null
  options: readonly { value: T; label: string; hint?: string }[]
  onChange: (value: T) => void
  name: string
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 font-medium">{legend}</legend>
      {options.map((option) => (
        <label
          key={option.value}
          className={cn(
            'flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors',
            value === option.value ? 'border-primary bg-accent/40' : 'hover:bg-muted/40',
          )}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className="mt-1 size-4 accent-primary"
          />
          <span className="min-w-0">
            <span className="block font-medium">{option.label}</span>
            {option.hint ? (
              <span className="mt-0.5 block text-sm leading-relaxed text-muted-foreground">
                {option.hint}
              </span>
            ) : null}
          </span>
        </label>
      ))}
    </fieldset>
  )
}

/** A field's column picker: "Not in the file", or one of the file's columns ("B · Qty"). */
function ColumnSelect({
  id,
  label,
  hint,
  value,
  columns,
  optional,
  onChange,
}: {
  id: string
  label: string
  hint?: string
  value: number | undefined
  columns: readonly { index: number; header: string }[]
  optional: boolean
  onChange: (column: number | null) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {optional ? (
          <span className="font-normal text-muted-foreground"> {t('sales.import.optional')}</span>
        ) : null}
      </label>
      <NativeSelect
        id={id}
        data-field={id}
        value={value === undefined ? '' : String(value)}
        onChange={(event) =>
          onChange(event.target.value === '' ? null : Number(event.target.value))
        }
      >
        <option value="">{t('sales.import.columns.none')}</option>
        {columns.map((column) => (
          <option key={column.index} value={column.index}>
            {column.header
              ? t('sales.import.columns.named', {
                  letter: columnLetter(column.index),
                  header: column.header,
                })
              : t('sales.import.columns.unnamed', { letter: columnLetter(column.index) })}
          </option>
        ))}
      </NativeSelect>
      {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

/** "Don't have a file? Download a template" (CSV with a byte-order mark, in the page's language). */
export function Templates({ kinds }: { kinds: readonly ('daily' | 'lines' | 'statement')[] }) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{t('sales.import.templates.intro')}</p>
      <div className="flex flex-wrap gap-2">
        {kinds.map((kind) => (
          <Button
            key={kind}
            type="button"
            variant="outline"
            size="sm"
            data-template={kind}
            onClick={() => downloadTemplate(kind, locale === 'ar' ? 'ar' : 'en')}
          >
            <DownloadIcon aria-hidden />
            {t(`sales.import.templates.${kind}`)}
          </Button>
        ))}
      </div>
    </div>
  )
}

function NewImport() {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const router = useRouter()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const { locale } = useLocale()
  const refresh = useRefreshImports()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const books = useBooks()
  const today = books.data?.today ?? new Date().toISOString().slice(0, 10)
  const timeZone = books.data?.timeZone ?? null
  const { channels, query: channelsQuery } = useChannels()
  const profiles = useQuery({
    ...trpc.importProfile.list.queryOptions(),
    enabled: context ? mayImport(context) : false,
  })
  const create = useMutation(trpc.saleImport.create.mutationOptions())
  const addRows = useMutation(trpc.saleImport.addRows.mutationOptions())
  const ids = useId()
  const fileInput = useRef<HTMLInputElement>(null)
  const [importId] = useState(() => newId())
  const [file, setFile] = useState<FileRead | null>(null)
  const [picked, setPicked] = useState<File | null>(null)
  const [reading, setReading] = useState(false)
  const [readError, setReadError] = useState<I18nKey | null>(null)
  const [channelChoice, setChannelChoice] = useState<string | null>(null)
  const [locationChoice, setLocationChoice] = useState<string | null>(null)
  const [choice, setChoice] = useState<Choice | null>(null)
  const [step, setStep] = useState<WizardStep>('file')
  const [periodKind, setPeriodKind] = useState<'day' | 'range'>('day')
  const [day, setDay] = useState<string | null>(null)
  const [from, setFrom] = useState<string | null>(null)
  const [to, setTo] = useState<string | null>(null)
  const [vatAnswer, setVatAnswer] = useState<boolean | null>(null)
  const [sending, setSending] = useState<{ done: number; total: number } | null>(null)
  const [sendError, setSendError] = useState<ReactNode>(null)
  const [done, setDone] = useState(false)
  const [more, setMore] = useState<boolean | null>(null)

  const channelId = channelChoice ?? defaultChannelId(channels) ?? channels[0]?.id ?? null
  const locations = useSaleLocations(context, today, channelId)
  const locationId =
    locationChoice ??
    locations?.find((location) => location.isDefault)?.id ??
    locations?.[0]?.id ??
    null
  const vatRegistered = context?.capabilities.vat_registered === true
  // A fee column becomes the channel's statement: sent by who manages statements and sees costs.
  const feesAllowed = context ? seesCosts(context) && can(context, 'sales.channels.manage') : false
  const theDay = day ?? today
  const period =
    choice && shapeOf(choice.mapping) === 'summary'
      ? periodKind === 'day'
        ? { from: theDay, to: theDay }
        : { from: from ?? '', to: to ?? '' }
      : null
  const periodProblem = period ? periodError(period.from, period.to, today) : null
  const steps = choice
    ? stepsFor(choice.mapping, vatRegistered)
    : (['file', 'columns'] as WizardStep[])
  const stepNumber = steps.indexOf(step) + 1
  const columns = useMemo(
    () => (file && choice ? columnsOf(file.rows, choice.headerRow) : []),
    [file, choice],
  )
  const mapping = choice?.mapping ?? {}
  const problem = choice ? mappingError(mapping) : null
  const periodFrom = period?.from ?? null
  const periodTo = period?.to ?? null
  const read = useMemo(() => {
    if (!file || !choice || mappingError(choice.mapping) !== null) return null
    const days =
      periodFrom !== null && periodTo !== null ? { from: periodFrom, to: periodTo } : null
    if (days && periodError(days.from, days.to, today) !== null) return null
    return readWith(file.rows, {
      headerRow: choice.headerRow,
      mapping: choice.mapping,
      dateOrder: choice.dateOrder,
      vatRegistered,
      // The amounts read the same either way; the answer itself is required before sending.
      amountsIncludeVat: vatAnswer ?? false,
      period: days,
      timeZone,
    })
  }, [file, choice, periodFrom, periodTo, today, vatRegistered, vatAnswer, timeZone])
  const vatMissing =
    choice !== null && vatQuestionAsked(choice.mapping, vatRegistered) && vatAnswer === null

  // A file read and not sent yet: leaving asks first (D-161); "Save" makes the draft.
  const ready = Boolean(file && choice && read && read.problem === null && channelId && !vatMissing)
  useUnsavedChanges({
    dirty: file !== null && !done,
    save: async () => (ready ? send() : false),
  })

  if (!context) return null
  if (!mayImport(context)) {
    return (
      <PageContainer>
        <StatePanel
          icon={LockKeyholeIcon}
          title={t('states.forbidden.title')}
          body={t('sales.import.notOpen')}
          documentTitle={`${t('states.forbidden.title')} · ${t('appName')}`}
        >
          <Button asChild variant="outline" size="lg">
            <Link href={`/b/${businessId}/sales`}>{t('common.nav.sales')}</Link>
          </Button>
        </StatePanel>
      </PageContainer>
    )
  }

  async function pick(next: File, sheet: string | null = null) {
    setReading(true)
    setReadError(null)
    setSendError(null)
    try {
      const result = await readImportFile(next, sheet)
      const start = startOf(result.rows)
      const fingerprint = await sha256Hex(
        new TextEncoder().encode(headerFingerprintSource(result.rows[start.headerRow] ?? [])),
      )
      const profile = profiles.data?.items.find((p) => p.fingerprint === fingerprint)
      const saved = profileMapping(profile, result.rows)
      setPicked(next)
      setFile(result)
      setChoice({
        ...start,
        mapping: vatRegistered ? start.mapping : asWhole(start.mapping),
        saved,
        usingSaved: false,
        fingerprint,
      })
      setVatAnswer(null)
    } catch (error) {
      setReadError(
        error instanceof FileReadError
          ? (`sales.import.readErrors.${error.code}` as I18nKey)
          : 'sales.import.readErrors.unreadable',
      )
    } finally {
      setReading(false)
    }
  }

  /** Without VAT registration a column "before VAT" is simply the sales (the same amount). */
  function asWhole(next: ImportMapping): ImportMapping {
    return next.net === undefined ? next : withAmount(next, next.net, 'total')
  }

  function update(next: Partial<Choice>) {
    setChoice((current) => (current ? { ...current, ...next } : current))
  }

  function setField(field: ImportField, column: number | null) {
    if (!choice) return
    update({ mapping: withField(choice.mapping, field, column), usingSaved: false })
  }

  function useSaved() {
    if (!choice?.saved) return
    update({ ...choice.saved, usingSaved: true })
  }

  /** Makes the draft and sends its rows (the API takes 2,500 a call); then its page settles names. */
  async function send(): Promise<boolean> {
    if (!file || !choice || !read || read.problem !== null || !channelId || vatMissing) return false
    setSendError(null)
    const rows = rowsToSend(read)
    const chunks = chunksOf(rows, IMPORT_ROWS_CHUNK)
    setSending({ done: 0, total: rows.length })
    try {
      const input: CreateImportInput = {
        id: importId,
        channelId,
        locationId,
        fileName: file.name.slice(0, 255),
        fileHash: file.hash,
        fingerprint: choice.fingerprint,
        shape: read.shape,
        periodFrom: read.period!.from,
        periodTo: read.period!.to,
        mapping: mappingDto(file.rows, choice.headerRow, choice.mapping, choice.dateOrder),
        amountsIncludeVat: read.amountsIncludeVat,
        rowsRead: read.rowsRead,
        rowsLeftOut: read.rowsLeftOut,
        errors: read.errors.slice(0, IMPORT_ERRORS_KEPT),
        feesTotal: feesAllowed ? read.fees : null,
        rowCount: rows.length,
      }
      await create.mutateAsync(input)
      let sent = 0
      for (const chunk of chunks) {
        await addRows.mutateAsync({ id: importId, rows: chunk })
        sent += chunk.length
        setSending({ done: sent, total: rows.length })
      }
      setDone(true)
      await refresh()
      router.replace(importHref(businessId, importId))
      return true
    } catch (error) {
      setSending(null)
      if (apiErrorCode(error) === 'already_imported') {
        // Its day, its id when it may be opened ('' otherwise: never named, D-231), its status.
        const [at, otherId, status] = apiErrorNames(error)
        const date = at ? businessDate(at.slice(0, 10)) : ''
        const draft = status === 'draft'
        setSendError(
          <>
            {!otherId
              ? t('sales.import.alreadyImportedHidden', { date })
              : draft
                ? t('sales.import.alreadyImportedDraft', { date })
                : t('sales.import.alreadyImported', { date })}{' '}
            {otherId ? (
              <Link
                href={importHref(businessId, otherId)}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                {draft ? t('sales.import.openThatDraft') : t('sales.import.openThatImport')}
              </Link>
            ) : null}
          </>,
        )
      } else {
        setSendError(t(apiErrorKey(error)))
      }
      return false
    }
  }

  const back = (
    <Link
      href={`/b/${businessId}/sales?view=imports`}
      className="-ms-2 -mt-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:underline"
    >
      <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
      {t('sales.import.backToImports')}
    </Link>
  )

  const canNext =
    step === 'file'
      ? Boolean(file && channelId)
      : step === 'columns'
        ? problem === null
        : step === 'period'
          ? periodProblem === null
          : vatAnswer !== null
  const last = steps.at(-1) === step
  const next = () => {
    const index = steps.indexOf(step)
    if (!last) setStep(steps[index + 1]!)
  }
  const previous = () => {
    const index = steps.indexOf(step)
    if (index > 0) setStep(steps[index - 1]!)
  }

  const amount = amountOf(mapping)
  // "More columns" starts open when one of them is in use.
  const moreShown =
    more ??
    [mapping.code, mapping.variant, mapping.tax, mapping.fee, mapping.order].some(
      (column) => column !== undefined,
    )
  const amountKinds: readonly AmountKind[] = vatRegistered
    ? ['net', 'total', 'price']
    : ['total', 'price']
  const ambiguousExample =
    file && choice && mapping.date !== undefined && choice.ambiguousDays
      ? datesOf(file.rows, choice.headerRow, mapping).find(
          (cell): cell is string =>
            typeof cell === 'string' && importDate(cell, 'dmy').ok && importDate(cell, 'mdy').ok,
        )
      : undefined
  // "What we read": an amount known to be before VAT says so (a VAT-registered business's column
  // before VAT, a tax column, or the answer "No"), and a summary's days wait for "These sales are for".
  const summaryChoices = {
    beforeVat: vatRegistered && (!vatQuestionAsked(mapping, vatRegistered) || vatAnswer === false),
    periodPending: shapeOf(mapping) === 'summary' && steps.indexOf(step) < steps.indexOf('period'),
  }

  return (
    <PageContainer>
      {back}
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {t('sales.import.title')}
        </h1>
        <p className="mt-1.5 max-w-2xl text-muted-foreground">{t('sales.import.intro')}</p>
      </header>

      <div className="max-w-3xl space-y-5">
        <ol aria-label={t('sales.import.stepsLabel')} className="flex flex-wrap gap-2 text-sm">
          {[...steps, 'names' as const, 'preview' as const].map((s, index) => (
            <li
              key={s}
              aria-current={s === step ? 'step' : undefined}
              className={cn(
                'rounded-full px-3 py-1',
                s === step
                  ? 'bg-primary text-primary-foreground'
                  : index < stepNumber - 1
                    ? 'bg-accent text-primary'
                    : 'bg-muted text-muted-foreground',
              )}
            >
              {index + 1}. {t(`sales.import.steps.${s}`)}
            </li>
          ))}
        </ol>

        {step === 'file' ? (
          <Panel title={t('sales.import.steps.file')}>
            <div className="space-y-5">
              <div>
                <input
                  ref={fileInput}
                  id={`${ids}-file`}
                  type="file"
                  accept=".csv,.tsv,.txt,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  className="sr-only"
                  onChange={(event) => {
                    const chosen = event.target.files?.[0]
                    event.target.value = ''
                    if (chosen) void pick(chosen)
                  }}
                />
                {file ? (
                  <div className="flex flex-wrap items-center gap-3 rounded-xl border p-3">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-primary">
                      <FileSpreadsheetIcon aria-hidden className="size-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span data-file-name dir="auto" className="block font-medium break-all">
                        {file.name}
                      </span>
                      <span className="block text-sm text-muted-foreground">
                        {t('sales.import.fileRows', { count: file.rows.length })}
                      </span>
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => fileInput.current?.click()}
                      disabled={reading}
                    >
                      {t('sales.import.otherFile')}
                    </Button>
                  </div>
                ) : (
                  <button
                    type="button"
                    data-pick-file
                    onClick={() => fileInput.current?.click()}
                    disabled={reading}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault()
                      const dropped = event.dataTransfer.files[0]
                      if (dropped) void pick(dropped)
                    }}
                    className="flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-4 py-8 text-center transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <FileUpIcon aria-hidden className="size-8 text-primary" />
                    <span className="font-medium">
                      {reading ? t('sales.import.reading') : t('sales.import.pick')}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {t('sales.import.pickHint')}
                    </span>
                  </button>
                )}
                {file && file.sheets.length > 1 ? (
                  <div className="mt-3 flex flex-col gap-1">
                    <label htmlFor={`${ids}-sheet`} className="text-sm font-medium">
                      {t('sales.import.sheet')}
                    </label>
                    <NativeSelect
                      id={`${ids}-sheet`}
                      value={file.sheet ?? ''}
                      onChange={(event) => picked && void pick(picked, event.target.value)}
                    >
                      {file.sheets.map((sheet) => (
                        <option key={sheet} value={sheet}>
                          {sheet}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                ) : null}
                {readError ? (
                  <FormAlert tone="error" className="mt-3">
                    {t(readError)}
                  </FormAlert>
                ) : null}
                <p className="mt-3 flex items-start gap-2 text-sm leading-relaxed text-muted-foreground">
                  <ShieldCheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                  {t('sales.import.privacy')}
                </p>
              </div>
              {channelsQuery.isPending ? (
                <SectionSkeleton cards={1} />
              ) : channels.length > 1 ? (
                <div className="flex flex-col gap-1">
                  <label htmlFor={`${ids}-channel`} className="text-sm font-medium">
                    {t('sales.import.channel')}
                  </label>
                  <NativeSelect
                    id={`${ids}-channel`}
                    data-field="channel"
                    value={channelId ?? ''}
                    onChange={(event) => setChannelChoice(event.target.value)}
                  >
                    {channels.map((channel) => (
                      <option key={channel.id} value={channel.id}>
                        {channel.name}
                      </option>
                    ))}
                  </NativeSelect>
                  <p className="text-sm text-muted-foreground">{t('sales.import.channelHint')}</p>
                </div>
              ) : null}
              {locations && locations.length > 1 ? (
                <div className="flex flex-col gap-1">
                  <label htmlFor={`${ids}-branch`} className="text-sm font-medium">
                    {t('sales.import.branch')}
                  </label>
                  <NativeSelect
                    id={`${ids}-branch`}
                    data-field="branch"
                    value={locationId ?? ''}
                    onChange={(event) => setLocationChoice(event.target.value)}
                  >
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              ) : null}
              <Templates kinds={['daily', 'lines']} />
            </div>
          </Panel>
        ) : null}

        {step === 'columns' && file && choice ? (
          <Panel title={t('sales.import.steps.columns')} hint={t('sales.import.columns.intro')}>
            <div className="space-y-5">
              {choice.saved ? (
                <FormAlert tone="info">
                  <span className="block">{t('sales.import.columns.savedFound')}</span>
                  {choice.usingSaved ? (
                    <span className="mt-1 block font-medium">
                      {t('sales.import.columns.savedUsed')}
                    </span>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      className="mt-2"
                      data-use-saved
                      onClick={useSaved}
                    >
                      {t('sales.import.columns.useSaved')}
                    </Button>
                  )}
                </FormAlert>
              ) : null}
              <div className="flex flex-col gap-1">
                <label htmlFor={`${ids}-header`} className="text-sm font-medium">
                  {t('sales.import.columns.headerRow')}
                </label>
                <NativeSelect
                  id={`${ids}-header`}
                  value={String(choice.headerRow)}
                  onChange={(event) => {
                    const headerRow = Number(event.target.value)
                    update({
                      headerRow,
                      mapping: startOf(file.rows.slice(headerRow)).mapping,
                      usingSaved: false,
                    })
                  }}
                >
                  {file.rows.slice(0, 30).map((row, index) => (
                    <option key={index} value={index}>
                      {t('sales.import.columns.rowOption', {
                        row: index + 1,
                        cells: row
                          .filter((cell) => cell !== null)
                          .slice(0, 3)
                          .join(' · ')
                          .slice(0, 60),
                      })}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <ColumnSelect
                  id={`${ids}-name`}
                  label={t('sales.import.fields.name')}
                  value={mapping.name}
                  columns={columns}
                  optional={false}
                  onChange={(c) => setField('name', c)}
                />
                <ColumnSelect
                  id={`${ids}-qty`}
                  label={t('sales.import.fields.qty')}
                  hint={t('sales.import.fields.qtyHint')}
                  value={mapping.qty}
                  columns={columns}
                  optional
                  onChange={(c) => setField('qty', c)}
                />
                <ColumnSelect
                  id={`${ids}-amount`}
                  label={t('sales.import.fields.amount')}
                  value={amount?.column}
                  columns={columns}
                  optional={false}
                  onChange={(c) => {
                    const kind = amount?.kind ?? (vatRegistered ? 'net' : 'total')
                    update({
                      mapping: withAmount(
                        c === null ? mapping : withField(mapping, kind, c),
                        c,
                        kind,
                      ),
                      usingSaved: false,
                    })
                  }}
                />
                <ColumnSelect
                  id={`${ids}-date`}
                  label={t('sales.import.fields.date')}
                  hint={t('sales.import.fields.dateHint')}
                  value={mapping.date}
                  columns={columns}
                  optional
                  onChange={(c) => setField('date', c)}
                />
              </div>
              {amount ? (
                <Choices
                  name={`${ids}-amount-kind`}
                  legend={t('sales.import.fields.amountKind')}
                  value={amountKinds.includes(amount.kind) ? amount.kind : null}
                  options={amountKinds.map((kind) => ({
                    value: kind,
                    label: t(
                      `sales.import.amountKinds.${vatRegistered ? kind : `${kind}Plain`}` as I18nKey,
                    ),
                  }))}
                  onChange={(kind) =>
                    update({ mapping: withAmount(mapping, amount.column, kind), usingSaved: false })
                  }
                />
              ) : null}
              <div className="rounded-xl border">
                <button
                  type="button"
                  aria-expanded={moreShown}
                  aria-controls={`${ids}-more`}
                  onClick={() => setMore(!moreShown)}
                  className="flex min-h-11 w-full items-center justify-between gap-2 rounded-xl px-3 text-start font-medium focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {t('sales.import.columns.more')}
                  <ChevronDownIcon
                    aria-hidden
                    className={cn('size-4 transition-transform', moreShown && 'rotate-180')}
                  />
                </button>
                <div
                  id={`${ids}-more`}
                  hidden={!moreShown}
                  className="grid gap-4 border-t p-3 sm:grid-cols-2"
                >
                  <ColumnSelect
                    id={`${ids}-code`}
                    label={t('sales.import.fields.code')}
                    hint={t('sales.import.fields.codeHint')}
                    value={mapping.code}
                    columns={columns}
                    optional
                    onChange={(c) => setField('code', c)}
                  />
                  <ColumnSelect
                    id={`${ids}-variant`}
                    label={t('sales.import.fields.variant')}
                    hint={t('sales.import.fields.variantHint')}
                    value={mapping.variant}
                    columns={columns}
                    optional
                    onChange={(c) => setField('variant', c)}
                  />
                  {vatRegistered && amount && amount.kind !== 'net' ? (
                    <ColumnSelect
                      id={`${ids}-tax`}
                      label={t('sales.import.fields.tax')}
                      hint={t('sales.import.fields.taxHint')}
                      value={mapping.tax}
                      columns={columns}
                      optional
                      onChange={(c) => setField('tax', c)}
                    />
                  ) : null}
                  {feesAllowed ? (
                    <ColumnSelect
                      id={`${ids}-fee`}
                      label={t('sales.import.fields.fee')}
                      hint={t('sales.import.fields.feeHint')}
                      value={mapping.fee}
                      columns={columns}
                      optional
                      onChange={(c) => setField('fee', c)}
                    />
                  ) : null}
                  {mapping.date !== undefined ? (
                    <ColumnSelect
                      id={`${ids}-order`}
                      label={t('sales.import.fields.order')}
                      hint={t('sales.import.fields.orderHint')}
                      value={mapping.order}
                      columns={columns}
                      optional
                      onChange={(c) => setField('order', c)}
                    />
                  ) : null}
                </div>
              </div>
              {ambiguousExample ? (
                <Choices
                  name={`${ids}-date-order`}
                  legend={t('sales.import.dateOrder.legend', { example: ambiguousExample })}
                  value={choice.dateOrder}
                  options={(['dmy', 'mdy'] as const).map((order) => {
                    const read = importDate(ambiguousExample, order)
                    // The month as a word ("1 October 2026"): a number would ask the question again.
                    return {
                      value: order,
                      label: read.ok
                        ? formatDate(locale, `${read.date}T00:00:00Z`, {
                            day: 'numeric',
                            month: 'long',
                            year: 'numeric',
                            timeZone: 'UTC',
                          })
                        : order,
                      hint: t(`sales.import.dateOrder.${order}`),
                    }
                  })}
                  onChange={(dateOrder) => update({ dateOrder, usingSaved: false })}
                />
              ) : null}
              {problem ? (
                <FormAlert tone="error">{t(`sales.import.mappingErrors.${problem}`)}</FormAlert>
              ) : last ? null : (
                <ReadSummary read={read} {...summaryChoices} />
              )}
            </div>
          </Panel>
        ) : null}

        {step === 'period' ? (
          <Panel title={t('sales.import.steps.period')} hint={t('sales.import.period.intro')}>
            <div className="space-y-4">
              <Choices
                name={`${ids}-period`}
                legend={t('sales.import.period.legend')}
                value={periodKind}
                options={[
                  { value: 'day', label: t('sales.import.period.day') },
                  {
                    value: 'range',
                    label: t('sales.import.period.range'),
                    hint: t('sales.import.period.rangeHint'),
                  },
                ]}
                onChange={setPeriodKind}
              />
              {periodKind === 'day' ? (
                <label className="flex max-w-xs flex-col gap-1 text-sm font-medium">
                  {t('sales.import.period.theDay')}
                  <Input
                    type="date"
                    data-field="day"
                    value={theDay}
                    max={today}
                    onChange={(event) => setDay(event.target.value || null)}
                  />
                </label>
              ) : (
                <div className="grid max-w-md grid-cols-2 gap-3">
                  <label className="flex flex-col gap-1 text-sm font-medium">
                    {t('sales.import.period.from')}
                    <Input
                      type="date"
                      data-field="from"
                      value={from ?? ''}
                      max={to ?? today}
                      onChange={(event) => setFrom(event.target.value || null)}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm font-medium">
                    {t('sales.import.period.to')}
                    <Input
                      type="date"
                      data-field="to"
                      value={to ?? ''}
                      min={from ?? undefined}
                      max={today}
                      onChange={(event) => setTo(event.target.value || null)}
                    />
                  </label>
                </div>
              )}
              {periodProblem && periodProblem !== 'missing' ? (
                <FormAlert tone="error">
                  {t(`sales.import.period.errors.${periodProblem}`)}
                </FormAlert>
              ) : null}
              {periodKind === 'range' && periodProblem === null && period ? (
                <p className="text-sm text-muted-foreground">
                  {t('sales.import.period.onLastDay', { date: businessDate(period.to) })}
                </p>
              ) : null}
            </div>
          </Panel>
        ) : null}

        {step === 'vat' ? (
          <Panel title={t('sales.import.steps.vat')}>
            <Choices
              name={`${ids}-vat`}
              legend={t('sales.import.vat.legend')}
              value={vatAnswer === null ? null : vatAnswer ? 'yes' : 'no'}
              options={[
                {
                  value: 'yes',
                  label: t('sales.import.vat.yes'),
                  hint: t('sales.import.vat.yesHint', {
                    gross: money('18.90'),
                    net: money('18.00'),
                  }),
                },
                {
                  value: 'no',
                  label: t('sales.import.vat.no'),
                  hint: t('sales.import.vat.noHint'),
                },
              ]}
              onChange={(value) => setVatAnswer(value === 'yes')}
            />
          </Panel>
        ) : null}

        {last && step !== 'file' && read ? (
          <ReadSummary read={read} final {...summaryChoices} />
        ) : null}
        {sendError ? <FormAlert tone="error">{sendError}</FormAlert> : null}
        {sending ? (
          <div role="status" className="space-y-2">
            <p className="text-sm font-medium">
              {t('sales.import.sending', { done: sending.done, total: sending.total })}
            </p>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{
                  width: `${sending.total === 0 ? 0 : Math.round((sending.done / sending.total) * 100)}%`,
                }}
              />
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap justify-between gap-2">
          {steps.indexOf(step) > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={previous}
              disabled={sending !== null}
            >
              <ArrowLeftIcon aria-hidden className="rtl:rotate-180" />
              {t('sales.import.back')}
            </Button>
          ) : (
            <span />
          )}
          {last && step !== 'file' ? (
            <Button
              type="button"
              size="lg"
              data-send
              disabled={!ready || sending !== null}
              onClick={() => void send()}
            >
              <UploadIcon aria-hidden />
              {t('sales.import.send')}
            </Button>
          ) : (
            <Button type="button" size="lg" data-next disabled={!canNext} onClick={next}>
              {t('sales.import.next')}
              <ArrowRightIcon aria-hidden className="rtl:rotate-180" />
            </Button>
          )}
        </div>
      </div>
    </PageContainer>
  )
}

/** What the file reads as with these choices: rows, days, names, sales, and the rows left out. */
function ReadSummary({
  read,
  final = false,
  beforeVat,
  periodPending,
}: {
  read: ReturnType<typeof readWith> | null
  final?: boolean
  /** The amount is known to be before VAT (a VAT-registered business). */
  beforeVat: boolean
  /** A summary whose days are not chosen yet (step 3 comes next): its days show "—". */
  periodPending: boolean
}) {
  const { t } = useTranslation()
  const money = useMoney()
  const businessDate = useBusinessDate()
  if (!read) return null
  if (read.problem) {
    if (read.problem === 'vat_answer_missing' || read.problem === 'period_missing') return null
    // No row read: the rows left out say why (each with its row and column).
    return (
      <div className="space-y-3">
        <FormAlert tone="error">{t(`sales.import.problems.${read.problem}`)}</FormAlert>
        {read.rowsLeftOut > 0 ? <LeftOut errors={read.errors} count={read.rowsLeftOut} /> : null}
      </div>
    )
  }
  const names = new Set(read.items.map((item) => `${item.name}\u0000${item.code ?? ''}`)).size
  const days = new Set(read.items.map((item) => item.day)).size
  const amount = importSales(read.items, 2)
  return (
    <div
      data-read-summary
      className={cn(
        'space-y-3',
        final && 'rounded-2xl bg-card p-4 shadow-sm ring-1 ring-foreground/[0.06] sm:p-5',
      )}
    >
      {final ? <h2 className="font-semibold">{t('sales.import.summary.title')}</h2> : null}
      <ul className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <li>
          <span className="block text-muted-foreground">{t('sales.import.summary.rows')}</span>
          <span className="font-medium tabular-nums">{read.rowsRead}</span>
        </li>
        <li>
          <span className="block text-muted-foreground">{t('sales.import.summary.days')}</span>
          <span className="font-medium">
            {periodPending
              ? '—'
              : read.period
                ? read.period.from === read.period.to
                  ? businessDate(read.period.from)
                  : t('sales.import.summary.daysRange', {
                      from: businessDate(read.period.from),
                      to: businessDate(read.period.to),
                    })
                : days}
          </span>
        </li>
        <li>
          <span className="block text-muted-foreground">{t('sales.import.summary.names')}</span>
          <span className="font-medium tabular-nums">{names}</span>
        </li>
        <li>
          <span className="block text-muted-foreground">
            {read.amountsIncludeVat
              ? t('sales.import.summary.amountWithVat')
              : beforeVat
                ? t('sales.import.summary.amountBeforeVat')
                : t('sales.import.summary.amount')}
          </span>
          <bdi className="font-medium tabular-nums">{money(amount)}</bdi>
        </li>
      </ul>
      {read.totalRows > 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('sales.import.summary.totalRows', { count: read.totalRows })}
        </p>
      ) : null}
      {read.rowsLeftOut > 0 ? <LeftOut errors={read.errors} count={read.rowsLeftOut} /> : null}
    </div>
  )
}

/** The rows left out, each with its row and column, and why. */
export function LeftOut({
  errors,
  count,
  headers,
}: {
  errors: readonly { row: number; column: number | null; code: ImportRowErrorCode }[]
  count: number
  headers?: Partial<Record<number, string>>
}) {
  const { t } = useTranslation()
  return (
    <FormAlert tone="info">
      <span className="block font-medium">{t('sales.import.leftOut.title', { count })}</span>
      <ul className="mt-1 list-disc space-y-0.5 ps-5">
        {errors.slice(0, 10).map((error) => (
          <li key={`${error.row}-${error.column}`} data-left-out>
            {error.column === null
              ? t('sales.import.leftOut.row', { row: error.row, why: t(ROW_ERRORS[error.code]) })
              : t('sales.import.leftOut.rowColumn', {
                  row: error.row,
                  column: columnName(error.column, headers?.[error.column]),
                  why: t(ROW_ERRORS[error.code]),
                })}
          </li>
        ))}
      </ul>
    </FormAlert>
  )
}

/** "Import sales from a file": the steps before the draft, inside the Sales module's gate. */
export function NewImportPage() {
  return (
    <ModuleGate moduleId="sales" entryId="sales">
      <NewImport />
    </ModuleGate>
  )
}
