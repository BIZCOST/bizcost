'use client'

import { apiErrorCode, apiErrorKey, apiErrorNames, useTRPC } from '@bizcost/app-core'
import type { MaterialDto } from '@bizcost/contracts'
import {
  matchNames,
  nameKey,
  newId,
  type Dimension,
  type StandardUnit,
  type TerminologyProfile,
} from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CircleAlertIcon, LightbulbIcon } from 'lucide-react'
import { useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { TextField } from '@/components/form/text-field'
import { useUnsavedChanges } from '@/components/form/unsaved-changes'
import { sameData } from '@/components/form/unsaved'
import { isolate } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  checkMaterial,
  draftUnits,
  formName,
  type MaterialDraft,
} from '@/features/catalog/material-draft'
import { UnitSelect } from '@/features/catalog/unit-parts'
import { UNITS_BY_DIMENSION } from '@/features/catalog/units'
import { OWN_DIRECTION, PacksAndConversions, useShownError } from '@/features/catalog/units-editor'
import { useLocale, useTerminology } from '@/lib/i18n/client'
import { cn } from '@/lib/utils'

// A new material added from a purchase line (the owner's request of 2026-09-29): the name typed in
// the line, how it is measured (weight, volume, count or length) and its unit, and the packs it is
// bought in if any (a carton of 12 bottles). Saved with material.quickCreate (any member who enters
// purchases; changing or archiving it stays in Materials), then picked in the line.
// The same name after the business's name rule (nameKey: case, spaces, Arabic letter forms, marks,
// digits) is refused at once, with a way to use the material that has it; names that look alike say
// "Did you mean …?" first, and the person may still add it as new.

/** How a material is measured here, and the unit it starts with. */
const MEASURES = ['mass', 'volume', 'count', 'length'] as const satisfies readonly Dimension[]
const FIRST_UNIT: Readonly<Record<(typeof MEASURES)[number], StandardUnit>> = {
  mass: 'kg',
  volume: 'l',
  count: 'piece',
  length: 'm',
}

