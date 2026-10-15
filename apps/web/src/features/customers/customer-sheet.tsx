'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { CustomerDto, CustomerPickItemDto } from '@bizcost/contracts'
import { CUSTOMER_KINDS, customerMayHaveLicence, newId, type CustomerKind } from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQuery } from '@tanstack/react-query'
import { UserRoundSearchIcon } from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useId, useRef, useState, type FormEvent } from 'react'
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
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { checkCustomer, customerDraft, type CustomerDraft } from './customer-draft'
import { maySeeCustomers, phoneHint, useDebounced, useRefreshCustomers } from './data'

// Add or edit a customer (M3 Step 5; Q2, D-263): a name in any language, a person, a business or a
// government body, and if the owner likes a phone, an email, the TRN and (a business or a government
// body) its trade licence number. Names may repeat: while a new name is typed, "Did you mean …?"
// lists the customers of that name, or one that looks alike, each with their phone (its last 4 digits
// for a member who may not see customers), so the same person is not added twice; from an order or a
// sale the one meant is picked right there. Also opened from a picker ("Add «name» as a new
// customer"), which then names the new customer. Closing it with changes not saved asks first.

/** Problems that only say something is missing: shown once the person tries to save. */
const MISSING: ReadonlySet<I18nKey> = new Set<I18nKey>(['catalog.form.nameRequired'])

/** Typed text reads in its own direction, in a box laid out in the page's direction. */
const OWN_DIRECTION = '[unicode-bidi:plaintext]'

/** "Fatima · 050 123 4567", "Fatima · …4567", or the name alone. */
export function CustomerName({ customer }: { customer: CustomerPickItemDto }) {
  const hint = phoneHint(customer)
  return (
    <>
      <bdi>{customer.name}</bdi>
      {hint ? (
        <>
          {' · '}
          <bdi dir="ltr" className="tabular-nums">
            {hint}
          </bdi>
        </>
      ) : null}
    </>
  )
}

