'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { ChannelStatementDto, CreateStatementInput } from '@bizcost/contracts'
import { isCurrencyCode, newId, type CurrencyCode } from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftIcon,
  CheckCheckIcon,
  DownloadIcon,
  FileUpIcon,
  LockKeyholeIcon,
  PencilIcon,
  PlusIcon,
  ReceiptTextIcon,
  Trash2Icon,
  Undo2Icon,
} from 'lucide-react'
import Link from 'next/link'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { TextField } from '@/components/form/text-field'
import { useUnsavedChanges } from '@/components/form/unsaved-changes'
import { isolate } from '@/components/form/use-message'
import { LoadError, SectionSkeleton } from '@/components/states/query-state'
import { StatePanel } from '@/components/states/state-panel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { readAmount, withLatinDigits, type FieldError } from '@/features/catalog/numbers'
import { useBusinessDate, useMoney } from '@/features/documents/amounts'
import { ConfirmDialog } from '@/features/documents/confirm-dialog'
import { invalidateProfit } from '@/features/reports/refresh'
import { columnName } from '@/features/sales/import/column-name'
import { readImportFile, FileReadError } from '@/features/sales/import/read-file'
import { downloadTemplate } from '@/features/sales/import/templates'
import { useLocale } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { NoAccess } from './settings-shell'
import { isSectionVisible, sectionPath } from './sections'
import { readStatementRows } from './statement-file'

// A sales channel's statements (M3 Step 4; the owner's answer Q8 of D-218): Settings → Sales channels
// → a channel. A delivery app's or a marketplace's statement for some days: what it kept (commission,
// payment fees, other fees, ads, refunds charged: its fees for those days, which replace the expenses
// marked as its fees and its commission % for those days) and, for information, the sales it lists
// and its payout. Typed in a form, or read from the statement template (or an export with the same
// columns) on this device, each row a draft to check and finalize. Every amount is a cost: the page is
// for members with the costs switch (the API refuses the rest). A final statement is never edited: it
// is reversed (while its days are open). Statements of an import's fee column show here too.

type AmountField =
  'sales' | 'commission' | 'paymentFees' | 'otherFees' | 'ads' | 'refundsCharged' | 'payout'

const FEE_FIELDS = ['commission', 'paymentFees', 'otherFees', 'ads', 'refundsCharged'] as const
const OPTIONAL_FIELDS = ['sales', 'payout'] as const

interface Draft {
  periodFrom: string
  periodTo: string
  amounts: Record<AmountField, string>
  notes: string
}

function draftOf(statement: ChannelStatementDto | undefined): Draft {
  const amount = (value: string | null | undefined) => (typeof value === 'string' ? value : '')
  return {
    periodFrom: statement?.periodFrom ?? '',
    periodTo: statement?.periodTo ?? '',
    amounts: {
      sales: amount(statement?.sales),
      commission: amount(statement?.commission),
      paymentFees: amount(statement?.paymentFees),
      otherFees: amount(statement?.otherFees),
      ads: amount(statement?.ads),
      refundsCharged: amount(statement?.refundsCharged),
      payout: amount(statement?.payout),
    },
    notes: statement?.notes ?? '',
  }
}

const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b)

