'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { ImportAnswerInput, ImportNameDto, SaleImportDto } from '@bizcost/contracts'
import { looksNotSold, newId, type AliasTarget } from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftIcon,
  CheckCheckIcon,
  CheckIcon,
  CircleAlertIcon,
  FileSearchIcon,
  FileSpreadsheetIcon,
  PlusIcon,
  SparklesIcon,
  Trash2Icon,
  Undo2Icon,
} from 'lucide-react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { isolate } from '@/components/form/use-message'
import { ModuleGate } from '@/components/shell/module-gate'
import { PageContainer } from '@/components/shell/page-container'
import { LoadError, SectionSkeleton } from '@/components/states/query-state'
import { StatePanel } from '@/components/states/state-panel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { useBusinessDate, useMoney } from '@/features/documents/amounts'
import { ConfirmDialog } from '@/features/documents/confirm-dialog'
import { Panel } from '@/features/documents/panel'
import { can } from '@/features/settings/sections'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { useAllProducts } from '../data'
import { mayImport, seesCosts, useRefreshImports } from './data'
import { LeftOut } from './import-new'
import { daysCovered, namesToAddAll } from './wizard'

// An import's own page (M3 Step 4): a draft's names (5: "Did you mean …?", "This looks like" a tip, a
// service charge or delivery, "Add as new products" for the names that look like nothing (asked
// first: the products stay), "Not something I sell": skipped, a service charge, delivery charged; each
// answer saved for the next files) and its preview (6: rows read, the days covered, sales before VAT,
// refunds, % matched, days already imported skipped or replaced (replacing needs the reverse key),
// Today's sales of the same days, rows left out with their row and column, the materials without a
// price), then «اعتمد نهائيًا». A day's amount shows once its names are settled (before that it is
// the file's own kind of amount). A finalized import shows its days, each with its sale and refund, a
// day or the whole of it reversed by who may reverse sales (as if never finalized; a closed day's on
// the first open day). A draft is saved as the answers are given, so nothing is lost by leaving.

const TREATMENTS: readonly Exclude<AliasTarget, 'product'>[] = ['skip', 'charge', 'delivery']

const DAY_STATES: Readonly<Record<SaleImportDto['days'][number]['state'], I18nKey>> = {
  new: 'sales.import.days.new',
  imported: 'sales.import.days.imported',
  posted: 'sales.import.days.posted',
  reversed: 'sales.import.days.reversed',
  skipped: 'sales.import.days.skipped',
}

const STATUS_TONES = { draft: 'warning', posted: 'success', reversed: 'neutral' } as const

/** "Add as new products" lists this many of its names before "and n more". */
const ADD_ALL_LISTED = 12

/** An import's status: a draft, imported (its sales finalized), or reversed. */
export function ImportStatus({ status }: { status: SaleImportDto['status'] }) {
  const { t } = useTranslation()
  return <Badge tone={STATUS_TONES[status]}>{t(`sales.import.status.${status}`)}</Badge>
}

/** What a matched name is: the product, or its treatment (and how it was found). */
function MatchedAs({ match }: { match: Extract<ImportNameDto['match'], { state: 'matched' }> }) {
  const { t } = useTranslation()
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 text-sm">
      <CheckIcon aria-hidden className="size-4 text-success" />
      {match.target === 'product' ? (
        <span>
          {t('sales.import.names.is')} <bdi className="font-medium">{match.productName}</bdi>
        </span>
      ) : (
        <span className="font-medium">{t(`sales.import.names.treatments.${match.target}`)}</span>
      )}
      <span className="text-muted-foreground">· {t(`sales.import.names.via.${match.via}`)}</span>
    </span>
  )
}

