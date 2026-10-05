'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { PayableKindDto, PurchasePaymentsDto } from '@bizcost/contracts'
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
import { useMoney } from '@/features/documents/amounts'
import { firstOpenDay } from '@/features/documents/books'
import { MoneyInput } from '@/features/documents/line-editor'
import { checkPayment, PAYMENT_MISSING, paymentDraft, type PaymentDraft } from './payment-draft'

// "Record a payment" of what is owed on a purchase (the owner's request of 2026-09-29) or an expense
// (M2 Step 5, D-166), from the document or from Amounts owed: the day, how it was paid, how much (all
// that is owed to start with; part of it is fine) and an optional note. purchasePayment.record or
// expensePayment.record, idempotent on the sheet's id.

/** A document something is owed on: a purchase or an expense (D-166). */
export interface OwedDocument {
  readonly kind: PayableKindDto
  readonly id: string
  /** Its own day: a payment is never before it. */
  readonly businessDate: string
}

/**
 * Who it is owed to, its amounts and its payments: purchasePayment.list's data or
 * expensePayment.list's (the same fields; each adds its own id).
 */
export type OwedAmounts = Omit<PurchasePaymentsDto['data'], 'purchaseId' | 'status'> & {
  readonly status: string
}

/** "What you paid … for this purchase" (or expense), to a supplier or back to a member. */
const DESCRIPTIONS = {
  purchase: {
    supplier: 'purchasing.payment.descriptionSupplier',
    member: 'purchasing.payment.descriptionMember',
  },
  expense: {
    supplier: 'purchasing.payment.descriptionSupplierExpense',
    member: 'purchasing.payment.descriptionMemberExpense',
  },
} as const

export function PaymentSheet({
  document,
  owed,
  today,
  closedThrough,
  onClose,
}: {
  document: OwedDocument
  /** Its payments and what is still owed on it. */
  owed: OwedAmounts
  today: string
  closedThrough: string | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const money = useMoney()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const recordPurchase = useMutation(trpc.purchasePayment.record.mutationOptions())
  const recordExpense = useMutation(trpc.expensePayment.record.mutationOptions())
  const [paymentId] = useState(() => newId())
  const [initial] = useState<PaymentDraft>(() =>
    paymentDraft(owed.outstanding ?? '0', today, owed.currency as CurrencyCode),
  )
  const [draft, setDraft] = useState<PaymentDraft>(initial)
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<I18nKey | null>(null)
  const form = useRef<HTMLFormElement>(null)
  const busy = recordPurchase.isPending || recordExpense.isPending
  const currency = owed.currency as CurrencyCode
  const check = useMemo(
    () =>
      checkPayment(draft, {
        currency,
        outstanding: owed.outstanding ?? '0',
        kind: document.kind,
        documentDate: document.businessDate,
        today,
        closedThrough,
      }),
    [draft, currency, owed.outstanding, document, today, closedThrough],
  )
  const shown = (error: FieldError | undefined): string | undefined =>
    error && (submitted || !PAYMENT_MISSING.has(error.key)) ? t(error.key, error.values) : undefined
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
    try {
      if (document.kind === 'expense') {
        const result = await recordExpense.mutateAsync({
          id: paymentId,
          expenseId: document.id,
          ...check.fields,
        })
        queryClient.setQueryData(
          trpc.expensePayment.list.queryKey({ expenseId: document.id }),
          result,
        )
      } else {
        const result = await recordPurchase.mutateAsync({
          id: paymentId,
          purchaseId: document.id,
          ...check.fields,
        })
        queryClient.setQueryData(
          trpc.purchasePayment.list.queryKey({ purchaseId: document.id }),
          result,
        )
      }
      await queryClient.invalidateQueries({ queryKey: trpc.payable.list.pathKey() })
      toast.success(t('purchasing.payment.recorded'))
      return true
    } catch (error) {
      setServerError(
        apiErrorCode(error) === 'conflict' ? 'purchasing.editor.conflict' : apiErrorKey(error),
      )
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

  const owedTo = owed.owedTo?.name ?? ''

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
            <SheetTitle>{t('purchasing.payment.title')}</SheetTitle>
            <SheetDescription className="max-sm:not-sr-only">
              {t(DESCRIPTIONS[document.kind][owed.owedTo?.party ?? 'supplier'], {
                name: isolate(owedTo),
              })}
            </SheetDescription>
          </SheetHeader>
          <SheetBody className="space-y-6">
            {serverError ? <FormAlert tone="error">{t(serverError)}</FormAlert> : null}
            <p className="flex items-baseline justify-between gap-3 rounded-xl bg-muted/60 px-4 py-3 text-sm">
              <span className="text-muted-foreground">{t('purchasing.payments.outstanding')}</span>
              <bdi data-outstanding className="font-semibold tabular-nums">
                {money(owed.outstanding ?? '0', currency)}
              </bdi>
            </p>
            <TextField
              label={t('purchasing.payment.date')}
              type="date"
              min={minDate}
              max={today}
              value={draft.businessDate}
              onChange={(event) => set({ businessDate: event.target.value })}
              error={shown(check.errors.businessDate)}
            />
            <TextField
              label={<Required>{t('purchasing.payment.method')}</Required>}
              error={shown(check.errors.method)}
              render={(a11y) => (
                <NativeSelect
                  {...a11y}
                  aria-required
                  value={draft.method}
                  onChange={(event) => set({ method: event.target.value as SettlementMethod })}
                >
                  <option value="" disabled>
                    {t('purchasing.payment.methodPick')}
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
              label={t('purchasing.payment.amount')}
              error={shown(check.errors.amount)}
              hint={(id) => (
                <p id={id} className="text-sm text-muted-foreground">
                  {t('purchasing.payment.amountHint', {
                    amount: money(owed.outstanding ?? '0', currency),
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
              label={t('purchasing.payment.note')}
              error={shown(check.errors.note)}
              hint={(id) => (
                <p id={id} className="text-sm text-muted-foreground">
                  {t('purchasing.payment.noteHint')}
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
              {busy ? t('status.saving') : t('purchasing.payment.save')}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
