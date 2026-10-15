'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { OwedDocumentDto } from '@bizcost/contracts'
import {
  compareDecimal,
  newId,
  roundDocument,
  SETTLEMENT_METHODS,
  type CurrencyCode,
  type SettlementMethod,
} from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation } from '@tanstack/react-query'
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
import { readAmount, type FieldError } from '@/features/catalog/numbers'
import { useMoney } from '@/features/documents/amounts'
import { firstOpenDay } from '@/features/documents/books'
import { MoneyInput } from '@/features/documents/line-editor'
import { useRefreshOrders } from '@/features/orders/data'
import {
  checkPayment,
  PAYMENT_MISSING,
  type PaymentDraft,
} from '@/features/purchasing/payment-draft'
import { cn } from '@/lib/utils'
import { allocate, owedIn } from './pay-many'
import { useOwedTitle } from './owed-title'

// "Pay several at once" (M3 Step 5; Q17, M14, D-267): one amount a customer paid, applied to their
// open orders and sales, oldest first (each may be left out), each up to what it still owes. The
// sheet shows what each one gets before it is recorded: one payment each, with its own id, in one
// step (customerPayment.recordMany). The method is required and never picked for them (D-159).
// When they are all sales (a business without Orders), it speaks of sales only (D-274).

interface ManyDraft extends PaymentDraft {
  /** The documents left out ("orderId" / "saleId" keys). */
  readonly skipped: readonly string[]
}

const keyOf = (document: OwedDocumentDto) => `${document.kind}:${document.id}`

