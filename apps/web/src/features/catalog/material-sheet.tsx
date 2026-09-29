'use client'

import { apiErrorCode, apiErrorKey, apiErrorNames, useTRPC } from '@bizcost/app-core'
import type { MaterialDto } from '@bizcost/contracts'
import { DIMENSIONS, newId, type StandardUnit, type TerminologyProfile } from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { TextField } from '@/components/form/text-field'
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
// message names the products, for a member who may see recipes (D-152).

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
  const [draft, setDraft] = useState<MaterialDraft>(() => materialDraft(material))
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [takenName, setTakenName] = useState<string | null>(null)
  const [lastChanged, setLastChanged] = useState<string | undefined>(undefined)
  const form = useRef<HTMLFormElement>(null)
  const busy = create.isPending || update.isPending
  const check = useMemo(() => checkMaterial(draft, { lastChanged }), [draft, lastChanged])
  const units = useMemo(() => draftUnits(draft), [draft])
  const shown = useShownError(submitted)

  const typedName = formName(draft.name).toLowerCase()
  const nameError =
    shown(check.errors.name) ??
    (takenName !== null && typedName === takenName ? t('errors.name_taken') : undefined)

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
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: trpc.material.list.pathKey() }),
        queryClient.invalidateQueries({ queryKey: trpc.material.costs.pathKey() }),
        queryClient.invalidateQueries({ queryKey: trpc.recipe.get.pathKey() }),
        ...(saved.resaleProductId
          ? [queryClient.invalidateQueries({ queryKey: trpc.product.list.pathKey() })]
          : []),
      ])
      onClose()
    } catch (error) {
      const code = apiErrorCode(error)
      const names = apiErrorNames(error)
      if (code === 'name_taken') {
        setTakenName(fields.name.toLowerCase())
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
