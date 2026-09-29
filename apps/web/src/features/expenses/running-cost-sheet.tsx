'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { RunningCostDto } from '@bizcost/contracts'
import {
  newId,
  RUNNING_COST_FREQUENCIES,
  type CurrencyCode,
  type RunningCostFrequency,
} from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2Icon } from 'lucide-react'
import { useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { Required } from '@/components/form/required'
import { TextField } from '@/components/form/text-field'
import { sameData } from '@/components/form/unsaved'
import { useUnsavedChanges } from '@/components/form/unsaved-changes'
import { isolate } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
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
import type { FieldError } from '@/features/catalog/numbers'
import { useMoney } from '@/features/purchasing/amounts'
import { ConfirmDialog } from '@/features/purchasing/confirm-dialog'
import { MoneyInput } from '@/features/purchasing/purchase-lines'
import { useBusinessContext } from '@/lib/trpc/client'
import { CategoryField } from './category-field'
import { canManageCategories, useCategoryOptions } from './data'
import {
  checkRunningCost,
  RUNNING_COST_MISSING,
  runningCostDraft,
  type RunningCostDraft,
} from './running-cost-draft'

// Add or change a running cost (M2 Step 5; D-116, D-169): what it is (a name in any language), its
// category (a quick pick fills both), how much and how often (monthly unless said otherwise), with
// what that makes a month as it is typed, from when it is paid and, once it stops, until when. A
// VAT-registered business types it without the VAT it reclaims. A running cost added by mistake is
// removed; one that stopped gets its end date instead. Closing with changes not saved asks first.

/** Typed text reads in its own direction, in a box laid out in the page's direction. */
const OWN_DIRECTION = '[unicode-bidi:plaintext]'

export function RunningCostSheet({
  cost,
  preset,
  today,
  onClose,
}: {
  /** Absent: a new running cost. */
  cost?: RunningCostDto
  /** A new one from a quick pick: its name and category. */
  preset?: { name: string; categoryId: string }
  /** Today in the business's time zone (runningCost.list). */
  today: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const money = useMoney()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { data: context } = useBusinessContext()
  const categoryOptions = useCategoryOptions()
  const create = useMutation(trpc.runningCost.create.mutationOptions())
  const update = useMutation(trpc.runningCost.update.mutationOptions())
  const remove = useMutation(trpc.runningCost.remove.mutationOptions())
  const [costId] = useState(() => cost?.id ?? newId())
  const [initial] = useState<RunningCostDraft>(() =>
    runningCostDraft(cost, { today, name: preset?.name, categoryId: preset?.categoryId }),
  )
  const [draft, setDraft] = useState<RunningCostDraft>(initial)
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<I18nKey | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<I18nKey | null>(null)
  const form = useRef<HTMLFormElement>(null)
  const busy = create.isPending || update.isPending || remove.isPending
  const currency = (context?.currency ?? 'AED') as CurrencyCode
  const vatRegistered = context?.capabilities.vat_registered === true
  // An archived category stays only on the running cost that already has it (D-167).
  const categoryIds = useMemo(
    () =>
      categoryOptions.ready
        ? new Set(
            categoryOptions.categories
              .filter((c) => c.archivedAt === null || c.id === cost?.categoryId)
              .map((c) => c.id),
          )
        : undefined,
    [categoryOptions.ready, categoryOptions.categories, cost?.categoryId],
  )
  const check = checkRunningCost(draft, { currency, categories: categoryIds })
  const shown = (error: FieldError | undefined): string | undefined =>
    error && (submitted || !RUNNING_COST_MISSING.has(error.key))
      ? t(error.key, error.values)
      : undefined
  const set = (patch: Partial<RunningCostDraft>) => setDraft((d) => ({ ...d, ...patch }))

  /** Saves it; true once saved (the sheet says what went wrong otherwise). */
  async function save(): Promise<boolean> {
    if (busy) return false
    setSubmitted(true)
    setServerError(null)
    const { fields } = check
    if (!fields) {
      setTimeout(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
      return false
    }
    try {
      const saved = cost
        ? await update.mutateAsync({ id: cost.id, version: cost.version, ...fields })
        : await create.mutateAsync({ id: costId, ...fields })
      toast.success(
        cost
          ? t('expenses.running.sheet.saved')
          : t('expenses.running.sheet.added', { name: isolate(saved.data.name) }),
      )
      await queryClient.invalidateQueries({ queryKey: trpc.runningCost.list.pathKey() })
      return true
    } catch (error) {
      setServerError(
        apiErrorCode(error) === 'conflict' ? 'catalog.form.conflict' : apiErrorKey(error),
      )
      return false
    }
  }

  const guard = useUnsavedChanges({ dirty: !sameData(draft, initial), save, close: onClose })

  async function submit(event: FormEvent) {
    event.preventDefault()
    event.stopPropagation()
    if (await save()) onClose()
  }

  async function confirmRemove() {
    if (!cost) return
    setRemoveError(null)
    try {
      await remove.mutateAsync({ id: cost.id, version: cost.version })
      toast.success(t('expenses.running.sheet.removed', { name: isolate(cost.name) }))
      await queryClient.invalidateQueries({ queryKey: trpc.runningCost.list.pathKey() })
      setRemoving(false)
      onClose()
    } catch (error) {
      setRemoveError(
        apiErrorCode(error) === 'conflict' ? 'catalog.form.conflict' : apiErrorKey(error),
      )
    }
  }

  const hasShownErrors = submitted && check.fields === null

  return (
    <Sheet open onOpenChange={(open) => !open && !busy && guard.requestLeave(onClose)}>
      <SheetContent
        closeLabel={t('actions.close')}
        onOpenAutoFocus={(event) => {
          // A quick pick fills in the name and category: the amount is what is left to type (the
          // number pad on a phone). A running cost opened to change opens no keyboard.
          if (!preset && !cost) return
          event.preventDefault()
          const target = event.currentTarget as HTMLElement | null
          const amount = preset
            ? target?.querySelector<HTMLInputElement>('input[inputmode="decimal"]')
            : null
          ;(amount ?? target)?.focus()
        }}
      >
        <form
          ref={form}
          method="post"
          noValidate
          onSubmit={(event) => void submit(event)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <SheetHeader>
            <SheetTitle dir={cost ? 'auto' : undefined}>
              {cost ? cost.name : t('expenses.running.sheet.newTitle')}
            </SheetTitle>
            <SheetDescription>
              {cost
                ? t('expenses.running.sheet.editDescription')
                : t('expenses.running.sheet.newDescription')}
            </SheetDescription>
          </SheetHeader>
          <SheetBody className="space-y-6">
            {serverError ? <FormAlert tone="error">{t(serverError)}</FormAlert> : null}
            {hasShownErrors && !serverError ? (
              <FormAlert tone="error">{t('catalog.form.fixErrors')}</FormAlert>
            ) : null}
            <TextField
              label={<Required>{t('expenses.running.sheet.name')}</Required>}
              autoComplete="off"
              className={OWN_DIRECTION}
              placeholder={t('expenses.running.sheet.namePlaceholder')}
              value={draft.name}
              onChange={(event) => set({ name: event.target.value })}
              error={shown(check.errors.name)}
              hint={(id) => (
                <p id={id} className="text-sm text-muted-foreground">
                  {t('expenses.running.sheet.nameHint')}
                </p>
              )}
            />
            {context ? (
              <CategoryField
                value={draft.categoryId}
                onChange={(categoryId) => set({ categoryId })}
                categories={categoryOptions.categories}
                canAdd={canManageCategories(context)}
                error={shown(check.errors.category)}
                onAdded={categoryOptions.add}
              />
            ) : null}
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-3">
              <TextField
                label={<Required>{t('expenses.running.sheet.amount')}</Required>}
                error={shown(check.errors.amount)}
                hint={
                  vatRegistered
                    ? (id) => (
                        <p id={id} className="text-sm text-muted-foreground">
                          {t('expenses.running.sheet.amountHintVat')}
                        </p>
                      )
                    : undefined
                }
                render={(a11y) => (
                  <MoneyInput
                    id={a11y.id}
                    invalid={a11y['aria-invalid']}
                    describedBy={a11y['aria-describedby']}
                    value={draft.amount}
                    onChange={(amount) => set({ amount })}
                  />
                )}
              />
              <TextField
                label={t('expenses.running.sheet.frequency')}
                render={(a11y) => (
                  <NativeSelect
                    {...a11y}
                    value={draft.frequency}
                    onChange={(event) =>
                      set({ frequency: event.target.value as RunningCostFrequency })
                    }
                  >
                    {RUNNING_COST_FREQUENCIES.map((frequency) => (
                      <option key={frequency} value={frequency}>
                        {t(`expenses.running.sheet.frequencies.${frequency}`)}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              />
            </div>
            {check.monthly !== null && draft.frequency !== 'monthly' ? (
              <p
                data-monthly-amount
                role="status"
                className="-mt-3 rounded-xl bg-muted/60 px-4 py-3 text-sm font-medium"
              >
                {t('expenses.running.sheet.monthly', { amount: money(check.monthly, currency) })}
              </p>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label={t('expenses.running.sheet.startsOn')}
                type="date"
                value={draft.startsOn}
                onChange={(event) => set({ startsOn: event.target.value })}
                error={shown(check.errors.startsOn)}
                hint={(id) => (
                  <p id={id} className="text-sm text-muted-foreground">
                    {t('expenses.running.sheet.startsOnHint')}
                  </p>
                )}
              />
              <TextField
                label={t('expenses.running.sheet.endsOn')}
                type="date"
                min={draft.startsOn || undefined}
                value={draft.endsOn}
                onChange={(event) => set({ endsOn: event.target.value })}
                error={shown(check.errors.endsOn)}
                hint={(id) => (
                  <p id={id} className="text-sm text-muted-foreground">
                    {t('expenses.running.sheet.endsOnHint')}
                  </p>
                )}
              />
            </div>
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
                  className={OWN_DIRECTION}
                  rows={2}
                  value={draft.notes}
                  onChange={(event) => set({ notes: event.target.value })}
                />
              )}
            />
            {cost ? (
              <div className="border-t pt-4">
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={busy}
                  onClick={() => {
                    setRemoveError(null)
                    setRemoving(true)
                  }}
                >
                  <Trash2Icon aria-hidden />
                  {t('expenses.running.sheet.remove')}
                </Button>
              </div>
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
              {create.isPending || update.isPending
                ? t('status.saving')
                : cost
                  ? t('catalog.form.save')
                  : t('catalog.form.add')}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
      {cost ? (
        <ConfirmDialog
          open={removing}
          icon={Trash2Icon}
          title={t('expenses.running.sheet.removeTitle', { name: isolate(cost.name) })}
          body={t('expenses.running.sheet.removeBody')}
          action={t('expenses.running.sheet.removeAction')}
          busyLabel={t('expenses.running.sheet.removing')}
          busy={remove.isPending}
          error={removeError}
          destructive
          onConfirm={() => void confirmRemove()}
          onClose={() => setRemoving(false)}
        />
      ) : null}
    </Sheet>
  )
}