export function PayManySheet({
  customer,
  documents,
  currency,
  today,
  closedThrough,
  onClose,
}: {
  customer: { readonly id: string; readonly name: string }
  /** Their documents still owed, oldest first. */
  documents: readonly OwedDocumentDto[]
  currency: string
  today: string
  closedThrough: string | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const money = useMoney()
  const trpc = useTRPC()
  const titleOf = useOwedTitle()
  const refresh = useRefreshOrders()
  const recordMany = useMutation(trpc.customerPayment.recordMany.mutationOptions())
  const code = currency as CurrencyCode
  const open = useMemo(
    () => documents.filter((document) => compareDecimal(document.owed, '0') > 0),
    [documents],
  )
  // One payment id per document, kept while the sheet is open (a retry records nothing twice).
  const [ids] = useState(() => new Map(open.map((document) => [keyOf(document), newId()])))
  const [initial] = useState<ManyDraft>(() => ({
    businessDate: today,
    method: '',
    amount: roundDocument(owedIn(open), code),
    note: '',
    skipped: [],
  }))
  const [draft, setDraft] = useState<ManyDraft>(initial)
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<I18nKey | null>(null)
  const form = useRef<HTMLFormElement>(null)
  const busy = recordMany.isPending
  const chosen = open.filter((document) => !draft.skipped.includes(keyOf(document)))
  const total = owedIn(chosen)
  const salesOnly = open.every((document) => document.kind === 'sale')
  const read = readAmount(draft.amount, { positive: true, currency: code })
  const amountRead = read.ok ? read.value : '0'
  const parts = allocate(amountRead, chosen)
  const reached = chosen.filter((_, index) => compareDecimal(parts[index]!, '0') > 0)
  // A payment is never before its document: the latest day of those it reaches.
  const latest = reached.reduce(
    (day, document) => (document.businessDate > day ? document.businessDate : day),
    reached[0]?.businessDate ?? today,
  )
  const check = checkPayment(draft, {
    currency: code,
    outstanding: total,
    documentDate: latest,
    today,
    closedThrough,
    beforeKey: salesOnly ? 'orders.payMany.beforeDocumentSales' : 'orders.payMany.beforeDocument',
    overKey: 'orders.payMany.overOwed',
  })
  const shown = (error: FieldError | undefined): string | undefined =>
    error && (submitted || !PAYMENT_MISSING.has(error.key))
      ? t(
          error.key === 'purchasing.payment.methodRequired'
            ? 'orders.payment.methodRequired'
            : error.key,
          error.values,
        )
      : undefined
  const set = (patch: Partial<ManyDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const openFrom = firstOpenDay(today, closedThrough)

  function toggle(document: OwedDocumentDto, on: boolean) {
    const key = keyOf(document)
    const skipped = on ? draft.skipped.filter((k) => k !== key) : [...draft.skipped, key]
    const next = open.filter((d) => !skipped.includes(keyOf(d)))
    // The amount follows what is chosen until it was typed.
    const typed = draft.amount !== roundDocument(total, code)
    set({ skipped, ...(typed ? {} : { amount: roundDocument(owedIn(next), code) }) })
  }

  async function save(): Promise<boolean> {
    setSubmitted(true)
    setServerError(null)
    if (!check.fields || reached.length === 0) {
      setTimeout(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
      return false
    }
    const { businessDate, method, amount, note } = check.fields
    try {
      await recordMany.mutateAsync({
        customerId: customer.id,
        businessDate,
        method,
        amount,
        note,
        documents: reached.map((document) => ({
          id: ids.get(keyOf(document))!,
          ...(document.kind === 'order' ? { orderId: document.id } : { saleId: document.id }),
        })),
      })
      await refresh()
      toast.success(
        t(salesOnly ? 'orders.payMany.recordedSales' : 'orders.payMany.recorded', {
          count: reached.length,
        }),
      )
      return true
    } catch (error) {
      setServerError(apiErrorCode(error) === 'conflict' ? 'orders.conflict' : apiErrorKey(error))
      return false
    }
  }

  const guard = useUnsavedChanges({ dirty: !sameData(draft, initial), save, close: onClose })

  async function submit(event: FormEvent) {
    event.preventDefault()
    event.stopPropagation()
    if (busy) return
    if (await save()) onClose()
  }

  return (
    <Sheet open onOpenChange={(next) => !next && !busy && guard.requestLeave(onClose)}>
      <SheetContent closeLabel={t('actions.close')}>
        <form
          ref={form}
          method="post"
          noValidate
          onSubmit={(event) => void submit(event)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <SheetHeader>
            <SheetTitle>{t('orders.payMany.title')}</SheetTitle>
            <SheetDescription className="max-sm:not-sr-only">
              {t(salesOnly ? 'orders.payMany.descriptionSales' : 'orders.payMany.description', {
                name: isolate(customer.name),
              })}
            </SheetDescription>
          </SheetHeader>
          <SheetBody className="space-y-6">
            {serverError ? <FormAlert tone="error">{t(serverError)}</FormAlert> : null}
            <fieldset>
              <legend className="mb-2 text-sm font-medium">{t('orders.payMany.which')}</legend>
              <ul className="space-y-2">
                {open.map((document) => {
                  const key = keyOf(document)
                  const on = !draft.skipped.includes(key)
                  const index = chosen.indexOf(document)
                  const part = index >= 0 ? parts[index]! : '0'
                  const full = compareDecimal(part, document.owed) === 0
                  return (
                    <li key={key}>
                      <label
                        data-pay-many-document
                        className={cn(
                          'flex cursor-pointer items-start gap-3 rounded-xl border p-3',
                          on ? 'bg-background' : 'bg-muted/40 text-muted-foreground',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(event) => toggle(document, event.target.checked)}
                          className="mt-0.5 size-5 shrink-0 accent-primary"
                        />
                        <span className="min-w-0 flex-1 text-sm">
                          <span className="block font-medium">
                            <bdi>{titleOf(document)}</bdi>
                          </span>
                          <span className="block text-muted-foreground">
                            {t('orders.payMany.owes', { amount: money(document.owed, currency) })}
                          </span>
                          {on ? (
                            <span data-applies className="mt-0.5 block font-medium text-foreground">
                              {compareDecimal(part, '0') === 0
                                ? t('orders.payMany.notReached')
                                : full
                                  ? t('orders.payMany.paysAll', { amount: money(part, currency) })
                                  : t('orders.payMany.paysPart', {
                                      amount: money(part, currency),
                                      of: money(document.owed, currency),
                                    })}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            </fieldset>
            <p className="flex items-baseline justify-between gap-3 rounded-xl bg-muted/60 px-4 py-3 text-sm">
              <span className="text-muted-foreground">{t('orders.payMany.owedChosen')}</span>
              <bdi data-owed-chosen className="font-semibold tabular-nums">
                {money(total, currency)}
              </bdi>
            </p>
            <TextField
              label={t('orders.payment.amount')}
              error={
                shown(check.errors.amount) ??
                (submitted && reached.length === 0
                  ? t(
                      salesOnly
                        ? 'orders.payMany.nothingChosenSales'
                        : 'orders.payMany.nothingChosen',
                    )
                  : undefined)
              }
              hint={(id) => (
                <p id={id} className="text-sm text-muted-foreground">
                  {t('orders.payMany.amountHint')}
                </p>
              )}
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
              label={t('orders.payment.date')}
              type="date"
              min={openFrom && openFrom > latest ? openFrom : latest}
              max={today}
              value={draft.businessDate}
              onChange={(event) => set({ businessDate: event.target.value })}
              error={shown(check.errors.businessDate)}
            />
            <TextField
              label={<Required>{t('orders.payment.method')}</Required>}
              error={shown(check.errors.method)}
              render={(a11y) => (
                <NativeSelect
                  {...a11y}
                  aria-required
                  value={draft.method}
                  onChange={(event) => set({ method: event.target.value as SettlementMethod })}
                >
                  <option value="" disabled>
                    {t('orders.payment.methodPick')}
                  </option>
                  {SETTLEMENT_METHODS.map((method) => (
                    <option key={method} value={method}>
                      {t(`purchasing.paymentMethods.${method}`)}
                    </option>
                  ))}
                </NativeSelect>
              )}
            />
            <TextField
              label={t('orders.payment.note')}
              error={shown(check.errors.note)}
              hint={(id) => (
                <p id={id} className="text-sm text-muted-foreground">
                  {t('orders.payment.noteHint')}
                </p>
              )}
              render={(a11y) => (
                <Textarea
                  {...a11y}
                  className="[unicode-bidi:plaintext]"
                  rows={2}
                  value={draft.note}
                  onChange={(event) => set({ note: event.target.value })}
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
              {busy ? t('status.saving') : t('orders.payment.save')}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