function StatementDialog({
  channelId,
  statement,
  currency,
  today,
  onClose,
  onSaved,
}: {
  channelId: string
  /** The draft changed (undefined: a new statement). */
  statement: ChannelStatementDto | undefined
  currency: CurrencyCode
  today: string
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const create = useMutation(trpc.channelStatement.create.mutationOptions())
  const update = useMutation(trpc.channelStatement.update.mutationOptions())
  const post = useMutation(trpc.channelStatement.post.mutationOptions())
  const [id] = useState(() => statement?.id ?? newId())
  const [initial] = useState(() => draftOf(statement))
  const [draft, setDraft] = useState(initial)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<I18nKey | null>(null)
  const busy = create.isPending || update.isPending || post.isPending
  const read = (field: AmountField) => {
    const value = draft.amounts[field].trim()
    if (value === '') return null
    return readAmount(value, { currency })
  }
  const errors: Partial<Record<AmountField, FieldError>> = {}
  for (const field of [...FEE_FIELDS, ...OPTIONAL_FIELDS]) {
    const result = read(field)
    if (result && !result.ok) errors[field] = result.error
  }
  const daysError: I18nKey | null =
    draft.periodFrom === '' || draft.periodTo === ''
      ? 'settings.channels.statements.daysRequired'
      : draft.periodFrom > draft.periodTo
        ? 'settings.channels.statements.daysOrder'
        : draft.periodTo > today
          ? 'settings.channels.statements.daysFuture'
          : null
  const valid = daysError === null && Object.keys(errors).length === 0
  const dirty = !sameDraft(draft, initial)

  function input(): Omit<CreateStatementInput, 'id' | 'channelId'> {
    const value = (field: AmountField) => {
      const result = read(field)
      return result && result.ok ? result.value : null
    }
    return {
      periodFrom: draft.periodFrom,
      periodTo: draft.periodTo,
      sales: value('sales'),
      commission: value('commission') ?? '0',
      paymentFees: value('paymentFees') ?? '0',
      otherFees: value('otherFees') ?? '0',
      ads: value('ads') ?? '0',
      refundsCharged: value('refundsCharged') ?? '0',
      payout: value('payout'),
      notes: draft.notes.trim() || null,
    }
  }

  async function save(finalize = false): Promise<boolean> {
    setSubmitted(true)
    setError(null)
    if (!valid) return false
    try {
      const saved = statement
        ? await update.mutateAsync({ id, version: statement.version, ...input() })
        : await create.mutateAsync({ id, channelId, ...input() })
      if (finalize) {
        await post.mutateAsync({ id, version: saved.data.version })
        toast.success(t('settings.channels.statements.finalized'))
      } else {
        toast.success(t('settings.channels.statements.saved'))
      }
      await onSaved()
      return true
    } catch (caught) {
      const code = apiErrorCode(caught)
      setError(code === 'conflict' ? 'settings.channels.statements.conflict' : apiErrorKey(caught))
      if (finalize) await onSaved()
      return false
    }
  }

  const guard = useUnsavedChanges({ dirty, save: () => save(false), close: onClose })
  const leave = () => guard.requestLeave(onClose)
  const amountField = (field: AmountField) => (
    <TextField
      key={field}
      label={t(`settings.channels.statements.fields.${field}`)}
      error={submitted && errors[field] ? t(errors[field].key, errors[field].values) : undefined}
      render={(a11y) => (
        <Input
          {...a11y}
          data-statement-field={field}
          inputMode="decimal"
          dir="ltr"
          autoComplete="off"
          spellCheck={false}
          placeholder="0.00"
          value={draft.amounts[field]}
          onChange={(event) =>
            setDraft((d) => ({ ...d, amounts: { ...d.amounts, [field]: event.target.value } }))
          }
          onBlur={() =>
            setDraft((d) => ({
              ...d,
              amounts: { ...d.amounts, [field]: withLatinDigits(d.amounts[field]) },
            }))
          }
          className="tabular-nums rtl:text-end"
        />
      )}
    />
  )

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && leave()}>
      <DialogContent
        closeLabel={t('actions.close')}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>
            {statement
              ? t('settings.channels.statements.editTitle')
              : t('settings.channels.statements.addTitle')}
          </DialogTitle>
          <DialogDescription>{t('settings.channels.statements.formIntro')}</DialogDescription>
        </DialogHeader>
        <form
          method="post"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            void save(false)
          }}
          className="space-y-5"
        >
          {error ? <FormAlert tone="error">{t(error)}</FormAlert> : null}
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label={t('settings.channels.statements.from')}
              render={(a11y) => (
                <Input
                  {...a11y}
                  type="date"
                  data-statement-field="from"
                  value={draft.periodFrom}
                  max={draft.periodTo || today}
                  onChange={(event) => setDraft((d) => ({ ...d, periodFrom: event.target.value }))}
                />
              )}
            />
            <TextField
              label={t('settings.channels.statements.to')}
              render={(a11y) => (
                <Input
                  {...a11y}
                  type="date"
                  data-statement-field="to"
                  value={draft.periodTo}
                  min={draft.periodFrom || undefined}
                  max={today}
                  onChange={(event) => setDraft((d) => ({ ...d, periodTo: event.target.value }))}
                />
              )}
            />
          </div>
          {submitted && daysError ? <FormAlert tone="error">{t(daysError)}</FormAlert> : null}
          <fieldset className="space-y-3">
            <legend className="mb-1 text-sm font-medium">
              {t('settings.channels.statements.keptLegend')}
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">{FEE_FIELDS.map(amountField)}</div>
          </fieldset>
          <fieldset className="space-y-3">
            <legend className="mb-1 text-sm font-medium">
              {t('settings.channels.statements.infoLegend')}
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">{OPTIONAL_FIELDS.map(amountField)}</div>
          </fieldset>
          <TextField
            label={t('settings.channels.statements.notes')}
            dir="auto"
            value={draft.notes}
            onChange={(event) => setDraft((d) => ({ ...d, notes: event.target.value }))}
          />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={leave}>
              {t('actions.cancel')}
            </Button>
            <Button type="submit" variant="outline" disabled={busy}>
              {busy ? t('status.saving') : t('settings.channels.statements.saveDraft')}
            </Button>
            <Button
              type="button"
              data-statement-finalize
              disabled={busy}
              onClick={() => void save(true)}
            >
              <CheckCheckIcon aria-hidden />
              {t('settings.channels.statements.finalize')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const TONES = { draft: 'warning', posted: 'success', reversed: 'neutral' } as const

export function ChannelStatements({
  businessId,
  channelId,
}: {
  businessId: string
  channelId: string
}) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const { data: context } = useBusinessContext()
  const visible = context ? isSectionVisible(context, 'channels') : false
  const costs = context?.visibleCategories.includes('cost') === true
  const channels = useQuery({
    ...trpc.channel.list.queryOptions({ status: 'all' }),
    enabled: visible,
  })
  const statements = useQuery({
    ...trpc.channelStatement.list.queryOptions({ channelId }),
    enabled: visible && costs,
  })
  const books = useQuery({ ...trpc.books.get.queryOptions(), enabled: visible })
  const create = useMutation(trpc.channelStatement.create.mutationOptions())
  const post = useMutation(trpc.channelStatement.post.mutationOptions())
  const reverse = useMutation(trpc.channelStatement.reverse.mutationOptions())
  const discard = useMutation(trpc.channelStatement.discard.mutationOptions())
  const fileInput = useRef<HTMLInputElement>(null)
  const [editing, setEditing] = useState<{ statement?: ChannelStatementDto } | null>(null)
  const [confirm, setConfirm] = useState<{
    kind: 'post' | 'reverse' | 'discard'
    statement: ChannelStatementDto
  } | null>(null)
  const [confirmError, setConfirmError] = useState<I18nKey | null>(null)
  const [fileNote, setFileNote] = useState<{
    tone: 'error' | 'success' | 'info'
    text: string
    /** The rows left out, each with its column and why. */
    rows?: string[]
  } | null>(null)
  const [reading, setReading] = useState(false)
  // A statement changes the channel's fees in real profit (D-212).
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.channelStatement.list.pathKey() }),
      invalidateProfit(queryClient, trpc),
    ])
  if (!context) return null
  if (!visible) return <NoAccess businessId={businessId} />
  const back = (
    <Link
      href={sectionPath(businessId, 'channels')}
      className="-ms-2 -mt-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:underline"
    >
      <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
      {t('settings.channels.statements.back')}
    </Link>
  )
  const channel = channels.data?.data.items.find((c) => c.id === channelId)
  if (channels.isSuccess && !channel) {
    return (
      <div>
        {back}
        <StatePanel
          icon={ReceiptTextIcon}
          title={t('settings.channels.statements.notFound')}
          body={t('settings.channels.statements.notFoundBody')}
        />
      </div>
    )
  }
  if (!costs) {
    return (
      <div>
        {back}
        <StatePanel
          icon={LockKeyholeIcon}
          title={t('settings.channels.statements.costsOnlyTitle')}
          body={t('settings.channels.statements.costsOnly')}
        />
      </div>
    )
  }
  const currency: CurrencyCode = isCurrencyCode(context.currency) ? context.currency : 'AED'
  const today = books.data?.today ?? new Date().toISOString().slice(0, 10)
  const items = statements.data?.data.items ?? []

  async function readFile(file: File) {
    setReading(true)
    setFileNote(null)
    try {
      const read = readStatementRows((await readImportFile(file)).rows)
      if (read.unknown) {
        setFileNote({ tone: 'error', text: t('settings.channels.statements.fileUnknown') })
        return
      }
      for (const row of read.statements) {
        await create.mutateAsync({
          id: newId(),
          channelId,
          periodFrom: row.periodFrom,
          periodTo: row.periodTo,
          sales: row.sales,
          commission: row.commission,
          paymentFees: row.paymentFees,
          otherFees: row.otherFees,
          ads: row.ads,
          refundsCharged: row.refundsCharged,
          payout: row.payout,
          notes: null,
        })
      }
      await refresh()
      setFileNote({
        tone: read.errors.length > 0 ? 'info' : 'success',
        text: [
          t('settings.channels.statements.fileAdded', { count: read.statements.length }),
          read.errors.length > 0 ? t('settings.channels.statements.fileSkipped') : '',
        ]
          .filter(Boolean)
          .join(' '),
        // Each row left out with its column and why, as the sales importer says it.
        rows: read.errors.slice(0, 10).map((error) => {
          const why = t(`settings.channels.statements.why.${error.code}`)
          return error.column === null
            ? t('settings.channels.statements.fileRowDays', { row: error.row, why })
            : t('settings.channels.statements.fileRow', {
                row: error.row,
                column: columnName(error.column, read.headers[error.column]),
                why,
              })
        }),
      })
    } catch (caught) {
      setFileNote({
        tone: 'error',
        text:
          caught instanceof FileReadError
            ? t('settings.channels.statements.fileUnreadable')
            : t(apiErrorKey(caught)),
      })
    } finally {
      setReading(false)
    }
  }

  async function act() {
    if (!confirm) return
    setConfirmError(null)
    const { kind, statement } = confirm
    try {
      if (kind === 'post') {
        await post.mutateAsync({ id: statement.id, version: statement.version })
        toast.success(t('settings.channels.statements.finalized'))
      } else if (kind === 'reverse') {
        await reverse.mutateAsync({ id: statement.id })
        toast.success(t('settings.channels.statements.reversed'))
      } else {
        await discard.mutateAsync({ id: statement.id, version: statement.version })
        toast.success(t('settings.channels.statements.discarded'))
      }
      setConfirm(null)
    } catch (caught) {
      setConfirmError(apiErrorKey(caught))
    } finally {
      await refresh()
    }
  }

  const busy = post.isPending || reverse.isPending || discard.isPending

  return (
    <div>
      {back}
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">
            {channel
              ? t('settings.channels.statements.titleOf', { name: isolate(channel.name) })
              : t('settings.channels.statements.title')}
          </h1>
          <p className="mt-1.5 max-w-2xl text-muted-foreground">
            {t('settings.channels.statements.intro')}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={reading}
            data-statement-file
            onClick={() => fileInput.current?.click()}
          >
            <FileUpIcon aria-hidden />
            {reading
              ? t('settings.channels.statements.reading')
              : t('settings.channels.statements.fromFile')}
          </Button>
          <Button data-statement-add onClick={() => setEditing({})}>
            <PlusIcon aria-hidden />
            {t('settings.channels.statements.add')}
          </Button>
        </div>
      </header>
      <input
        ref={fileInput}
        type="file"
        accept=".csv,.tsv,.txt,.xlsx,.xls"
        className="sr-only"
        aria-hidden
        tabIndex={-1}
        onChange={(event) => {
          const chosen = event.target.files?.[0]
          event.target.value = ''
          if (chosen) void readFile(chosen)
        }}
      />
      <div className="space-y-5">
        {fileNote ? (
          <FormAlert tone={fileNote.tone}>
            <span className="block">{fileNote.text}</span>
            {fileNote.rows && fileNote.rows.length > 0 ? (
              <ul className="mt-1 list-disc space-y-0.5 ps-5">
                {fileNote.rows.map((row) => (
                  <li key={row} data-statement-left-out>
                    {row}
                  </li>
                ))}
              </ul>
            ) : null}
          </FormAlert>
        ) : null}
        {statements.isPending ? (
          <SectionSkeleton cards={1} />
        ) : statements.isError ? (
          <LoadError error={statements.error} onRetry={() => void statements.refetch()} />
        ) : items.length === 0 ? (
          <div className="rounded-2xl bg-card px-6 py-10 text-center shadow-sm ring-1 ring-foreground/[0.06]">
            <ReceiptTextIcon aria-hidden className="mx-auto size-8 text-primary" />
            <p className="mt-3 font-semibold">{t('settings.channels.statements.empty')}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('settings.channels.statements.emptyBody')}
            </p>
          </div>
        ) : (
          <ul
            aria-label={t('settings.channels.statements.title')}
            className="divide-y rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]"
          >
            {items.map((statement) => (
              <li
                key={statement.id}
                data-statement={statement.status}
                className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:px-5"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium whitespace-nowrap">
                    {t('settings.channels.statements.days', {
                      from: businessDate(statement.periodFrom),
                      to: businessDate(statement.periodTo),
                    })}
                    <Badge tone={TONES[statement.status]}>
                      {t(`settings.channels.statements.status.${statement.status}`)}
                    </Badge>
                    {statement.importId ? (
                      <Badge tone="neutral">{t('settings.channels.statements.fromImport')}</Badge>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {typeof statement.fees === 'string' ? (
                      <>
                        {t('settings.channels.statements.fees')}{' '}
                        <bdi
                          data-statement-fees
                          className="font-medium text-foreground tabular-nums"
                        >
                          {money(statement.fees)}
                        </bdi>
                      </>
                    ) : null}
                    {typeof statement.sales === 'string' ? (
                      <>
                        {' · '}
                        {t('settings.channels.statements.salesOf')}{' '}
                        <bdi className="tabular-nums">{money(statement.sales)}</bdi>
                      </>
                    ) : null}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {statement.status === 'draft' ? (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => setEditing({ statement })}>
                        <PencilIcon aria-hidden />
                        {t('settings.channels.statements.edit')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setConfirm({ kind: 'discard', statement })}
                      >
                        <Trash2Icon aria-hidden />
                        {t('settings.channels.statements.discard')}
                      </Button>
                      <Button
                        size="sm"
                        data-statement-post
                        onClick={() => setConfirm({ kind: 'post', statement })}
                      >
                        <CheckCheckIcon aria-hidden />
                        {t('settings.channels.statements.finalize')}
                      </Button>
                    </>
                  ) : statement.status === 'posted' ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setConfirm({ kind: 'reverse', statement })}
                    >
                      <Undo2Icon aria-hidden />
                      {t('settings.channels.statements.reverse')}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="space-y-2 rounded-2xl bg-card p-4 shadow-sm ring-1 ring-foreground/[0.06] sm:p-5">
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t('settings.channels.statements.templateIntro')}
          </p>
          <Button
            variant="outline"
            size="sm"
            data-template="statement"
            onClick={() => downloadTemplate('statement', locale === 'ar' ? 'ar' : 'en')}
          >
            <DownloadIcon aria-hidden />
            {t('settings.channels.statements.template')}
          </Button>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t('settings.channels.statements.note')}
        </p>
      </div>
      {editing ? (
        <StatementDialog
          channelId={channelId}
          statement={editing.statement}
          currency={currency}
          today={today}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await refresh()
            setEditing(null)
          }}
        />
      ) : null}
      <ConfirmDialog
        open={confirm !== null}
        icon={
          confirm?.kind === 'post'
            ? CheckCheckIcon
            : confirm?.kind === 'reverse'
              ? Undo2Icon
              : Trash2Icon
        }
        title={confirm ? t(`settings.channels.statements.confirm.${confirm.kind}Title`) : ''}
        body={
          confirm
            ? t(`settings.channels.statements.confirm.${confirm.kind}Body`, {
                from: businessDate(confirm.statement.periodFrom),
                to: businessDate(confirm.statement.periodTo),
                amount:
                  typeof confirm.statement.fees === 'string' ? money(confirm.statement.fees) : '',
              })
            : ''
        }
        action={
          confirm
            ? t(
                confirm.kind === 'post'
                  ? 'settings.channels.statements.finalize'
                  : confirm.kind === 'reverse'
                    ? 'settings.channels.statements.reverse'
                    : 'settings.channels.statements.discard',
              )
            : ''
        }
        busyLabel={t('status.saving')}
        busy={busy}
        error={confirmError}
        destructive={confirm?.kind !== 'post'}
        onConfirm={() => void act()}
        onClose={() => {
          setConfirm(null)
          setConfirmError(null)
        }}
      />
    </div>
  )
}
