'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { DocumentPaymentsDto, ReceivableKindDto } from '@bizcost/contracts'
import {
  newId,
  SETTLEMENT_METHODS,
  type CurrencyCode,
  type SettlementMethod,
} from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { Required } from '@/components/form/required'
import { TextField } from '@/components/form/text-field'
import { sameData } from '@/components/form/unsaved'
import { useUnsavedChanges } from '@/components/form/unsaved-changes'
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
import { useMoney } from '@/features/documents/amounts'
import { firstOpenDay } from '@/features/documents/books'
import { MoneyInput } from '@/features/documents/line-editor'
import { useRefreshOrders } from '@/features/orders/data'
import {
  checkPayment,
  PAYMENT_MISSING,
  paymentDraft,
  type PaymentDraft,
} from '@/features/purchasing/payment-draft'

// A customer's payment on an order or a sale "they'll pay later" (M3 Step 5; Q17, D-267), or money
// given back to them: the day, how (cash, card, bank transfer or cheque: required, never picked for
// them, D-159), how much (all that is still owed to start with, part of it is fine, never more; money
// given back at most what was paid beyond what it comes to) and an optional note.
// customerPayment.record, idempotent on the sheet's id.

/** What a payment is recorded on. */
export interface PaidDocument {
  readonly kind: ReceivableKindDto
  readonly id: string
  /** Its own day: a payment is never before it. */
  readonly businessDate: string
  /** "Order #1001", "the sale of 8 Oct" (in the sheet's description). */
  readonly label: string
}

export function CustomerPaymentSheet({
  document,
  mode,
  max,
  currency,
  today,
  closedThrough,
  onRecorded,
  onClose,
}: {
  document: PaidDocument
  /** A payment towards what is owed, or money given back. */
  mode: 'payment' | 'refund'
  /** What is still owed (a payment), or what was paid beyond it (money given back). */
  max: string
  currency: string
  today: string
  closedThrough: string | null
  /** After it is recorded, with the document's payments as they are now. */
  onRecorded?: (result: DocumentPaymentsDto) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const money = useMoney()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const refresh = useRefreshOrders()
  const record = useMutation(trpc.customerPayment.record.mutationOptions())
  const [paymentId] = useState(() => newId())
  const code = currency as CurrencyCode
  const [initial] = useState<PaymentDraft>(() => paymentDraft(max, today, code))
  const [draft, setDraft] = useState<PaymentDraft>(initial)
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<I18nKey | null>(null)
  const form = useRef<HTMLFormElement>(null)
  const busy = record.isPending
  const refund = mode === 'refund'
  const check = useMemo(
    () =>
      checkPayment(draft, {
        currency: code,
        outstanding: max,
        documentDate: document.businessDate,
        today,
        closedThrough,
        beforeKey:
          document.kind === 'order' ? 'orders.payment.beforeOrder' : 'orders.payment.beforeSale',
        overKey: refund ? 'orders.payment.overMoneyBack' : undefined,
      }),
    [draft, code, max, document, today, closedThrough, refund],
  )
  const shown = (error: FieldError | undefined): string | undefined =>
    error && (submitted || !PAYMENT_MISSING.has(error.key))
      ? t(
          error.key === 'purchasing.payment.methodRequired'
            ? 'orders.payment.methodRequired'
            : error.key,
          error.values,
        )
      : undefined
  const set = (patch: Partial<PaymentDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const openFrom = firstOpenDay(today, closedThrough)
  const minDate = openFrom && openFrom > document.businessDate ? openFrom : document.businessDate

  /** Records it; true once recorded (the sheet says what went wrong otherwise). */
  async function save(): Promise<boolean> {
    setSubmitted(true)
    setServerError(null)
    if (!check.fields) {
      setTimeout(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
      return false
    }
    const { businessDate, method, amount, note } = check.fields
    try {
      const result = await record.mutateAsync({
        id: paymentId,
        ...(document.kind === 'order' ? { orderId: document.id } : { saleId: document.id }),
        kind: mode,
        businessDate,
        method,
        amount,
        note,
      })
      queryClient.setQueryData(
        trpc.customerPayment.list.queryKey(
          document.kind === 'order' ? { orderId: document.id } : { saleId: document.id },
        ),
        { ...result, nextCursor: null },
      )
      await refresh()
      toast.success(t(refund ? 'orders.payment.moneyBackRecorded' : 'orders.payment.recorded'))
      onRecorded?.(result)
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
            <SheetTitle>
              {t(refund ? 'orders.payment.moneyBackTitle' : 'orders.payment.title')}
            </SheetTitle>
            <SheetDescription className="max-sm:not-sr-only">
              {t(refund ? 'orders.payment.moneyBackDescription' : 'orders.payment.description', {
                document: document.label,
              })}
            </SheetDescription>
          </SheetHeader>
          <SheetBody className="space-y-6">
            {serverError ? <FormAlert tone="error">{t(serverError)}</FormAlert> : null}
            <p className="flex items-baseline justify-between gap-3 rounded-xl bg-muted/60 px-4 py-3 text-sm">
              <span className="text-muted-foreground">
                {t(refund ? 'orders.payments.overpaid' : 'orders.payments.owed')}
              </span>
              <bdi data-owed-now className="font-semibold tabular-nums">
                {money(max, currency)}
              </bdi>
            </p>
            <TextField
              label={t(refund ? 'orders.payment.dateBack' : 'orders.payment.date')}
              type="date"
              min={minDate}
              max={today}
              value={draft.businessDate}
              onChange={(event) => set({ businessDate: event.target.value })}
              error={shown(check.errors.businessDate)}
            />
            <TextField
              label={
                <Required>
                  {t(refund ? 'orders.payment.methodBack' : 'orders.payment.method')}
                </Required>
              }
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
              label={t('orders.payment.amount')}
              error={shown(check.errors.amount)}
              hint={(id) => (
                <p id={id} className="text-sm text-muted-foreground">
                  {t(refund ? 'orders.payment.amountHintBack' : 'orders.payment.amountHint', {
                    amount: money(max, currency),
                  })}
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
              {busy
                ? t('status.saving')
                : t(refund ? 'orders.payment.saveBack' : 'orders.payment.save')}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
