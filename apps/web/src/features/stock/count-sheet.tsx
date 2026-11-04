'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import {
  COUNT_PARTS_MAX,
  type CountDto,
  type CountLineDto,
  type CountLineResultDto,
  type CountResultDto,
  type StockMaterialDto,
} from '@bizcost/contracts'
import { nameKey, type Quantity } from '@bizcost/domain'
import { formatDate, type I18nKey } from '@bizcost/i18n'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftIcon,
  CheckCheckIcon,
  MinusIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { useBeforeNavigate, useUnsavedChanges } from '@/components/form/unsaved-changes'
import { isolate } from '@/components/form/use-message'
import { PageContainer } from '@/components/shell/page-container'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { useUnitQuantity } from '@/features/catalog/unit-parts'
import { UNITS_BY_DIMENSION } from '@/features/catalog/units'
import { withLatinDigits, type FieldError } from '@/features/catalog/numbers'
import { useBusinessDate } from '@/features/documents/amounts'
import { ConfirmDialog } from '@/features/documents/confirm-dialog'
import { LineMessages } from '@/features/documents/line-editor'
import { Panel } from '@/features/documents/panel'
import { refusalOf, type Refusal } from '@/features/documents/refusal'
import { StatusBadge } from '@/features/documents/status-badge'
import { dimensionsOf, quantityInWords, type LineUnit } from '@/features/purchasing/line-units'
import { useLocale, useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import {
  checkLine,
  lineDraftOf,
  stepCount,
  withPart,
  type LineDraft,
  type PartDraft,
} from './count-draft'
import { CountEdits, nextEdit, shownEdit } from './count-edits'
import { hasBranches, mayChangeCount, useRefreshStock } from './data'
import { AddItemsSheet } from './pick-sheets'
import { useStockText } from './quantity'

// A draft count's sheet (M4 Step 2; D-339 Q6), phone first: every line in the member's branches, a
// search, "Not counted yet", and per line the parts as counted ("12 cartons + 3 bottles": a quantity
// with − / + and a unit or pack each, more than one allowed), saved line by line with who counted it
// and when, so several people fill one sheet. A line someone else saved in between (CONFLICT) is read
// again and shows what they counted; the sheet is read again every little while (count-page.tsx).
// Blind: nothing here says what the book expects, for anyone; a manager compares on the review.
// Leaving with a line typed and not saved asks first (D-161). A sheet may hold a thousand lines: what
// is typed lives in a store by line (count-edits.ts), so a keystroke re-renders its own line only.

/** "Counted by Sara, 10:42" (today), "…, 30 Oct 2026, 18:05" (another day). */
function useCountedWhen() {
  const { t } = useTranslation()
  const { locale } = useLocale()
  return (line: CountLineDto): string => {
    if (!line.countedAt) return t('stock.sheet.waiting')
    const at = new Date(line.countedAt)
    const today = new Date().toDateString() === at.toDateString()
    const time = formatDate(
      locale,
      line.countedAt,
      today ? { timeStyle: 'short' } : { dateStyle: 'medium', timeStyle: 'short' },
    )
    if (line.countedByMe) return t('stock.sheet.countedByYou', { time })
    if (line.countedByName)
      return t('stock.sheet.countedBy', { name: isolate(line.countedByName), time })
    return t('stock.sheet.countedAt', { time })
  }
}

/** A part's unit: the material's packs (with what one holds), then its units by kind of measure. */
function PartUnitSelect({
  material,
  value,
  label,
  invalid,
  onChange,
}: {
  material: StockMaterialDto
  value: LineUnit
  label: string
  invalid: boolean
  onChange: (unit: LineUnit) => void
}) {
  const { t } = useTranslation()
  const unitQuantity = useUnitQuantity()
  return (
    <NativeSelect
      aria-label={label}
      aria-invalid={invalid}
      value={value}
      onChange={(event) => onChange(event.target.value as LineUnit)}
      className="min-w-0 flex-1"
    >
      {material.packs.length > 0 ? (
        <optgroup label={t('stock.sheet.packs')}>
          {material.packs.map((pack) => {
            const holds = quantityInWords(material, '1' as Quantity, { pack: pack.id })
            const last = holds?.at(-1)
            return (
              <option key={pack.id} value={`pack:${pack.id}`}>
                {last?.kind === 'unit'
                  ? `${pack.name} (${unitQuantity(last.qty, last.unit)})`
                  : pack.name}
              </option>
            )
          })}
        </optgroup>
      ) : null}
      {dimensionsOf(material).map((dimension) => (
        <optgroup key={dimension} label={t(`units.dimensions.${dimension}`)}>
          {UNITS_BY_DIMENSION[dimension].map((unit) => (
            <option key={unit} value={`unit:${unit}`}>
              {t(`units.names.${unit}`)}
            </option>
          ))}
        </optgroup>
      ))}
    </NativeSelect>
  )
}

/**
 * One part: − / the quantity / + and its unit or pack, and × when the line has more than one. On a
 * line of several parts, each control says which part it is ("How many, Milk, part 2").
 */
function PartRow({
  material,
  part,
  name,
  number,
  error,
  unitInvalid,
  removable,
  onChange,
  onRemove,
  describedBy,
}: {
  material: StockMaterialDto
  part: PartDraft
  name: string
  /** Its place on a line of several parts (1, 2…); null on a line of one. */
  number: number | null
  error: string | undefined
  unitInvalid: boolean
  removable: boolean
  onChange: (next: Partial<PartDraft>) => void
  onRemove: () => void
  describedBy: string | undefined
}) {
  const { t } = useTranslation()
  const which = number === null ? { name } : { name, part: number }
  return (
    <div data-count-part className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={
            number === null ? t('stock.sheet.less', which) : t('stock.sheet.lessPart', which)
          }
          onClick={() => onChange({ qty: stepCount(part.qty, -1) })}
          className="size-11 shrink-0 rounded-full"
        >
          <MinusIcon aria-hidden />
        </Button>
        <Input
          aria-label={
            number === null ? t('stock.sheet.qtyFor', which) : t('stock.sheet.qtyForPart', which)
          }
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          inputMode="decimal"
          dir="ltr"
          autoComplete="off"
          spellCheck={false}
          placeholder="0"
          value={part.qty}
          onChange={(event) => onChange({ qty: event.target.value })}
          onBlur={() => onChange({ qty: withLatinDigits(part.qty) })}
          className="w-20 text-center tabular-nums"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={
            number === null ? t('stock.sheet.more', which) : t('stock.sheet.morePart', which)
          }
          onClick={() => onChange({ qty: stepCount(part.qty, 1) })}
          className="size-11 shrink-0 rounded-full"
        >
          <PlusIcon aria-hidden />
        </Button>
      </div>
      <div className="flex min-w-44 flex-1 items-center gap-1">
        <PartUnitSelect
          material={material}
          value={part.unit}
          label={
            number === null ? t('stock.sheet.unitFor', which) : t('stock.sheet.unitForPart', which)
          }
          invalid={unitInvalid}
          onChange={(unit) => onChange({ unit })}
        />
        {removable && number !== null ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('stock.sheet.removePart', { name, part: number })}
            onClick={onRemove}
            className="size-11 shrink-0 text-muted-foreground"
          >
            <XIcon aria-hidden />
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/** A line's edit, read from the sheet's store (this line re-renders alone when it changes). */
function useLineEdit(edits: CountEdits, lineId: string) {
  const subscribe = useCallback(
    (listener: () => void) => edits.subscribeLine(lineId, listener),
    [edits, lineId],
  )
  const read = () => edits.get(lineId)
  return useSyncExternalStore(subscribe, read, read)
}

/** One line of the sheet: its name (and branch), its parts, what they come to, and Save. */
const LineRow = memo(function LineRow({
  line,
  material,
  branchName,
  edits,
  busy,
  serverError,
  removable,
  tried,
  onSave,
  onRemoveLine,
}: {
  line: CountLineDto
  material: StockMaterialDto
  /** Said beside the name on a first count with branches. */
  branchName: string | null
  edits: CountEdits
  busy: boolean
  serverError: I18nKey | null
  /** "Take off the count" (a manager who may change this count). */
  removable: boolean
  /** Save was tried (here or from the unsaved-changes question): a box left empty says so. */
  tried: boolean
  onSave: (lineId: string) => void
  onRemoveLine: (lineId: string) => void
}) {
  const { t } = useTranslation()
  const countedWhen = useCountedWhen()
  const stockText = useStockText()
  const messagesId = useId()
  const edit = shownEdit(useLineEdit(edits, line.id), line)
  const saved = useMemo(() => lineDraftOf(line, material), [line, material])
  const draft = edit?.draft ?? saved
  const dirty = edit !== undefined && edit.version !== null
  const check = useMemo(() => checkLine(material, draft), [material, draft])
  const shown = (error: FieldError | undefined) =>
    error && (tried || error.key !== 'catalog.numbers.required')
      ? t(error.key, error.values)
      : undefined
  const messages = [
    ...draft.map((part) => shown(check.errors[part.key])).filter((m): m is string => Boolean(m)),
    ...(serverError ? [t(serverError)] : []),
  ]
  const name = isolate(material.name)
  const counted = line.countedQty !== null
  const change = (next: LineDraft) => edits.set(line.id, nextEdit(edit, next, line, material))
  const set = (key: string, next: Partial<PartDraft>) =>
    change(draft.map((part) => (part.key === key ? { ...part, ...next } : part)))
  return (
    <li
      data-count-line={line.id}
      data-counted={counted ? 'true' : 'false'}
      className="space-y-3 py-4 first:pt-0 last:pb-0"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <p className="font-medium break-words">
            <bdi>{material.name}</bdi>
            {branchName ? (
              <span className="font-normal text-muted-foreground">
                {' · '}
                <bdi>{branchName}</bdi>
              </span>
            ) : null}
          </p>
          <p
            data-counted-when
            aria-live="polite"
            className={cn('text-xs', counted ? 'text-success' : 'text-muted-foreground')}
          >
            {countedWhen(line)}
          </p>
        </div>
        {removable ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            aria-label={t('stock.sheet.removeLineFor', { name })}
            onClick={() => onRemoveLine(line.id)}
            className="h-9 text-muted-foreground"
          >
            <Trash2Icon aria-hidden />
            <span className="max-sm:sr-only">{t('stock.sheet.removeLine')}</span>
          </Button>
        ) : null}
      </div>
      <div className="space-y-2">
        {draft.map((part, index) => {
          const error = check.errors[part.key]
          return (
            <PartRow
              key={part.key}
              material={material}
              part={part}
              name={name}
              number={draft.length > 1 ? index + 1 : null}
              error={shown(error)}
              unitInvalid={error?.key === 'stock.sheet.unitRequired'}
              removable={draft.length > 1}
              describedBy={messages.length > 0 ? messagesId : undefined}
              onChange={(next) => set(part.key, next)}
              onRemove={() => change(draft.filter((p) => p.key !== part.key))}
            />
          )
        })}
      </div>
      <LineMessages id={messagesId} messages={messages} className="mt-0" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {draft.length < COUNT_PARTS_MAX ? (
            <Button
              type="button"
              variant="link"
              className="h-11 px-0"
              onClick={() => change(withPart(material, draft))}
            >
              <PlusIcon aria-hidden />
              {t('stock.sheet.addPart')}
            </Button>
          ) : null}
          {check.base !== null ? (
            <span data-comes-to className="text-sm text-muted-foreground tabular-nums">
              {t('stock.sheet.comesTo', { qty: isolate(stockText(material, check.base)) })}
            </span>
          ) : null}
        </div>
        <Button
          type="button"
          variant={dirty ? 'default' : 'outline'}
          disabled={busy || !dirty}
          aria-label={t('stock.sheet.saveFor', { name })}
          onClick={() => onSave(line.id)}
        >
          {busy
            ? t('status.saving')
            : dirty || !counted
              ? t('stock.sheet.save')
              : t('stock.sheet.saved')}
        </Button>
      </div>
    </li>
  )
})

/** One more or one fewer in a set kept in state. */
function withOne(set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  if (set.has(id) === on) return set
  const next = new Set(set)
  if (on) next.add(id)
  else next.delete(id)
  return next
}

/** The draft's sheet, with the actions a manager has (review, add, take off, discard). */
export function CountSheet({ result }: { result: CountResultDto }) {
  const { t } = useTranslation()
  const term = useTerminology()
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  const refresh = useRefreshStock()
  const beforeNavigate = useBeforeNavigate()
  const businessDate = useBusinessDate()
  const { locale } = useLocale()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const count: CountDto = result.data
  const save = useMutation(trpc.count.saveLine.mutationOptions())
  const removeLine = useMutation(trpc.count.removeLine.mutationOptions())
  const discard = useMutation(trpc.count.discard.mutationOptions())
  const [edits] = useState(() => new CountEdits())
  const changed = useSyncExternalStore(edits.subscribe, edits.changed, edits.changed)
  const [errors, setErrors] = useState<Readonly<Record<string, I18nKey>>>({})
  const [busyLines, setBusyLines] = useState<ReadonlySet<string>>(new Set())
  const [tried, setTried] = useState<ReadonlySet<string>>(new Set())
  const [find, setFind] = useState('')
  const [notCountedOnly, setNotCountedOnly] = useState(false)
  const [branch, setBranch] = useState<string>('')
  const [sheet, setSheet] = useState<'add' | null>(null)
  const [confirm, setConfirm] = useState<'discard' | { remove: string } | null>(null)
  const [confirmError, setConfirmError] = useState<Refusal | null>(null)
  const findId = useId()
  const materials = useMemo(
    () => new Map(count.materials.map((material) => [material.id, material])),
    [count.materials],
  )
  const countKey = trpc.count.get.queryKey({ id: count.id })
  const reviewKey = trpc.count.review.queryKey({ id: count.id })
  const listHref = `/b/${businessId}/stock/counts`
  const opening = count.kind === 'opening'
  // Discard, add, review and take off: a manager, and on a first count one who works in every branch.
  const changes = context !== undefined && mayChangeCount(context, count.kind)
  const profile = context?.terminologyProfile
  // A first count has a line per branch per item: with several branches, each line names its branch
  // and the sheet can show one branch at a time (people count one branch at a time).
  const branchNames = useMemo(
    () => new Map(count.lines.map((line) => [line.locationId, line.locationName] as const)),
    [count.lines],
  )
  const branchIds = [...branchNames.keys()]
  // The newest count and what the callbacks read, so the lines' callbacks never change.
  const latest = useRef({ count, materials })
  useLayoutEffect(() => {
    latest.current = { count, materials }
  })

  function lineOf(lineId: string): CountLineDto | undefined {
    return latest.current.count.lines.find((line) => line.id === lineId)
  }

  function patchLine(saved: CountLineDto) {
    queryClient.setQueryData(countKey, (old: CountResultDto | undefined) => {
      if (!old) return old
      const lines = old.data.lines.map((line) => (line.id === saved.id ? saved : line))
      return {
        ...old,
        data: {
          ...old.data,
          lines,
          countedCount: lines.filter((line) => line.countedQty !== null).length,
        },
      }
    })
  }

  function busyWith(lineId: string, on: boolean) {
    setBusyLines((current) => withOne(current, lineId, on))
  }

  /** Saves one line; true once saved (the line says why otherwise). */
  async function saveLine(lineId: string): Promise<boolean> {
    const line = lineOf(lineId)
    if (!line) return false
    const material = latest.current.materials.get(line.materialId)!
    const edit = shownEdit(edits.get(lineId), line)
    if (!edit || edit.version === null) return true
    setTried((current) => withOne(current, lineId, true))
    const check = checkLine(material, edit.draft)
    if (!check.parts) return false
    setErrors(({ [lineId]: _, ...rest }) => rest)
    busyWith(lineId, true)
    try {
      const saved: CountLineResultDto = await save.mutateAsync({
        countId: count.id,
        lineId,
        parts: check.parts,
        version: edit.version,
      })
      patchLine(saved.data)
      edits.set(lineId, undefined)
      setTried((current) => withOne(current, lineId, false))
      void queryClient.invalidateQueries({ queryKey: trpc.count.list.pathKey() })
      void queryClient.invalidateQueries({ queryKey: reviewKey })
      return true
    } catch (error) {
      const code = apiErrorCode(error)
      if (code === 'conflict') {
        // Someone else saved it in between: it reloads and shows what they counted.
        toast.error(t('stock.sheet.conflict'))
        edits.set(lineId, undefined)
        await queryClient.invalidateQueries({ queryKey: countKey })
      } else if (code === 'document_posted' || code === 'not_found') {
        // A manager finalized the count or took the line off it: read it as it is now.
        toast.error(t('stock.sheet.gone'))
        edits.set(lineId, undefined)
        await queryClient.invalidateQueries({ queryKey: countKey })
      } else {
        setErrors((current) => ({ ...current, [lineId]: apiErrorKey(error) }))
      }
      return false
    } finally {
      busyWith(lineId, false)
    }
  }

  async function saveAll(): Promise<boolean> {
    let ok = true
    for (const lineId of edits.changed()) ok = (await saveLine(lineId)) && ok
    return ok
  }

  useUnsavedChanges({ dirty: changed.size > 0, save: saveAll })

  /**
   * Takes a line off the count (counted or not). A first count covers every branch, so a material
   * goes off it in each of them (finalizing needs each of its materials in every branch).
   */
  async function takeOff(lineId: string) {
    const line = lineOf(lineId)
    if (!line) return
    const material = materials.get(line.materialId)!
    const lines = opening
      ? latest.current.count.lines.filter((other) => other.materialId === line.materialId)
      : [line]
    setConfirmError(null)
    for (const each of lines) busyWith(each.id, true)
    try {
      let updated: CountResultDto | undefined
      for (const each of lines) {
        updated = await removeLine.mutateAsync({
          countId: count.id,
          lineId: each.id,
          version: each.version,
        })
        edits.set(each.id, undefined)
      }
      if (updated) queryClient.setQueryData(countKey, updated)
      void queryClient.invalidateQueries({ queryKey: trpc.count.list.pathKey() })
      void queryClient.invalidateQueries({ queryKey: reviewKey })
      toast.success(t('stock.sheet.removed', { name: isolate(material.name) }))
      setConfirm(null)
    } catch (error) {
      const code = apiErrorCode(error)
      setConfirmError(code === 'conflict' ? 'stock.sheet.conflict' : refusalOf(error, locale))
      await queryClient.invalidateQueries({ queryKey: countKey })
    } finally {
      for (const each of lines) busyWith(each.id, false)
    }
  }

  async function doDiscard() {
    setConfirmError(null)
    try {
      await discard.mutateAsync({ id: count.id, version: count.version })
      discarded.current = true
      edits.clear()
      // The count is gone: its own queries are left alone (no NOT_FOUND on the way out).
      await Promise.all([
        queryClient.cancelQueries({ queryKey: countKey }),
        queryClient.cancelQueries({ queryKey: reviewKey }),
      ])
      toast.success(t('stock.confirm.discarded'))
      await beforeNavigate()
      router.replace(listHref)
      void refresh(count.id)
    } catch (error) {
      const code = apiErrorCode(error)
      setConfirmError(code === 'conflict' ? 'stock.review.conflict' : refusalOf(error, locale))
      if (code === 'conflict') await queryClient.invalidateQueries({ queryKey: countKey })
    }
  }

  const saveRef = useRef(saveLine)
  useLayoutEffect(() => {
    saveRef.current = saveLine
  })
  const onSave = useCallback((lineId: string) => void saveRef.current(lineId), [])
  const onRemoveLine = useCallback((lineId: string) => {
    setConfirmError(null)
    setConfirm({ remove: lineId })
  }, [])

  // Once a discarded draft's page is left, its own queries go (it is never read again).
  const discarded = useRef(false)
  const countId = count.id
  useEffect(
    () => () => {
      if (!discarded.current) return
      queryClient.removeQueries({ queryKey: trpc.count.get.queryKey({ id: countId }) })
      queryClient.removeQueries({ queryKey: trpc.count.review.queryKey({ id: countId }) })
    },
    [queryClient, trpc, countId],
  )

  const findKey = nameKey(find)
  const shownLines = count.lines.filter((line) => {
    if (notCountedOnly && line.countedQty !== null && !changed.has(line.id)) return false
    if (branch && line.locationId !== branch) return false
    if (findKey && !nameKey(materials.get(line.materialId)?.name ?? '').includes(findKey))
      return false
    return true
  })
  const title = t(opening ? 'stock.sheet.openingTitle' : 'stock.sheet.title', {
    date: businessDate(count.businessDate),
  })
  const where = opening
    ? context && hasBranches(context)
      ? t('stock.counts.everyBranch')
      : null
    : context && hasBranches(context)
      ? count.locationName
      : null
  const removing =
    confirm !== null && confirm !== 'discard'
      ? (count.lines.find((line) => line.id === confirm.remove) ?? null)
      : null
  // A count has one branch, and a first count takes a material off in every branch: its name says it.
  const removingName = removing ? isolate(materials.get(removing.materialId)?.name ?? '') : ''

  return (
    <PageContainer>
      <Link
        href={listHref}
        className="-ms-2 -mt-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
        {t('stock.tabs.counts')}
      </Link>
      <header className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
            <StatusBadge status={count.status} kind="count" />
          </div>
          <p data-count-progress className="mt-1.5 text-muted-foreground">
            {where ? (
              <>
                <bdi>{where}</bdi>
                {' · '}
              </>
            ) : null}
            {t('stock.counts.progress', { counted: count.countedCount, total: count.lineCount })}
          </p>
        </div>
        {changes ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                setConfirmError(null)
                setConfirm('discard')
              }}
            >
              <Trash2Icon aria-hidden />
              {t('stock.sheet.discard')}
            </Button>
            <Button variant="outline" onClick={() => setSheet('add')}>
              <PlusIcon aria-hidden />
              {term('stock.sheet.addItems', profile)}
            </Button>
            <Button asChild>
              <Link href={`${listHref}/${count.id}/review`}>
                <CheckCheckIcon aria-hidden />
                {t('stock.sheet.review')}
              </Link>
            </Button>
          </div>
        ) : null}
      </header>

      <div className="space-y-5">
        <FormAlert tone="info">
          {opening ? term('stock.sheet.openingNote', profile) : t('stock.sheet.blindNote')}
        </FormAlert>
        {count.note ? (
          <p className="text-sm">
            <span className="text-muted-foreground">{t('stock.view.note')}: </span>
            <bdi dir="auto">{count.note}</bdi>
          </p>
        ) : null}
        <Panel title={t('stock.view.lines')}>
          {count.lines.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {changes ? term('stock.sheet.noLines', profile) : t('stock.sheet.notYours')}
            </p>
          ) : (
            <>
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
                <div role="search" className="relative min-w-0 flex-1">
                  <SearchIcon
                    aria-hidden
                    className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    id={findId}
                    type="search"
                    aria-label={t('stock.sheet.find')}
                    placeholder={t('stock.sheet.find')}
                    autoComplete="off"
                    value={find}
                    onChange={(event) => setFind(event.target.value)}
                    className="ps-9 [unicode-bidi:plaintext]"
                  />
                </div>
                {branchIds.length > 1 ? (
                  <NativeSelect
                    aria-label={t('stock.sheet.branch')}
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                    className="sm:w-56"
                  >
                    <option value="">{t('stock.onHand.allBranches')}</option>
                    {branchIds.map((id) => (
                      <option key={id} value={id}>
                        {branchNames.get(id) ?? ''}
                      </option>
                    ))}
                  </NativeSelect>
                ) : null}
                <label className="flex min-h-11 shrink-0 cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={notCountedOnly}
                    onChange={(event) => setNotCountedOnly(event.target.checked)}
                    className="size-5 accent-primary"
                  />
                  {t('stock.sheet.notCountedOnly')}
                </label>
              </div>
              {shownLines.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {notCountedOnly && !findKey
                    ? t('stock.sheet.allCounted')
                    : t('stock.sheet.noMatch')}
                </p>
              ) : (
                <ul aria-label={t('stock.view.lines')} className="divide-y">
                  {shownLines.map((line) => (
                    <LineRow
                      key={line.id}
                      line={line}
                      material={materials.get(line.materialId)!}
                      branchName={
                        branchIds.length > 1 ? (branchNames.get(line.locationId) ?? null) : null
                      }
                      edits={edits}
                      busy={busyLines.has(line.id)}
                      serverError={errors[line.id] ?? null}
                      removable={changes}
                      tried={tried.has(line.id)}
                      onSave={onSave}
                      onRemoveLine={onRemoveLine}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </Panel>
      </div>

      {sheet === 'add' ? <AddItemsSheet count={count} onClose={() => setSheet(null)} /> : null}
      <ConfirmDialog
        open={confirm === 'discard'}
        icon={Trash2Icon}
        title={t('stock.confirm.discardTitle')}
        body={t('stock.confirm.discardBody')}
        action={t('stock.confirm.discard')}
        busyLabel={t('stock.confirm.discarding')}
        busy={discard.isPending}
        error={confirm === 'discard' ? confirmError : null}
        destructive
        onConfirm={() => void doDiscard()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={removing !== null}
        icon={Trash2Icon}
        title={t('stock.sheet.removeTitle', { name: removingName })}
        body={t('stock.sheet.removeBody')}
        action={t('stock.sheet.removeAction')}
        busyLabel={t('stock.sheet.removing')}
        busy={removeLine.isPending}
        error={removing !== null ? confirmError : null}
        destructive
        onConfirm={() => removing && void takeOff(removing.id)}
        onClose={() => setConfirm(null)}
      />
    </PageContainer>
  )
}
