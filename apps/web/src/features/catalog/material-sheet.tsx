'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import {
  MATERIAL_CROSS_FACTORS_MAX,
  MATERIAL_PACKS_MAX,
  type MaterialDto,
} from '@bizcost/contracts'
import {
  DIMENSIONS,
  dimensionOf,
  newId,
  type Dimension,
  type StandardUnit,
  type TerminologyProfile,
} from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { PlusIcon, Trash2Icon } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { TextField } from '@/components/form/text-field'
import { isolate } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useTerminology } from '@/lib/i18n/client'
import {
  checkMaterial,
  draftUnits,
  formName,
  materialDraft,
  newCross,
  newPack,
  type CrossDraft,
  type CrossErrors,
  type MaterialDraft,
  type PackDraft,
  type PackErrors,
  type PackOf,
} from './material-draft'
import { withLatinDigits, type FieldError } from './numbers'
import { PackChainText, UnitSelect } from './unit-parts'
import { packChain } from './units'

// Add or edit a material (M2 Step 2; D-122): its name, the unit it is used in, the packs it is
// bought in and, when it is bought in another kind of measure, a conversion. Each pack says its chain
// in words as it is typed ("1 carton = 12 bottles = 12 L"), checked by the domain units engine;
// the API checks the same set again before anything is saved.

/** Problems that only say something is missing: shown once the person tries to save. */
const MISSING: ReadonlySet<I18nKey> = new Set<I18nKey>([
  'catalog.form.nameRequired',
  'catalog.form.pickUnit',
  'catalog.materials.unitRequired',
  'catalog.materials.packs.nameRequired',
  'catalog.materials.packs.unknown',
  'catalog.numbers.required',
])

/** The pack's unit box's last entry: add a conversion to another kind of measure. */
const OTHER_KIND = 'other-kind'

/** Typed text reads in its own direction, in a box laid out in the page's direction. */
const OWN_DIRECTION = '[unicode-bidi:plaintext]'

function useShownError(submitted: boolean) {
  const { t } = useTranslation()
  return (error: FieldError | undefined): string | undefined => {
    if (!error || (!submitted && MISSING.has(error.key))) return undefined
    const chain = error.chain
      ?.map((name) => isolate(name))
      .join(t('catalog.materials.packs.loopArrow'))
    return t(error.key, chain === undefined ? error.values : { ...error.values, chain })
  }
}

/** A row's messages, under it, read out when they change. */
function RowErrors({ id, messages }: { id: string; messages: readonly string[] }) {
  if (messages.length === 0) return null
  return (
    <div id={id} role="alert" className="mt-2 space-y-1 text-sm text-destructive">
      {messages.map((message) => (
        <p key={message}>{message}</p>
      ))}
    </div>
  )
}

/** "1" and "=" in their column, so the inputs of every row line up. */
function Sign({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="w-5 shrink-0 text-center text-sm font-medium text-muted-foreground"
    >
      {children}
    </span>
  )
}