/** One name of the file: how it is matched, or the ways to settle it. */
function NameRow({
  entry,
  products,
  canAdd,
  busy,
  onAnswer,
}: {
  entry: ImportNameDto
  products: readonly { id: string; name: string }[]
  canAdd: boolean
  busy: boolean
  onAnswer: (answer: ImportAnswerInput) => void
}) {
  const { t } = useTranslation()
  const money = useMoney()
  const ids = useId()
  const [changing, setChanging] = useState(false)
  const [notSold, setNotSold] = useState(false)
  const unmatched = entry.match.state === 'unmatched'
  const open = unmatched || changing
  // A tip, a service charge or delivery charged, by its name: offered first (never applied unasked).
  const looksLike = unmatched ? looksNotSold(entry.name) : null
  const answer = (target: ImportAnswerInput['target'], productId: string | null = null) => {
    onAnswer({ name: entry.name, code: entry.code, target, productId })
    setChanging(false)
    setNotSold(false)
  }
  return (
    <li data-import-name={entry.name} className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span dir="auto" className="min-w-0 text-start font-medium break-words">
              {entry.name}
            </span>
            {entry.code ? (
              <Badge tone="neutral">
                <bdi>{entry.code}</bdi>
              </Badge>
            ) : null}
            {unmatched ? (
              <Badge tone="warning">
                <CircleAlertIcon aria-hidden />
                {t('sales.import.names.toSettle')}
              </Badge>
            ) : null}
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {t('sales.import.names.sold', { qty: entry.qty })} ·{' '}
            <bdi className="tabular-nums">{money(entry.amount)}</bdi>
          </p>
        </div>
        {entry.match.state === 'matched' && !changing ? (
          <div className="flex items-center gap-2">
            <MatchedAs match={entry.match} />
            <Button
              type="button"
              variant="link"
              className="h-auto px-1"
              onClick={() => setChanging(true)}
            >
              {t('sales.import.names.change')}
            </Button>
          </div>
        ) : null}
      </div>
      {open ? (
        <div className="mt-3 space-y-3 rounded-xl bg-muted/40 p-3">
          {looksLike ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{t('sales.import.names.looksLike')}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-looks-like={looksLike}
                disabled={busy}
                onClick={() => answer(looksLike)}
              >
                {t(`sales.import.names.treatments.${looksLike}`)}
              </Button>
            </div>
          ) : null}
          {entry.match.state === 'unmatched' &&
          entry.match.suggestions &&
          entry.match.suggestions.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{t('sales.import.names.didYouMean')}</span>
              {entry.match.suggestions.map((suggestion) => (
                <Button
                  key={suggestion.id}
                  type="button"
                  size="sm"
                  variant="outline"
                  data-suggestion={suggestion.name}
                  disabled={busy}
                  onClick={() => answer('product', suggestion.id)}
                >
                  <bdi>{suggestion.name}</bdi>
                </Button>
              ))}
            </div>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <label htmlFor={`${ids}-product`} className="text-sm font-medium">
                {t('sales.import.names.pick')}
              </label>
              <NativeSelect
                id={`${ids}-product`}
                data-pick-product
                value=""
                disabled={busy}
                onChange={(event) => event.target.value && answer('product', event.target.value)}
              >
                <option value="">{t('sales.import.names.pickPlaceholder')}</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-wrap gap-2">
              {canAdd ? (
                <Button
                  type="button"
                  variant="outline"
                  data-add-new
                  disabled={busy}
                  onClick={() => answer('new', newId())}
                >
                  <PlusIcon aria-hidden />
                  {t('sales.import.names.addNew')}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                data-not-sold
                aria-expanded={notSold}
                disabled={busy}
                onClick={() => setNotSold((value) => !value)}
              >
                {t('sales.import.names.notSold')}
              </Button>
            </div>
          </div>
          {notSold ? (
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-medium">
                {t('sales.import.names.notSoldLegend')}
              </legend>
              {TREATMENTS.map((target) => (
                <button
                  key={target}
                  type="button"
                  data-treatment={target}
                  disabled={busy}
                  onClick={() => answer(target)}
                  className="flex w-full flex-col items-start rounded-lg border bg-card p-3 text-start transition-colors hover:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="font-medium">
                    {t(`sales.import.names.treatments.${target}`)}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {t(`sales.import.names.treatmentHints.${target}`)}
                  </span>
                </button>
              ))}
            </fieldset>
          ) : null}
          {changing ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setChanging(false)}>
              {t('sales.import.names.keep')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

/** A draft: its names (step 5) and its preview (step 6), then Finalize. */
function Draft({ data }: { data: SaleImportDto }) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const router = useRouter()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const refresh = useRefreshImports()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const { products: all } = useAllProducts(true)
  const match = useMutation(trpc.saleImport.match.mutationOptions())
  const setOverlap = useMutation(trpc.saleImport.setOverlap.mutationOptions())
  const post = useMutation(trpc.saleImport.post.mutationOptions())
  const discard = useMutation(trpc.saleImport.discard.mutationOptions())
  const [all_, setAll] = useState(false)
  const [error, setError] = useState<I18nKey | null>(null)
  const [confirm, setConfirm] = useState<'finalize' | 'discard' | 'addAll' | null>(null)
  const [confirmError, setConfirmError] = useState<I18nKey | null>(null)
  const products = useMemo(
    () =>
      [...all.values()]
        .filter((product) => product.archivedAt === null)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [all],
  )
  if (!context) return null
  const canAdd =
    can(context, 'products.items.manage') && context.modules.some((m) => m.id === 'products')
  // Replacing days reverses finalized sales: sale.reverse's key (the API refuses the rest, D-260).
  const canReverse = can(context, 'sales.documents.reverse')
  const unmatched = data.names.filter((n) => n.match.state === 'unmatched')
  const { add: toAdd, left } = namesToAddAll(data.names)
  const shown = all_ ? data.names : unmatched
  const percent =
    data.totalNames === 0 ? 100 : Math.floor((data.matchedNames / data.totalNames) * 100)
  const imported = data.days.filter((day) => day.state === 'imported')
  const posting =
    data.overlap === 'replace' ? data.days : data.days.filter((day) => day.state !== 'imported')
  const allRows = data.rowsReceived === data.rowCount
  const blocked = unmatched.length > 0 || !allRows || posting.length === 0
  // A summary over several days is one sale covering them ("1–30 Sep"), never "1 day".
  const onePeriod = posting.length === 1 && posting[0]!.periodFrom !== null ? posting[0]! : null
  const set = (next: SaleImportDto) =>
    queryClient.setQueryData(trpc.saleImport.get.queryKey({ id: data.id }), {
      data: next,
      meta: { redacted: [] },
    })

  async function answer(answers: ImportAnswerInput[]) {
    setError(null)
    try {
      const next = await match.mutateAsync({ id: data.id, answers })
      set(next.data)
      await refresh()
    } catch (caught) {
      setError(apiErrorKey(caught))
    }
  }

  /** "Add as new products": the names that look like nothing, once the person says yes. */
  async function addAll() {
    setConfirmError(null)
    try {
      const next = await match.mutateAsync({
        id: data.id,
        answers: toAdd.map((n) => ({
          name: n.name,
          code: n.code,
          target: 'new' as const,
          productId: newId(),
        })),
      })
      set(next.data)
      setConfirm(null)
      await refresh()
    } catch (caught) {
      setConfirmError(apiErrorKey(caught))
    }
  }

  async function overlap(choice: 'skip' | 'replace') {
    setError(null)
    try {
      const next = await setOverlap.mutateAsync({
        id: data.id,
        version: data.version,
        overlap: choice,
      })
      set(next.data)
    } catch (caught) {
      setError(apiErrorKey(caught))
    }
  }

  async function finalize() {
    setConfirmError(null)
    try {
      const next = await post.mutateAsync({ id: data.id, version: data.version })
      set(next.data)
      setConfirm(null)
      toast.success(t('sales.import.finalized', { file: isolate(data.fileName) }))
      await refresh()
    } catch (caught) {
      const code = apiErrorCode(caught)
      setConfirmError(code === 'conflict' ? 'sales.import.conflict' : apiErrorKey(caught))
      if (code === 'conflict' || code === 'import_unmatched') await refresh()
    }
  }

  async function drop() {
    setConfirmError(null)
    try {
      await discard.mutateAsync({ id: data.id, version: data.version })
      setConfirm(null)
      toast.success(t('sales.import.discarded'))
      await refresh()
      router.replace(`/b/${businessId}/sales?view=imports`)
    } catch (caught) {
      setConfirmError(apiErrorKey(caught))
    }
  }

  const headers: Partial<Record<number, string>> = {}
  for (const [field, column] of Object.entries(data.mapping.columns)) {
    const header = data.mapping.headers[field as keyof typeof data.mapping.headers]
    if (column !== undefined && header) headers[column] = header
  }

  return (
    <div className="max-w-3xl space-y-5">
      {error ? <FormAlert tone="error">{t(error)}</FormAlert> : null}
      <Panel
        title={t('sales.import.steps.names')}
        hint={t('sales.import.names.intro')}
        action={
          <span data-matched className="shrink-0 text-sm text-muted-foreground tabular-nums">
            {t('sales.import.names.settled', { done: data.matchedNames, total: data.totalNames })}
          </span>
        }
      >
        <div className="mb-4 h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
        </div>
        {data.vatRegistered && data.amountsIncludeVat ? (
          <p className="mb-3 text-sm text-muted-foreground">
            {t('sales.import.names.fileAmounts')}
          </p>
        ) : null}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex rounded-lg bg-muted p-1 text-sm">
            {([false, true] as const).map((value) => (
              <button
                key={String(value)}
                type="button"
                aria-pressed={all_ === value}
                onClick={() => setAll(value)}
                className={cn(
                  'rounded-md px-3 py-1.5 font-medium',
                  all_ === value ? 'bg-card shadow-sm' : 'text-muted-foreground',
                )}
              >
                {value ? t('sales.import.names.showAll') : t('sales.import.names.showToSettle')}
              </button>
            ))}
          </div>
          {canAdd && toAdd.length > 1 ? (
            <Button
              type="button"
              variant="outline"
              data-add-all
              disabled={match.isPending}
              onClick={() => {
                setConfirmError(null)
                setConfirm('addAll')
              }}
            >
              <SparklesIcon aria-hidden />
              {t('sales.import.names.addAll', { number: toAdd.length })}
            </Button>
          ) : null}
        </div>
        {canAdd && toAdd.length > 1 && left.length > 0 ? (
          <p data-add-all-left className="mb-3 text-sm text-muted-foreground">
            {t('sales.import.names.addAllLeft', { number: left.length })}
          </p>
        ) : null}
        {shown.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-success">
            <CheckCheckIcon aria-hidden className="size-4" />
            {t('sales.import.names.allSettled')}
          </p>
        ) : (
          <ul aria-label={t('sales.import.steps.names')} className="divide-y">
            {shown.map((entry) => (
              <NameRow
                key={`${entry.name}\u0000${entry.code ?? ''}`}
                entry={entry}
                products={products}
                canAdd={canAdd}
                busy={match.isPending}
                onAnswer={(a) => void answer([a])}
              />
            ))}
          </ul>
        )}
      </Panel>

      <Panel title={t('sales.import.steps.preview')} hint={t('sales.import.preview.intro')}>
        <ul className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <Figure label={t('sales.import.summary.rows')} value={String(data.rowsRead)} />
          <Figure label={t('sales.import.preview.days')} value={String(daysCovered(data.days))} />
          <Figure
            label={
              data.vatRegistered
                ? t('sales.import.preview.salesBeforeVat')
                : t('sales.import.preview.sales')
            }
            value={data.salesBeforeVat === null ? '—' : money(data.salesBeforeVat)}
            hint={data.salesBeforeVat === null ? t('sales.import.preview.afterNames') : undefined}
            id="sales-before-vat"
          />
          <Figure label={t('sales.import.preview.refunds')} value={money(data.refunds)} />
          <Figure label={t('sales.import.preview.matched')} value={`${percent}%`} />
          {typeof data.feesTotal === 'string' ? (
            <Figure label={t('sales.import.preview.fees')} value={money(data.feesTotal)} />
          ) : null}
        </ul>
        {data.rowsLeftOut > 0 ? (
          <div className="mt-4">
            <LeftOut errors={data.errors} count={data.rowsLeftOut} headers={headers} />
          </div>
        ) : null}
        <h3 className="mt-5 mb-2 font-medium">{t('sales.import.preview.daysTitle')}</h3>
        <ul aria-label={t('sales.import.preview.daysTitle')} className="divide-y rounded-xl border">
          {data.days.map((day) => (
            <li key={day.businessDate} data-import-day={day.businessDate} className="px-3 py-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  {day.periodFrom
                    ? t('sales.import.summary.daysRange', {
                        from: businessDate(day.periodFrom),
                        to: businessDate(day.businessDate),
                      })
                    : businessDate(day.businessDate)}
                </span>
                {/* Until its names are settled a day's rows are the file's own kind of amount (with
                    VAT, what is not sold in it): nothing is shown that would change after. */}
                <bdi data-day-amount className="text-sm tabular-nums">
                  {day.settled ? money(day.amount) : '—'}
                </bdi>
              </div>
              <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <Badge tone={day.state === 'imported' ? 'warning' : 'neutral'}>
                  {t(DAY_STATES[day.state])}
                </Badge>
                {day.importedBy?.fileName ? (
                  <span>
                    {t('sales.import.days.importedBy', { file: isolate(day.importedBy.fileName) })}
                  </span>
                ) : null}
                {day.otherSales ? (
                  <span data-other-sales className="text-warning">
                    {t('sales.import.days.otherSales')}
                  </span>
                ) : null}
              </p>
            </li>
          ))}
        </ul>
        {imported.length > 0 ? (
          <fieldset className="mt-4 space-y-2">
            <legend className="mb-1 font-medium">
              {t('sales.import.overlap.legend', { count: imported.length })}
            </legend>
            {(['skip', 'replace'] as const).map((choice) => {
              const locked = choice === 'replace' && !canReverse && data.overlap !== 'replace'
              return (
                <label
                  key={choice}
                  data-overlap={choice}
                  className={cn(
                    'flex items-start gap-3 rounded-xl border p-3',
                    locked ? 'cursor-not-allowed opacity-70' : 'cursor-pointer',
                    data.overlap === choice && 'border-primary bg-accent/40',
                  )}
                >
                  <input
                    type="radio"
                    name="overlap"
                    value={choice}
                    checked={data.overlap === choice}
                    disabled={setOverlap.isPending || locked}
                    onChange={() => void overlap(choice)}
                    className="mt-1 size-4 accent-primary"
                  />
                  <span>
                    <span className="block font-medium">{t(`sales.import.overlap.${choice}`)}</span>
                    <span className="block text-sm text-muted-foreground">
                      {locked
                        ? t('sales.import.overlap.replaceLocked')
                        : t(`sales.import.overlap.${choice}Hint`)}
                    </span>
                  </span>
                </label>
              )
            })}
          </fieldset>
        ) : null}
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          {t('sales.import.preview.costsNote')}
        </p>
        {data.unpricedMaterials && data.unpricedMaterials.length > 0 ? (
          <p data-unpriced className="mt-1 text-sm">
            {t('sales.import.preview.unpriced', {
              names: data.unpricedMaterials
                .map((m) => isolate(m.name))
                .join(t('sales.list.namesSeparator')),
            })}
          </p>
        ) : null}
        {typeof data.feesTotal === 'string' ? (
          <p className="mt-1 text-sm">
            {t('sales.import.preview.feesNote', {
              amount: money(data.feesTotal),
              channel: isolate(data.channelName),
              from: businessDate(data.periodFrom),
              to: businessDate(data.periodTo),
            })}
          </p>
        ) : null}
      </Panel>

      {unmatched.length > 0 ? (
        <FormAlert tone="info">
          {t('sales.import.toSettleFirst', { count: unmatched.length })}
        </FormAlert>
      ) : !allRows ? (
        <FormAlert tone="error">{t('sales.import.rowsMissing')}</FormAlert>
      ) : null}

      <div className="flex flex-wrap justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={() => setConfirm('discard')}
        >
          <Trash2Icon aria-hidden />
          {t('sales.import.discard')}
        </Button>
        <Button
          type="button"
          size="lg"
          data-finalize
          disabled={blocked}
          onClick={() => setConfirm('finalize')}
        >
          <CheckCheckIcon aria-hidden />
          {t('sales.import.finalize')}
        </Button>
      </div>

      <ConfirmDialog
        open={confirm === 'finalize'}
        icon={CheckCheckIcon}
        title={t('sales.import.confirm.title')}
        body={(() => {
          const values = {
            count: posting.length,
            channel: isolate(data.channelName),
            amount:
              data.salesBeforeVat === null
                ? ''
                : data.vatRegistered
                  ? `${money(data.salesBeforeVat)} ${t('sales.list.beforeVat')}`
                  : money(data.salesBeforeVat),
          }
          return onePeriod
            ? t('sales.import.confirm.bodyPeriod', {
                ...values,
                from: businessDate(onePeriod.periodFrom!),
                to: businessDate(onePeriod.businessDate),
                date: businessDate(onePeriod.businessDate),
              })
            : t('sales.import.confirm.body', values)
        })()}
        note={[
          imported.length > 0
            ? t(
                data.overlap === 'replace'
                  ? 'sales.import.confirm.replaceNote'
                  : 'sales.import.confirm.skipNote',
                { count: imported.length },
              )
            : t('sales.import.confirm.note'),
          posting.some((day) => day.otherSales) ? t('sales.import.confirm.otherSalesNote') : '',
        ]
          .filter(Boolean)
          .join(' ')}
        action={t('sales.import.finalize')}
        busyLabel={t('sales.import.finalizing')}
        busy={post.isPending}
        error={confirmError}
        onConfirm={() => void finalize()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'discard'}
        icon={Trash2Icon}
        title={t('sales.import.confirm.discardTitle')}
        body={t('sales.import.confirm.discardBody')}
        action={t('sales.import.discard')}
        busyLabel={t('sales.import.discarding')}
        busy={discard.isPending}
        error={confirmError}
        destructive
        onConfirm={() => void drop()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'addAll'}
        icon={SparklesIcon}
        title={t('sales.import.confirm.addAllTitle')}
        body={t('sales.import.confirm.addAllBody')}
        note={t('sales.import.confirm.addAllNote')}
        action={t('sales.import.confirm.addAllAction')}
        busyLabel={t('status.saving')}
        busy={match.isPending}
        error={confirmError}
        onConfirm={() => void addAll()}
        onClose={() => setConfirm(null)}
      >
        <ul data-add-all-names className="list-disc space-y-0.5 ps-5 text-sm">
          {toAdd.slice(0, ADD_ALL_LISTED).map((n) => (
            <li key={`${n.name}\u0000${n.code ?? ''}`}>
              <bdi>{n.name}</bdi>
              {n.code ? (
                <span className="text-muted-foreground">
                  {' · '}
                  <bdi>{n.code}</bdi>
                </span>
              ) : null}
            </li>
          ))}
          {toAdd.length > ADD_ALL_LISTED ? (
            <li className="list-none text-muted-foreground">
              {t('sales.import.confirm.addAllMore', { number: toAdd.length - ADD_ALL_LISTED })}
            </li>
          ) : null}
        </ul>
      </ConfirmDialog>
    </div>
  )
}

function Figure({
  label,
  value,
  hint,
  id,
}: {
  label: string
  value: string
  hint?: string
  id?: string
}) {
  return (
    <li data-figure={id}>
      <span className="block text-muted-foreground">{label}</span>
      <bdi className="font-medium tabular-nums">{value}</bdi>
      {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
    </li>
  )
}

/** A finalized (or reversed) import: its days and sales, a day or the whole of it reversed. */
function Finalized({ data }: { data: SaleImportDto }) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const refresh = useRefreshImports()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const reverse = useMutation(trpc.saleImport.reverse.mutationOptions())
  const [confirm, setConfirm] = useState<{ day: string | null } | null>(null)
  const [confirmError, setConfirmError] = useState<I18nKey | null>(null)
  const live = data.days.filter((day) => day.state === 'posted')
  // Reversing a day or the whole import is sale.reverse's (D-260); its statement is the channel's.
  const canReverse = context ? can(context, 'sales.documents.reverse') : false
  const seesStatements = context
    ? seesCosts(context) && can(context, 'sales.channels.manage')
    : false

  async function run(day: string | null) {
    setConfirmError(null)
    try {
      const next = await reverse.mutateAsync({ id: data.id, day })
      queryClient.setQueryData(trpc.saleImport.get.queryKey({ id: data.id }), next)
      setConfirm(null)
      toast.success(day ? t('sales.import.reversedDay') : t('sales.import.reversed'))
      await refresh()
    } catch (caught) {
      setConfirmError(apiErrorKey(caught))
    }
  }

  return (
    <div className="max-w-3xl space-y-5">
      {data.status === 'reversed' ? (
        <FormAlert tone="info">{t('sales.import.reversedNote')}</FormAlert>
      ) : null}
      <Panel
        title={t('sales.import.finalizedTitle')}
        action={
          data.status === 'posted' && canReverse ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              data-reverse-all
              onClick={() => setConfirm({ day: null })}
            >
              <Undo2Icon aria-hidden />
              {t('sales.import.reverseAll')}
            </Button>
          ) : null
        }
      >
        <ul className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <Figure
            label={
              data.vatRegistered
                ? t('sales.import.preview.salesBeforeVat')
                : t('sales.import.preview.sales')
            }
            value={money(data.amount)}
            id="sales-before-vat"
          />
          <Figure label={t('sales.import.preview.days')} value={String(daysCovered(live))} />
          <Figure label={t('sales.import.summary.rows')} value={String(data.rowsRead)} />
        </ul>
        {data.replacedDays.length > 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            {t('sales.import.replacedNote', {
              days: data.replacedDays
                .map((d) => businessDate(d))
                .join(t('sales.list.namesSeparator')),
            })}
          </p>
        ) : null}
        {data.statementId ? (
          <p className="mt-2 text-sm">
            {t('sales.import.statementMade', { channel: isolate(data.channelName) })}{' '}
            {seesStatements ? (
              <Link
                href={`/b/${businessId}/settings/channels/${data.channelId}`}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                {t('sales.import.openStatements')}
              </Link>
            ) : null}
          </p>
        ) : null}
        <h3 className="mt-5 mb-2 font-medium">{t('sales.import.preview.daysTitle')}</h3>
        <ul aria-label={t('sales.import.preview.daysTitle')} className="divide-y rounded-xl border">
          {data.days.map((day) => (
            <li
              key={day.businessDate}
              data-import-day={day.businessDate}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="font-medium">
                  {day.periodFrom
                    ? t('sales.import.summary.daysRange', {
                        from: businessDate(day.periodFrom),
                        to: businessDate(day.businessDate),
                      })
                    : businessDate(day.businessDate)}
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <Badge tone={day.state === 'posted' ? 'success' : 'neutral'}>
                    {t(DAY_STATES[day.state])}
                  </Badge>
                  {day.state === 'posted' ? (
                    <bdi className="tabular-nums">{money(day.amount)}</bdi>
                  ) : null}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {/* The day's sale, and its refund when more was refunded than sold of something. */}
                {day.saleIds.map((saleId) => {
                  const refund = day.refundIds.includes(saleId)
                  return (
                    <Button key={saleId} asChild variant="outline" size="sm">
                      <Link
                        href={`/b/${businessId}/sales/${saleId}`}
                        data-open-sale={refund ? 'refund' : 'sale'}
                      >
                        <FileSearchIcon aria-hidden />
                        {refund ? t('sales.import.openRefund') : t('sales.import.openSale')}
                      </Link>
                    </Button>
                  )
                })}
                {day.state === 'posted' &&
                data.status === 'posted' &&
                canReverse &&
                live.length > 1 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    data-reverse-day
                    onClick={() => setConfirm({ day: day.businessDate })}
                  >
                    <Undo2Icon aria-hidden />
                    {t('sales.import.reverseDay')}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </Panel>
      <ConfirmDialog
        open={confirm !== null}
        icon={Undo2Icon}
        title={
          confirm?.day
            ? t('sales.import.confirm.reverseDayTitle')
            : t('sales.import.confirm.reverseTitle')
        }
        body={
          confirm?.day
            ? t('sales.import.confirm.reverseDayBody', { date: businessDate(confirm.day) })
            : t('sales.import.confirm.reverseBody', { file: isolate(data.fileName) })
        }
        note={t('sales.import.confirm.reverseNote')}
        action={confirm?.day ? t('sales.import.reverseDay') : t('sales.import.reverseAll')}
        busyLabel={t('sales.import.reversing')}
        busy={reverse.isPending}
        error={confirmError}
        destructive
        onConfirm={() => void run(confirm?.day ?? null)}
        onClose={() => setConfirm(null)}
      />
    </div>
  )
}

function ImportPage({ importId }: { importId: string }) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const businessDate = useBusinessDate()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const allowed = context ? mayImport(context) : false
  const query = useQuery({
    ...trpc.saleImport.get.queryOptions({ id: importId }),
    enabled: allowed,
    retry: (count, error) => apiErrorCode(error) !== 'not_found' && count < 2,
  })
  if (!context) return null
  const back = (
    <Link
      href={`/b/${businessId}/sales?view=imports`}
      className="-ms-2 -mt-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:underline"
    >
      <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
      {t('sales.import.backToImports')}
    </Link>
  )
  if (!allowed || (query.isError && apiErrorCode(query.error) === 'not_found')) {
    return (
      <PageContainer>
        {back}
        <StatePanel
          icon={FileSpreadsheetIcon}
          title={t('sales.import.notFound')}
          body={t('sales.import.notFoundBody')}
          documentTitle={`${t('sales.import.notFound')} · ${t('appName')}`}
        />
      </PageContainer>
    )
  }
  const data = query.data?.data
  return (
    <PageContainer>
      {back}
      {query.isPending ? (
        <SectionSkeleton cards={2} />
      ) : query.isError ? (
        <LoadError error={query.error} onRetry={() => void query.refetch()} />
      ) : data ? (
        <>
          <header className="mb-6 max-w-3xl">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="min-w-0 text-2xl font-semibold tracking-tight break-all sm:text-3xl">
                <bdi>{data.fileName}</bdi>
              </h1>
              <ImportStatus status={data.status} />
            </div>
            <p className="mt-1.5 text-muted-foreground">
              <bdi>{data.channelName}</bdi>
              {context.capabilities.multi_location ? (
                <>
                  {' · '}
                  <bdi>{data.locationName}</bdi>
                </>
              ) : null}
              {' · '}
              {data.periodFrom === data.periodTo
                ? businessDate(data.periodTo)
                : t('sales.import.summary.daysRange', {
                    from: businessDate(data.periodFrom),
                    to: businessDate(data.periodTo),
                  })}
              {data.enteredByName ? (
                <>
                  {' · '}
                  <bdi>{data.enteredByName}</bdi>
                </>
              ) : null}
            </p>
          </header>
          {data.status === 'draft' ? <Draft data={data} /> : <Finalized data={data} />}
        </>
      ) : null}
    </PageContainer>
  )
}

/** An import's page, inside the Sales module's gate. */
export function ImportViewPage({ importId }: { importId: string }) {
  return (
    <ModuleGate moduleId="sales" entryId="sales">
      <ImportPage importId={importId} />
    </ModuleGate>
  )
}