export function QuickMaterialSheet({
  name,
  materials,
  profile,
  onClose,
  onPicked,
}: {
  /** What was typed in the line. */
  name: string
  /** Every material of the business, archived ones too. */
  materials: ReadonlyMap<string, MaterialDto>
  profile: TerminologyProfile
  onClose: () => void
  /** The material the line takes: the new one, or the one that already has the name. */
  onPicked: (material: MaterialDto) => void
}) {
  const { t } = useTranslation()
  const term = useTerminology()
  const { locale } = useLocale()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const create = useMutation(trpc.material.quickCreate.mutationOptions())
  const id = useId()
  const [materialId] = useState(() => newId())
  const [initial] = useState<MaterialDraft>(() => ({
    name,
    unit: '',
    packs: [],
    crossFactors: [],
  }))
  const [draft, setDraft] = useState<MaterialDraft>(initial)
  const [measure, setMeasure] = useState<(typeof MEASURES)[number] | ''>('')
  // The name (its key) the person chose to add although others look alike.
  const [asNew, setAsNew] = useState<string | null>(null)
  // A name the API refused as taken (a material this screen had not read yet).
  const [taken, setTaken] = useState<{ key: string; name: string } | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<I18nKey | null>(null)
  const [lastChanged, setLastChanged] = useState<string | undefined>(undefined)
  const form = useRef<HTMLFormElement>(null)
  const busy = create.isPending
  const check = useMemo(() => checkMaterial(draft, { lastChanged }), [draft, lastChanged])
  const units = useMemo(() => draftUnits(draft), [draft])
  const shown = useShownError(submitted)

  // The same name (archived ones included: names are one per business) and names that look alike
  // (among those in use).
  const key = nameKey(formName(draft.name))
  const all = useMemo(() => [...materials.values()], [materials])
  const same = useMemo(() => matchNames(draft.name, all, (m) => m.name).same, [draft.name, all])
  const similar = useMemo(
    () =>
      matchNames(
        draft.name,
        all.filter((m) => m.archivedAt === null),
        (m) => m.name,
      ).similar,
    [draft.name, all],
  )
  const takenHere = taken !== null && taken.key === key ? taken.name : null
  const warned = same === null && takenHere === null && similar.length > 0 && asNew !== key
  const nameError =
    shown(check.errors.name) ??
    (same || takenHere
      ? t('purchasing.quickAdd.exists', { name: isolate(same?.name ?? takenHere ?? '') })
      : undefined)
  const measureError =
    submitted && measure === '' ? t('purchasing.quickAdd.measureRequired') : undefined
  const dirty = !sameData(draft, initial) || measure !== ''

  const focusFirst = (selector = '[aria-invalid="true"]') =>
    setTimeout(() => form.current?.querySelector<HTMLElement>(selector)?.focus())

  /** Adds the material; the saved material, or null when something must be fixed first. */
  async function save(): Promise<MaterialDto | null> {
    setSubmitted(true)
    setServerError(null)
    const { fields } = check
    if (same || takenHere || !fields || measure === '') {
      focusFirst()
      return null
    }
    if (warned) {
      focusFirst('[data-similar] button')
      return null
    }
    try {
      const saved = await create.mutateAsync({ id: materialId, ...fields })
      toast.success(t('catalog.list.added', { name: isolate(saved.name) }))
      void queryClient.invalidateQueries({ queryKey: trpc.material.list.pathKey() })
      return saved
    } catch (error) {
      if (apiErrorCode(error) === 'name_taken') {
        setTaken({ key, name: apiErrorNames(error)[0] ?? fields.name })
        focusFirst()
      } else setServerError(apiErrorKey(error))
      return null
    }
  }

  const guard = useUnsavedChanges({
    dirty,
    save: async () => {
      const saved = await save()
      if (saved) onPicked(saved)
      return saved !== null
    },
    close: onClose,
  })

  async function submit(event: FormEvent) {
    event.preventDefault()
    // Inside the purchase's own form: this submit is the sheet's.
    event.stopPropagation()
    if (busy) return
    const saved = await save()
    if (!saved) return
    onPicked(saved)
    onClose()
  }

  function use(material: MaterialDto) {
    onPicked(material)
    onClose()
  }

  function pickMeasure(next: (typeof MEASURES)[number]) {
    setMeasure(next)
    const unit = FIRST_UNIT[next]
    // Packs that held a unit of the old kind hold the new unit.
    setDraft((d) => ({
      ...d,
      unit,
      packs: d.packs.map((pack) =>
        pack.of.startsWith('unit:') ? { ...pack, of: `unit:${unit}` } : pack,
      ),
    }))
  }

  const existing = same ?? (takenHere ? all.find((m) => m.name === takenHere) : undefined)

  return (
    <Sheet open onOpenChange={(open) => !open && !busy && guard.requestLeave(onClose)}>
      <SheetContent closeLabel={t('actions.close')}>
        <form
          ref={form}
          method="post"
          noValidate
          onSubmit={(event) => void submit(event)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <SheetHeader>
            <SheetTitle>{term('catalog.materials.newTitle', profile)}</SheetTitle>
            <SheetDescription>{term('purchasing.quickAdd.description', profile)}</SheetDescription>
          </SheetHeader>
          <SheetBody className="space-y-6">
            {serverError ? <FormAlert tone="error">{t(serverError)}</FormAlert> : null}
            <div className="space-y-3">
              <TextField
                label={t('catalog.form.name')}
                autoComplete="off"
                className={OWN_DIRECTION}
                value={draft.name}
                onChange={(event) => setDraft((d) => ({ ...d, name: event.target.value }))}
                error={nameError}
              />
              {existing ? (
                <div data-same className="flex flex-wrap items-center gap-2">
                  {existing.archivedAt !== null ? (
                    <p className="text-sm text-muted-foreground">
                      {t('purchasing.quickAdd.archived')}
                    </p>
                  ) : null}
                  <Button type="button" variant="outline" onClick={() => use(existing)}>
                    {t('purchasing.quickAdd.useExisting', { name: isolate(existing.name) })}
                  </Button>
                </div>
              ) : warned ? (
                <div
                  data-similar
                  role={submitted ? 'alert' : undefined}
                  className="rounded-xl border border-warning/40 bg-warning/10 p-3"
                >
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <LightbulbIcon aria-hidden className="size-4 shrink-0 text-warning" />
                    {similar.length === 1
                      ? t('purchasing.quickAdd.similarTitleOne', {
                          name: isolate(similar[0]!.name),
                        })
                      : t('purchasing.quickAdd.similarTitle')}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {similar.map((material) => (
                      <Button
                        key={material.id}
                        type="button"
                        variant="outline"
                        className="bg-card"
                        onClick={() => use(material)}
                      >
                        {t('purchasing.quickAdd.useExisting', { name: isolate(material.name) })}
                      </Button>
                    ))}
                  </div>
                  <Button
                    type="button"
                    variant="link"
                    className="mt-1 h-9 px-0"
                    onClick={() => setAsNew(key)}
                  >
                    {t('purchasing.quickAdd.addAnyway')}
                  </Button>
                  {submitted ? (
                    <p className="flex items-center gap-1.5 text-sm text-destructive">
                      <CircleAlertIcon aria-hidden className="size-4 shrink-0" />
                      {t('purchasing.quickAdd.pickOrAdd')}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>

            <fieldset aria-describedby={measureError ? `${id}-measure-error` : undefined}>
              <legend className="mb-2 text-sm font-medium">
                {t('purchasing.quickAdd.measure')}
              </legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {MEASURES.map((dimension) => (
                  <label
                    key={dimension}
                    className={cn(
                      'flex min-h-14 cursor-pointer flex-col items-center justify-center rounded-xl border px-2 py-2 text-center transition-colors has-focus-visible:ring-3 has-focus-visible:ring-ring',
                      measure === dimension
                        ? 'border-primary bg-accent text-accent-foreground'
                        : 'hover:bg-muted/50',
                      measureError && 'border-destructive',
                    )}
                  >
                    <input
                      type="radio"
                      name={`${id}-measure`}
                      value={dimension}
                      checked={measure === dimension}
                      onChange={() => pickMeasure(dimension)}
                      aria-invalid={Boolean(measureError)}
                      className="sr-only"
                    />
                    <span className="text-sm font-medium">
                      {t(`units.dimensions.${dimension}`)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {UNITS_BY_DIMENSION[dimension]
                        .map((unit) => t(`units.short.${unit}`))
                        .join(locale === 'ar' ? '، ' : ', ')}
                    </span>
                  </label>
                ))}
              </div>
              {measureError ? (
                <p
                  id={`${id}-measure-error`}
                  role="alert"
                  className="mt-2 text-sm text-destructive"
                >
                  {measureError}
                </p>
              ) : null}
            </fieldset>

            {measure !== '' ? (
              <>
                <TextField
                  label={t('catalog.materials.unit')}
                  error={shown(check.errors.unit)}
                  hint={(hintId) => (
                    <p id={hintId} className="text-sm text-muted-foreground">
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
                      dimensions={[measure]}
                    />
                  )}
                />
                <PacksAndConversions
                  draft={draft}
                  onChange={(update) => setDraft((d) => update(d))}
                  check={check}
                  units={units}
                  shown={shown}
                  onPackOfChanged={setLastChanged}
                  packsOnly
                />
              </>
            ) : null}
          </SheetBody>
          <SheetFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => guard.requestLeave(onClose)}
            >
              {t('actions.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t('status.saving') : t('catalog.form.add')}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