function PackRow({
  index,
  pack,
  draft,
  errors,
  shown,
  chain,
  onChange,
  onRemove,
  onOtherKind,
}: {
  index: number
  pack: PackDraft
  draft: MaterialDraft
  errors: PackErrors | undefined
  shown: (error: FieldError | undefined) => string | undefined
  chain: ReactNode
  onChange: (pack: PackDraft) => void
  onRemove: () => void
  /** Absent when no conversion can be added. */
  onOtherKind?: () => void
}) {
  const { t } = useTranslation()
  const errorsId = useId()
  const name = shown(errors?.name)
  const qty = shown(errors?.qty)
  const of = shown(errors?.of)
  const messages = [name, qty, of].filter((m): m is string => Boolean(m))
  const describedBy = messages.length > 0 ? errorsId : undefined
  // Units: the material's own kind of measure, and the kinds it has a conversion for.
  const dimensions: Dimension[] = draft.unit
    ? DIMENSIONS.filter(
        (d) =>
          d === dimensionOf(draft.unit as StandardUnit) ||
          draft.crossFactors.some((c) => c.unit && dimensionOf(c.unit) === d),
      )
    : [...DIMENSIONS]
  const others = draft.packs.filter(
    (other) => other.id !== pack.id && (other.name.trim() || pack.of === `pack:${other.id}`),
  )
  return (
    <fieldset data-pack-row className="rounded-xl border bg-background/60 p-3">
      <legend className="sr-only">{t('catalog.materials.packs.row', { number: index + 1 })}</legend>
      <div className="flex items-center gap-2">
        <Sign>1</Sign>
        <Input
          aria-label={t('catalog.materials.packs.name')}
          placeholder={t('catalog.materials.packs.namePlaceholder')}
          autoComplete="off"
          value={pack.name}
          aria-invalid={Boolean(name)}
          aria-describedby={describedBy}
          onChange={(event) => onChange({ ...pack, name: event.target.value })}
          className={`min-w-0 flex-1 ${OWN_DIRECTION}`}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('catalog.materials.packs.remove')}
          onClick={onRemove}
          className="shrink-0 text-muted-foreground"
        >
          <Trash2Icon aria-hidden />
        </Button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Sign>=</Sign>
        <Input
          aria-label={t('catalog.materials.packs.qty')}
          placeholder={t('catalog.materials.packs.qtyPlaceholder')}
          inputMode="decimal"
          dir="ltr"
          autoComplete="off"
          spellCheck={false}
          value={pack.qty}
          aria-invalid={Boolean(qty)}
          aria-describedby={describedBy}
          onChange={(event) => onChange({ ...pack, qty: event.target.value })}
          onBlur={() => onChange({ ...pack, qty: withLatinDigits(pack.qty) })}
          className="w-24 shrink-0 tabular-nums rtl:text-end"
        />
        <UnitSelect
          aria-label={t('catalog.materials.packs.of')}
          value={pack.of}
          onValueChange={(value) =>
            value === OTHER_KIND ? onOtherKind?.() : onChange({ ...pack, of: value as PackOf })
          }
          dimensions={dimensions}
          valuePrefix="unit:"
          placeholder={t('catalog.form.unitPlaceholder')}
          aria-invalid={Boolean(of)}
          aria-describedby={describedBy}
          className="min-w-0 flex-1"
          extra={
            <>
              {others.length > 0 ? (
                <optgroup label={t('catalog.materials.packs.group')}>
                  {others.map((other) => (
                    <option key={other.id} value={`pack:${other.id}`}>
                      {formName(other.name) || '…'}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {onOtherKind ? (
                <option value={OTHER_KIND}>{t('catalog.materials.packs.otherKind')}</option>
              ) : null}
            </>
          }
        />
      </div>
      {messages.length > 0 ? (
        <RowErrors id={errorsId} messages={messages} />
      ) : chain ? (
        <p className="mt-2 ps-7 text-sm text-muted-foreground">{chain}</p>
      ) : null}
    </fieldset>
  )
}

function CrossRow({
  index,
  cross,
  draft,
  errors,
  shown,
  onChange,
  onRemove,
}: {
  index: number
  cross: CrossDraft
  draft: MaterialDraft
  errors: CrossErrors | undefined
  shown: (error: FieldError | undefined) => string | undefined
  onChange: (cross: CrossDraft) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const errorsId = useId()
  const unit = shown(errors?.unit)
  const qty = shown(errors?.qty)
  const of = shown(errors?.of)
  const messages = [unit, qty, of].filter((m): m is string => Boolean(m))
  const describedBy = messages.length > 0 ? errorsId : undefined
  const own = draft.unit ? dimensionOf(draft.unit) : null
  return (
    <fieldset data-cross-row={cross.id} className="rounded-xl border bg-background/60 p-3">
      <legend className="sr-only">{t('catalog.materials.cross.row', { number: index + 1 })}</legend>
      <div className="flex items-center gap-2">
        <Sign>1</Sign>
        <UnitSelect
          aria-label={t('catalog.materials.cross.unit')}
          value={cross.unit}
          onValueChange={(value) => onChange({ ...cross, unit: value as StandardUnit })}
          dimensions={DIMENSIONS.filter((d) => d !== own)}
          placeholder={t('catalog.form.unitPlaceholder')}
          aria-invalid={Boolean(unit)}
          aria-describedby={describedBy}
          className="min-w-0 flex-1"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('catalog.materials.cross.remove')}
          onClick={onRemove}
          className="shrink-0 text-muted-foreground"
        >
          <Trash2Icon aria-hidden />
        </Button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Sign>=</Sign>
        <Input
          aria-label={t('catalog.materials.cross.qty')}
          placeholder={t('catalog.materials.cross.qtyPlaceholder')}
          inputMode="decimal"
          dir="ltr"
          autoComplete="off"
          spellCheck={false}
          value={cross.qty}
          aria-invalid={Boolean(qty)}
          aria-describedby={describedBy}
          onChange={(event) => onChange({ ...cross, qty: event.target.value })}
          onBlur={() => onChange({ ...cross, qty: withLatinDigits(cross.qty) })}
          className="w-24 shrink-0 tabular-nums rtl:text-end"
        />
        <UnitSelect
          aria-label={t('catalog.materials.cross.of')}
          value={cross.of}
          onValueChange={(value) => onChange({ ...cross, of: value as StandardUnit })}
          dimensions={own ? [own] : DIMENSIONS}
          placeholder={t('catalog.form.unitPlaceholder')}
          aria-invalid={Boolean(of)}
          aria-describedby={describedBy}
          className="min-w-0 flex-1"
        />
      </div>
      <RowErrors id={errorsId} messages={messages} />
    </fieldset>
  )
}

/** A part of the form with its title and help. */
function FormPart({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div>
        <h3 id={id} className="text-sm font-semibold">
          {title}
        </h3>
        <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  )
}

/**
 * The material form in a sheet (phones) or a side panel (desktop). `material` absent: a new one.
 * Closes itself after a save; the list refreshes.
 */
export function MaterialSheet({
  material,
  profile,
  onClose,
}: {
  material?: MaterialDto
  profile: TerminologyProfile
  onClose: () => void
}) {
  const { t } = useTranslation()
  const term = useTerminology()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const create = useMutation(trpc.material.create.mutationOptions())
  const update = useMutation(trpc.material.update.mutationOptions())
  const [newMaterialId] = useState(() => newId())
  const [draft, setDraft] = useState<MaterialDraft>(() => materialDraft(material))
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<I18nKey | null>(null)
  const [takenName, setTakenName] = useState<string | null>(null)
  const [lastChanged, setLastChanged] = useState<string | undefined>(undefined)
  const [focusCross, setFocusCross] = useState<string | null>(null)
  const form = useRef<HTMLFormElement>(null)
  const busy = create.isPending || update.isPending
  const check = useMemo(() => checkMaterial(draft, { lastChanged }), [draft, lastChanged])
  const units = useMemo(() => draftUnits(draft), [draft])
  const shown = useShownError(submitted)

  const typedName = formName(draft.name).toLowerCase()
  const nameError =
    shown(check.errors.name) ??
    (takenName !== null && typedName === takenName ? t('errors.name_taken') : undefined)

  const setPack = (next: PackDraft) => {
    if (draft.packs.find((p) => p.id === next.id)?.of !== next.of) setLastChanged(next.id)
    setDraft((d) => ({ ...d, packs: d.packs.map((p) => (p.id === next.id ? next : p)) }))
  }
  const addCross = (focus: boolean) => {
    const cross = newCross(draft)
    if (focus) setFocusCross(cross.id)
    setDraft((d) => ({ ...d, crossFactors: [...d.crossFactors, cross] }))
  }
  // A conversion added from a pack's unit box: bring it into view, its unit box focused.
  useEffect(() => {
    if (!focusCross) return
    const row = form.current?.querySelector<HTMLElement>(`[data-cross-row="${focusCross}"]`)
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    row?.querySelector<HTMLElement>('select')?.focus({ preventScroll: true })
    setFocusCross(null)
  }, [focusCross])
  const removePack = (removed: PackDraft) =>
    setDraft((d) => ({
      ...d,
      // A pack that held the removed one now holds what it held: the chain stays whole.
      packs: d.packs
        .filter((p) => p.id !== removed.id)
        .map((p) => (p.of === `pack:${removed.id}` ? { ...p, of: removed.of } : p)),
    }))
  const setCross = (next: CrossDraft) =>
    setDraft((d) => ({
      ...d,
      crossFactors: d.crossFactors.map((c) => (c.id === next.id ? next : c)),
    }))

  function chainOf(pack: PackDraft): ReactNode {
    const errors = check.errors.packs[pack.id]
    if (!units || !draft.unit || errors?.name || errors?.qty || errors?.of) return null
    const fields = draft.packs.map((p) => ({
      id: p.id,
      name: p.name,
      qty: units.packs?.find((u) => u.id === p.id)?.qty ?? '1',
      ofUnit: p.of.startsWith('unit:') ? (p.of.slice(5) as StandardUnit) : null,
      ofPackId: p.of.startsWith('pack:') ? p.of.slice(5) : null,
    }))
    const steps = packChain(pack.id, fields, units, draft.unit)
    return steps ? <PackChainText steps={steps} /> : null
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setSubmitted(true)
    setServerError(null)
    const { fields } = check
    if (!fields || (takenName !== null && fields.name.toLowerCase() === takenName)) {
      // After React has shown the messages: the first field to fix.
      setTimeout(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
      return
    }
    try {
      const saved = material
        ? await update.mutateAsync({ id: material.id, version: material.version, ...fields })
        : await create.mutateAsync({ id: newMaterialId, ...fields })
      toast.success(
        material ? t('catalog.list.saved') : t('catalog.list.added', { name: isolate(saved.name) }),
      )
      await queryClient.invalidateQueries({ queryKey: trpc.material.list.pathKey() })
      onClose()
    } catch (error) {
      const code = apiErrorCode(error)
      if (code === 'name_taken') {
        setTakenName(fields.name.toLowerCase())
        setTimeout(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
      } else setServerError(code === 'conflict' ? 'catalog.form.conflict' : apiErrorKey(error))
    }
  }

  const hasShownErrors =
    submitted && (check.fields === null || (takenName !== null && typedName === takenName))

  return (
    <Sheet open onOpenChange={(open) => !open && !busy && onClose()}>
      <SheetContent closeLabel={t('actions.close')}>
        <form
          ref={form}
          method="post"
          noValidate
          onSubmit={(event) => void submit(event)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <SheetHeader>
            <SheetTitle dir={material ? 'auto' : undefined}>
              {material ? material.name : term('catalog.materials.newTitle', profile)}
            </SheetTitle>
            <SheetDescription>
              {material ? t('catalog.form.editDescription') : t('catalog.materials.newDescription')}
            </SheetDescription>
          </SheetHeader>
          <SheetBody className="space-y-6">
            {serverError ? <FormAlert tone="error">{t(serverError)}</FormAlert> : null}
            {hasShownErrors && !serverError ? (
              <FormAlert tone="error">{t('catalog.form.fixErrors')}</FormAlert>
            ) : null}
            <TextField
              label={t('catalog.form.name')}
              autoComplete="off"
              className={OWN_DIRECTION}
              value={draft.name}
              onChange={(event) => setDraft((d) => ({ ...d, name: event.target.value }))}
              error={nameError}
              hint={(id) => (
                <p id={id} className="text-sm text-muted-foreground">
                  {t('catalog.form.nameHint')}
                </p>
              )}
            />
            <TextField
              label={t('catalog.materials.unit')}
              error={shown(check.errors.unit)}
              hint={(id) => (
                <p id={id} className="text-sm text-muted-foreground">
                  {t('catalog.materials.unitHint')}
                </p>
              )}
              render={(a11y) => (
                <UnitSelect
                  {...a11y}
                  value={draft.unit}
                  onValueChange={(value) =>
                    setDraft((d) => ({ ...d, unit: value as StandardUnit }))
                  }
                  dimensions={DIMENSIONS}
                  placeholder={t('catalog.form.unitPlaceholder')}
                />
              )}
            />
            <FormPart
              title={t('catalog.materials.packs.title')}
              hint={t('catalog.materials.packs.hint')}
            >
              {draft.packs.map((pack, index) => (
                <PackRow
                  key={pack.id}
                  index={index}
                  pack={pack}
                  draft={draft}
                  errors={check.errors.packs[pack.id]}
                  shown={shown}
                  chain={chainOf(pack)}
                  onChange={setPack}
                  onRemove={() => removePack(pack)}
                  onOtherKind={
                    draft.unit && draft.crossFactors.length < MATERIAL_CROSS_FACTORS_MAX
                      ? () => addCross(true)
                      : undefined
                  }
                />
              ))}
              {draft.packs.length < MATERIAL_PACKS_MAX ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDraft((d) => ({ ...d, packs: [...d.packs, newPack(d)] }))}
                >
                  <PlusIcon aria-hidden />
                  {t('catalog.materials.packs.add')}
                </Button>
              ) : null}
            </FormPart>
            <FormPart
              title={t('catalog.materials.cross.title')}
              hint={t('catalog.materials.cross.hint')}
            >
              {draft.crossFactors.map((cross, index) => (
                <CrossRow
                  key={cross.id}
                  index={index}
                  cross={cross}
                  draft={draft}
                  errors={check.errors.crossFactors[cross.id]}
                  shown={shown}
                  onChange={setCross}
                  onRemove={() =>
                    setDraft((d) => ({
                      ...d,
                      crossFactors: d.crossFactors.filter((c) => c.id !== cross.id),
                    }))
                  }
                />
              ))}
              {draft.crossFactors.length < MATERIAL_CROSS_FACTORS_MAX ? (
                <Button type="button" variant="outline" onClick={() => addCross(false)}>
                  <PlusIcon aria-hidden />
                  {t('catalog.materials.cross.add')}
                </Button>
              ) : null}
            </FormPart>
          </SheetBody>
          <SheetFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              {t('actions.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy
                ? t('status.saving')
                : material
                  ? t('catalog.form.save')
                  : t('catalog.form.add')}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
