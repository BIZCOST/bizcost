'use client'

import { apiErrorCode, apiErrorKey, apiErrorNames, useTRPC } from '@bizcost/app-core'
import { CATALOG_SEARCH_MAX_LENGTH, type MaterialDto } from '@bizcost/contracts'
import {
  DIMENSIONS,
  nameKey,
  newId,
  type StandardUnit,
  type TerminologyProfile,
} from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { TextField } from '@/components/form/text-field'
import { sameData } from '@/components/form/unsaved'
import { useUnsavedChanges } from '@/components/form/unsaved-changes'
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
import { useLocale, useTerminology } from '@/lib/i18n/client'
import {
  checkMaterial,
  draftUnits,
  formName,
  materialDraft,
  type MaterialDraft,
} from './material-draft'
import { listOfNames } from './names'
import { UnitSelect } from './unit-parts'
import { OWN_DIRECTION, PacksAndConversions, useShownError } from './units-editor'

// Add or edit a material (M2 Step 2; D-122): its name, the unit it is used in, the packs it is
// bought in and, when it is bought in another kind of measure, a conversion. Each pack says its chain
// in words as it is typed ("1 carton = 12 bottles = 12 L"), checked by the domain units engine;
// the API checks the same set again before anything is saved.
// A material sold as it is (bought ready to sell, D-117) says so: its name, unit and archiving move
// with its product. When a recipe still uses a pack or conversion taken out (UNIT_IN_USE), the
// message names the products, for a member who may see recipes (D-152). A name the business already
// has, compared the way people read it (nameKey), is refused and named (NAME_TAKEN). Closing it with
// changes not saved asks first (the owner's request of 2026-09-29).

/**
 * The material form in a sheet (phones) or a side panel (desktop). `material` absent: a new one.
 * Closes itself after a save; the list refreshes.
 */
export function MaterialSheet({
  material,
  profile,
  newTitle,
  onClose,
}: {
  material?: MaterialDto
  profile: TerminologyProfile
  /** The title of a new one, when it is not the section's usual (a shop's supply). */
  newTitle?: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const term = useTerminology()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const create = useMutation(trpc.material.create.mutationOptions())
  const update = useMutation(trpc.material.update.mutationOptions())
  const [newMaterialId] = useState(() => newId())
  const [initial] = useState<MaterialDraft>(() => materialDraft(material))
  const [draft, setDraft] = useState<MaterialDraft>(initial)
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  // A name refused as taken: its key, and the material that has it (and whether it is archived).
  const [taken, setTaken] = useState<{ key: string; name: string; archived: boolean } | null>(null)
  const [lastChanged, setLastChanged] = useState<string | undefined>(undefined)
  const form = useRef<HTMLFormElement>(null)
  const busy = create.isPending || update.isPending
  const check = useMemo(() => checkMaterial(draft, { lastChanged }), [draft, lastChanged])
  const units = useMemo(() => draftUnits(draft), [draft])
  const shown = useShownError(submitted)

  const typedKey = nameKey(formName(draft.name))
  const isTaken = taken !== null && typedKey === taken.key
  const nameError =
    shown(check.errors.name) ??
    (isTaken
      ? taken.name
        ? t(taken.archived ? 'catalog.form.nameTakenArchived' : 'catalog.form.nameTakenBy', {
            name: isolate(taken.name),
          })
        : t('errors.name_taken')
      : undefined)

  /** Saves the material; true once saved (the form says what went wrong otherwise). */
  async function save(): Promise<boolean> {
    if (busy) return false
    setSubmitted(true)
    setServerError(null)
    const { fields } = check
    if (!fields || isTaken) {
      // After React has shown the messages: the first field to fix.
      setTimeout(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
      return false
    }
    try {
      const saved = material
        ? await update.mutateAsync({ id: material.id, version: material.version, ...fields })
        : await create.mutateAsync({ id: newMaterialId, ...fields })
      toast.success(
        material ? t('catalog.list.saved') : t('catalog.list.added', { name: isolate(saved.name) }),
      )
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: trpc.material.list.pathKey() }),
        queryClient.invalidateQueries({ queryKey: trpc.material.costs.pathKey() }),
        queryClient.invalidateQueries({ queryKey: trpc.recipe.get.pathKey() }),
        queryClient.invalidateQueries({ queryKey: trpc.productCost.pathKey() }),
        ...(saved.resaleProductId
          ? [queryClient.invalidateQueries({ queryKey: trpc.product.list.pathKey() })]
          : []),
      ])
      return true
    } catch (error) {
      const code = apiErrorCode(error)
      const names = apiErrorNames(error)
      if (code === 'name_taken') {
        const name = names[0] ?? ''
        setTaken({ key: nameKey(fields.name), name, archived: await isArchivedName(name) })
        setTimeout(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
      } else if (code === 'unit_in_use' && names.length > 0) {
        setServerError(
          term('catalog.materials.unitInUse', profile, {
            names: listOfNames(locale, names),
          }),
        )
      } else {
        const key: I18nKey = code === 'conflict' ? 'catalog.form.conflict' : apiErrorKey(error)
        setServerError(t(key))
      }
      return false
    }
  }

  /** Whether the material named `name` (as NAME_TAKEN names it) is archived: said so, then. */
  async function isArchivedName(name: string): Promise<boolean> {
    if (!name) return false
    try {
      const archived = await queryClient.fetchQuery(
        trpc.material.list.queryOptions({
          status: 'archived',
          search: name.slice(0, CATALOG_SEARCH_MAX_LENGTH),
          limit: 10,
        }),
      )
      return archived.items.some((m) => nameKey(m.name) === nameKey(name))
    } catch {
      return false
    }
  }

  const guard = useUnsavedChanges({ dirty: !sameData(draft, initial), save, close: onClose })

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (await save()) onClose()
  }

  const hasShownErrors = submitted && (check.fields === null || isTaken)

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
            <SheetTitle dir={material ? 'auto' : undefined}>
              {material ? material.name : (newTitle ?? term('catalog.materials.newTitle', profile))}
            </SheetTitle>
            <SheetDescription>
              {material ? t('catalog.form.editDescription') : t('catalog.materials.newDescription')}
            </SheetDescription>
          </SheetHeader>
          <SheetBody className="space-y-6">
            {serverError ? <FormAlert tone="error">{serverError}</FormAlert> : null}
            {material?.resaleProductId ? (
              <FormAlert tone="info">{t('catalog.materials.soldAsNote')}</FormAlert>
            ) : null}
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
              label={
                material?.resaleProductId
                  ? t('catalog.materials.unitSold')
                  : t('catalog.materials.unit')
              }
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
            <PacksAndConversions
              draft={draft}
              onChange={(update) => setDraft((d: MaterialDraft) => update(d))}
              check={check}
              units={units}
              shown={shown}
              onPackOfChanged={setLastChanged}
            />
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