/** "Did you mean …?": the customers of the name typed, and those whose names look alike. */
function DidYouMean({
  name,
  excludeId,
  onPick,
}: {
  name: string
  excludeId?: string
  /** From a picker: name the customer meant instead of adding one. */
  onPick?: (customer: CustomerPickItemDto) => void
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const settled = useDebounced(formName(name), 350)
  const similar = useQuery({
    ...trpc.customer.similar.queryOptions({ name: settled, excludeId }),
    enabled: settled.length >= 2,
    staleTime: 30_000,
  })
  const items = similar.data ? [...similar.data.same, ...similar.data.similar] : []
  if (settled.length < 2 || items.length === 0) return null
  const opens = context !== undefined && maySeeCustomers(context) && !onPick
  return (
    <div
      role="status"
      data-did-you-mean
      className="rounded-xl bg-warning/10 p-3 text-sm ring-1 ring-warning/20"
    >
      <p className="flex items-center gap-2 font-medium">
        <UserRoundSearchIcon aria-hidden className="size-4 shrink-0 text-warning" />
        {t('orders.customers.similar.title')}
      </p>
      <p className="mt-1 leading-relaxed text-muted-foreground">
        {onPick ? t('orders.customers.similar.bodyPick') : t('orders.customers.similar.body')}
      </p>
      <ul className="mt-2 space-y-1.5">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg bg-card px-3 py-2"
          >
            <span className="min-w-0 font-medium [overflow-wrap:anywhere]">
              <CustomerName customer={item} />
              {item.archived ? (
                <span className="ms-2 text-xs font-normal text-muted-foreground">
                  {t('orders.customers.archived')}
                </span>
              ) : null}
            </span>
            {onPick && !item.archived ? (
              <Button type="button" size="sm" variant="outline" onClick={() => onPick(item)}>
                {t('orders.customers.similar.use')}
              </Button>
            ) : opens ? (
              <Link
                href={`/b/${businessId}/customers/${item.id}`}
                className="text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                {t('orders.customers.similar.open')}
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function CustomerSheet({
  customer,
  name = '',
  onClose,
  onSaved,
  onPickExisting,
}: {
  /** Absent: a new customer. */
  customer?: CustomerDto
  /** A new customer's name as typed in a picker. */
  name?: string
  onClose: () => void
  /** After a save, before closing (e.g. an order names the new customer). */
  onSaved?: (customer: CustomerDto) => void
  /** From a picker: "Did you mean" names the customer meant instead. */
  onPickExisting?: (customer: CustomerPickItemDto) => void
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const refresh = useRefreshCustomers()
  const create = useMutation(trpc.customer.create.mutationOptions())
  const update = useMutation(trpc.customer.update.mutationOptions())
  const [newCustomerId] = useState(() => newId())
  const [initial] = useState<CustomerDraft>(() => customerDraft(customer, name))
  const [draft, setDraft] = useState<CustomerDraft>(initial)
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<I18nKey | null>(null)
  const form = useRef<HTMLFormElement>(null)
  const kindId = useId()
  const busy = create.isPending || update.isPending
  const check = checkCustomer(draft, customer)
  const shown = (error: FieldError | undefined): string | undefined =>
    error && (submitted || !MISSING.has(error.key)) ? t(error.key, error.values) : undefined
  const set = (patch: Partial<CustomerDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const nameChanged = formName(draft.name) !== (customer?.name ?? '')

  /** Saves the customer; true once saved (the form says what went wrong otherwise). */
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
      const saved = customer
        ? await update.mutateAsync({ id: customer.id, version: customer.version, ...fields })
        : await create.mutateAsync({ id: newCustomerId, ...fields })
      toast.success(
        customer ? t('catalog.list.saved') : t('catalog.list.added', { name: isolate(saved.name) }),
      )
      await refresh()
      onSaved?.(saved)
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
    // A form inside another form's page (an order, a sale): its submit is its own.
    event.stopPropagation()
    if (await save()) onClose()
  }

  const licensed = customerMayHaveLicence(draft.kind)
  const hasShownErrors = submitted && check.fields === null

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
            <SheetTitle dir={customer ? 'auto' : undefined}>
              {customer ? customer.name : t('orders.customers.form.newTitle')}
            </SheetTitle>
            <SheetDescription>
              {customer
                ? t('catalog.form.editDescription')
                : t('orders.customers.form.newDescription')}
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
              error={shown(check.errors.name)}
              hint={(id) => (
                <p id={id} className="text-sm text-muted-foreground">
                  {t('orders.customers.form.nameHint')}
                </p>
              )}
            />
            {nameChanged ? (
              <DidYouMean
                name={draft.name}
                excludeId={customer?.id}
                onPick={
                  onPickExisting
                    ? (item) => {
                        // The one meant is named; nothing typed here is kept (asked for: no
                        // question about unsaved changes).
                        onPickExisting(item)
                        onClose()
                      }
                    : undefined
                }
              />
            ) : null}
            <fieldset>
              <legend className="mb-2 text-sm font-medium">
                {t('orders.customers.form.kind')}
              </legend>
              <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
                {CUSTOMER_KINDS.map((kind: CustomerKind) => (
                  <label key={kind} className="relative min-w-0">
                    <input
                      type="radio"
                      name={`${kindId}-kind`}
                      value={kind}
                      checked={draft.kind === kind}
                      onChange={() => set({ kind })}
                      className="peer sr-only"
                    />
                    <span
                      className={cn(
                        'flex min-h-11 cursor-pointer items-center justify-center rounded-md px-1.5 py-1.5 text-center text-sm font-medium text-muted-foreground transition-colors',
                        'peer-checked:bg-card peer-checked:text-foreground peer-checked:shadow-sm',
                        'peer-focus-visible:ring-3 peer-focus-visible:ring-ring',
                      )}
                    >
                      {t(`orders.customers.kinds.${kind}`)}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <TextField
              label={t('orders.customers.form.phone')}
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
                  {t('orders.customers.form.phoneHint')}
                </p>
              )}
            />
            <TextField
              label={t('orders.customers.form.email')}
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
                  {t('orders.optional')}
                </p>
              )}
            />
            <TextField
              label={t('orders.customers.form.trn')}
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
                  {t('orders.customers.form.trnHint')}
                </p>
              )}
            />
            {licensed ? (
              <TextField
                label={t('orders.customers.form.licence')}
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                className="rtl:text-end"
                value={draft.tradeLicenceNo}
                onChange={(event) => set({ tradeLicenceNo: event.target.value })}
                error={shown(check.errors.tradeLicenceNo)}
                hint={(id) => (
                  <p id={id} className="text-sm text-muted-foreground">
                    {t('orders.customers.form.licenceHint')}
                  </p>
                )}
              />
            ) : null}
            <TextField
              label={t('orders.notes')}
              error={shown(check.errors.notes)}
              hint={(id) => (
                <p id={id} className="text-sm text-muted-foreground">
                  {t('orders.customers.form.notesHint')}
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
                : customer
                  ? t('catalog.form.save')
                  : t('catalog.form.add')}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
