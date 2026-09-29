'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { SupplierDto } from '@bizcost/contracts'
import { newId } from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type FormEvent } from 'react'
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
import { Textarea } from '@/components/ui/textarea'
import { formName } from '@/features/catalog/material-draft'
import type { FieldError } from '@/features/catalog/numbers'
import { checkSupplier, supplierDraft, type SupplierDraft } from './supplier-draft'

// Add or edit a supplier (M2 Step 3; D-133): a name in any language and, if the owner likes, a
// phone, an email, the TRN on their invoices and notes. Also opened from a purchase ("New
// supplier…"), which then picks the new supplier. Closing it with changes not saved asks first.

/** Problems that only say something is missing: shown once the person tries to save. */
const MISSING: ReadonlySet<I18nKey> = new Set<I18nKey>(['catalog.form.nameRequired'])

/** Typed text reads in its own direction, in a box laid out in the page's direction. */
const OWN_DIRECTION = '[unicode-bidi:plaintext]'

export function SupplierSheet({
  supplier,
  onClose,
  onSaved,
}: {
  /** Absent: a new supplier. */
  supplier?: SupplierDto
  onClose: () => void
  /** After a save, before closing (e.g. a purchase picks the new supplier). */
  onSaved?: (supplier: SupplierDto) => void
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const create = useMutation(trpc.supplier.create.mutationOptions())
  const update = useMutation(trpc.supplier.update.mutationOptions())
  const [newSupplierId] = useState(() => newId())
  const [initial] = useState<SupplierDraft>(() => supplierDraft(supplier))
  const [draft, setDraft] = useState<SupplierDraft>(initial)
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<I18nKey | null>(null)
  const [takenName, setTakenName] = useState<string | null>(null)
  const form = useRef<HTMLFormElement>(null)
  const busy = create.isPending || update.isPending
  const check = checkSupplier(draft)
  const shown = (error: FieldError | undefined): string | undefined =>
    error && (submitted || !MISSING.has(error.key)) ? t(error.key, error.values) : undefined
  const typedName = formName(draft.name).toLowerCase()
  const nameError =
    shown(check.errors.name) ??
    (takenName !== null && typedName === takenName ? t('errors.name_taken') : undefined)
  const focusFirstError = () =>
    setTimeout(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
  const set = (patch: Partial<SupplierDraft>) => setDraft((d) => ({ ...d, ...patch }))

  /** Saves the supplier; true once saved (the form says what went wrong otherwise). */
  async function save(): Promise<boolean> {
    if (busy) return false
    setSubmitted(true)
    setServerError(null)
    const { fields } = check
    if (!fields || (takenName !== null && fields.name.toLowerCase() === takenName)) {
      focusFirstError()
      return false
    }
    try {
      const saved = supplier
        ? await update.mutateAsync({ id: supplier.id, version: supplier.version, ...fields })
        : await create.mutateAsync({ id: newSupplierId, ...fields })
      toast.success(
        supplier ? t('catalog.list.saved') : t('catalog.list.added', { name: isolate(saved.name) }),
      )
      await queryClient.invalidateQueries({ queryKey: trpc.supplier.list.pathKey() })
      onSaved?.(saved)
      return true
    } catch (error) {
      const code = apiErrorCode(error)
      if (code === 'name_taken') {
        setTakenName(fields.name.toLowerCase())
        focusFirstError()
      } else setServerError(code === 'conflict' ? 'catalog.form.conflict' : apiErrorKey(error))
      return false
    }
  }

  const guard = useUnsavedChanges({ dirty: !sameData(draft, initial), save, close: onClose })

  async function submit(event: FormEvent) {
    event.preventDefault()
    // A form inside another form's sheet (a purchase): its submit is its own.
    event.stopPropagation()
    if (await save()) onClose()
  }

  const hasShownErrors =
    submitted && (check.fields === null || (takenName !== null && typedName === takenName))

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
            <SheetTitle dir={supplier ? 'auto' : undefined}>
              {supplier ? supplier.name : t('purchasing.suppliers.newTitle')}
            </SheetTitle>
            <SheetDescription>
              {supplier
                ? t('catalog.form.editDescription')
                : t('purchasing.suppliers.newDescription')}
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
              onChange={(event) => set({ name: event.target.value })}
              error={nameError}
              hint={(id) => (
                <p id={id} className="text-sm text-muted-foreground">
                  {t('purchasing.suppliers.nameHint')}
                </p>
              )}
            />
            <TextField
              label={t('purchasing.suppliers.phone')}
              type="tel"
              inputMode="tel"
              dir="ltr"
              autoComplete="off"
              className="rtl:text-end"
              value={draft.phone}
              onChange={(event) => set({ phone: event.target.value })}
              error={shown(check.errors.phone)}
              hint={(id) => (
                <p id={id} className="text-sm text-muted-foreground">
                  {t('purchasing.optional')}
                </p>
              )}
            />
            <TextField
              label={t('purchasing.suppliers.email')}
              type="email"
              inputMode="email"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              className="rtl:text-end"
              value={draft.email}
              onChange={(event) => set({ email: event.target.value })}
              error={shown(check.errors.email)}
              hint={(id) => (
                <p id={id} className="text-sm text-muted-foreground">
                  {t('purchasing.optional')}
                </p>
              )}
            />
            <TextField
              label={t('purchasing.suppliers.trn')}
              inputMode="numeric"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              className="tabular-nums rtl:text-end"
              value={draft.trn}
              onChange={(event) => set({ trn: event.target.value })}
              error={shown(check.errors.trn)}
              hint={(id) => (
                <p id={id} className="text-sm text-muted-foreground">
                  {t('purchasing.suppliers.trnHint')}
                </p>
              )}
            />
            <TextField
              label={t('purchasing.notes')}
              error={shown(check.errors.notes)}
              hint={(id) => (
                <p id={id} className="text-sm text-muted-foreground">
                  {t('purchasing.notesHint')}
                </p>
              )}
              render={(a11y) => (
                <Textarea
                  {...a11y}
                  className="[unicode-bidi:plaintext]"
                  rows={3}
                  value={draft.notes}
                  onChange={(event) => set({ notes: event.target.value })}
                />
              )}
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
                : supplier
                  ? t('catalog.form.save')
                  : t('catalog.form.add')}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
