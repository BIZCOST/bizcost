'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { DocumentPaymentStateDto, SaleDto } from '@bizcost/contracts'
import {
  compareDecimal,
  newId,
  roundDocument,
  SETTLEMENT_METHODS,
  type CreditBy,
  type CurrencyCode,
  type SettlementMethod,
} from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { Required } from '@/components/form/required'
import { TextField } from '@/components/form/text-field'
import { sameData } from '@/components/form/unsaved'
import { useUnsavedChanges } from '@/components/form/unsaved-changes'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
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
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { withLatinDigits, type FieldError } from '@/features/catalog/numbers'
import { useUnitQuantity } from '@/features/catalog/unit-parts'
import { NBSP } from '@/features/catalog/units'
import { useMoney } from '@/features/documents/amounts'
import { firstOpenDay } from '@/features/documents/books'
import { MoneyInput } from '@/features/documents/line-editor'
import { useRefreshOrders } from '@/features/orders/data'
import { cn } from '@/lib/utils'
import { checkRefund, REFUND_MISSING, refundableLines, type RefundDraft } from './refund-draft'

// Refund (M3 Step 5; D-266): of a finalized sale, or a delivered order (its sale). "Items came back"
// takes back quantities (what they cost comes off too); "A price cut" takes an amount off a line (no
// cost comes off). Each line never more than is left. The sheet says what it gives back, and on an
// order or a sale "they'll pay later" what the customer then owes, or the money to give back with it
// (recorded in the same step, its method never picked for them). sale.refund, idempotent on the
// sheet's ids.

export function RefundSheet({
  sale,
  orderId,
  label,
  owed,
  canGiveBack,
  today,
  closedThrough,
  onDone,
  onClose,
}: {
  /** The finalized sale (an order's: its sale), with what is left of each line. */
  sale: SaleDto
  /** A delivered order's refund goes through the order. */
  orderId?: string
  /** "Order #1001", "the sale of 8 Oct": in the description. */
  label: string
  /** What the order or the sale "they'll pay later" is paid and owes (null: none, or not seen). */
  owed: DocumentPaymentStateDto | null
  /** The member records money given back (payments.customers.record). */
  canGiveBack: boolean
  today: string
  closedThrough: string | null
  onDone?: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const money = useMoney()
  const unitQuantity = useUnitQuantity()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const refresh = useRefreshOrders()
  const refund = useMutation(trpc.sale.refund.mutationOptions())
  const byId = useId()
  const [refundId] = useState(() => newId())
  const [paymentId] = useState(() => newId())
  const currency = sale.currency as CurrencyCode
  const [initial] = useState<RefundDraft>(() => ({
    by: 'quantity',
    businessDate: today,
    values: {},
    notes: '',
    giveBack: true,
    method: '',
    amount: '',
  }))
  const [draft, setDraft] = useState<RefundDraft>(initial)
  const [amountTouched, setAmountTouched] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<I18nKey | null>(null)
  const form = useRef<HTMLFormElement>(null)
  const check = useMemo(
    () =>
      checkRefund(draft, {
        lines: sale.lines,
        currency,
        vatRegistered: sale.vatRegistered,
        saleDate: sale.businessDate,
        today,
        closedThrough,
        owed,
        canGiveBack,
      }),
    [draft, sale, currency, today, closedThrough, owed, canGiveBack],
  )
  const offered = canGiveBack && compareDecimal(check.canGiveBack, '0') > 0
  // The money to give back follows what the refund comes to until it is typed.
  const backDefault = offered
    ? roundDocument(
        compareDecimal(check.amounts?.total ?? '0', check.canGiveBack) < 0
          ? (check.amounts?.total ?? '0')
          : check.canGiveBack,
        currency,
      )
    : ''
  const effective: RefundDraft = amountTouched ? draft : { ...draft, amount: backDefault }
  const checked = amountTouched
    ? check
    : checkRefund(effective, {
        lines: sale.lines,
        currency,
        vatRegistered: sale.vatRegistered,
        saleDate: sale.businessDate,
        today,
        closedThrough,
        owed,
        canGiveBack,
      })
  const shown = (error: FieldError | undefined): string | undefined =>
    error && (submitted || !REFUND_MISSING.has(error.key)) ? t(error.key, error.values) : undefined
  const set = (patch: Partial<RefundDraft>) => setDraft((d) => ({ ...d, ...patch }))
  const lines = refundableLines(sale.lines, draft.by)
  const openFrom = firstOpenDay(today, closedThrough)
  const minDate = openFrom && openFrom > sale.businessDate ? openFrom : sale.businessDate
  const busy = refund.isPending

  async function save(): Promise<boolean> {
    setSubmitted(true)
    setServerError(null)
    if (!checked.lines) {
      setTimeout(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
      return false
    }
    try {
      const result = await refund.mutateAsync({
        id: refundId,
        ...(orderId ? { orderId } : { saleId: sale.id }),
        by: draft.by,
        businessDate: draft.businessDate,
        lines: checked.lines,
        notes: draft.notes.trim() || null,
        payment:
          checked.payment && offered && draft.giveBack
            ? { id: paymentId, ...checked.payment }
            : null,
      })
      queryClient.setQueryData(trpc.sale.get.queryKey({ id: result.data.id }), result)
      await refresh()
      toast.success(
        t('orders.refund.recorded', {
          amount: money(result.data.total.replace(/^-/, ''), sale.currency),
        }),
      )
      onDone?.()
      return true
    } catch (error) {
      setServerError(
        apiErrorCode(error) === 'conflict'
          ? 'orders.conflict'
          : apiErrorCode(error) === 'books_closed'
            ? 'orders.refund.errors.booksClosed'
            : apiErrorKey(error),
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

  const lineError = (id: string) => shown(checked.errors.lines[id])

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
            <SheetTitle>{t('orders.refund.title')}</SheetTitle>
            <SheetDescription className="max-sm:not-sr-only">
              {t('orders.refund.description', { document: label })}
            </SheetDescription>
          </SheetHeader>
          <SheetBody className="space-y-6">
            {serverError ? <FormAlert tone="error">{t(serverError)}</FormAlert> : null}
            <fieldset>
              <legend className="mb-2 text-sm font-medium">{t('orders.refund.how')}</legend>
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
                {(['quantity', 'amount'] as const satisfies readonly CreditBy[]).map((by) => (
                  <label key={by} className="relative min-w-0">
                    <input
                      type="radio"
                      name={`${byId}-by`}
                      value={by}
                      checked={draft.by === by}
                      onChange={() => set({ by, values: {} })}
                      className="peer sr-only"
                    />
                    <span
                      className={cn(
                        'flex min-h-11 cursor-pointer items-center justify-center rounded-md px-2 py-1.5 text-center text-sm font-medium text-muted-foreground transition-colors',
                        'peer-checked:bg-card peer-checked:text-foreground peer-checked:shadow-sm',
                        'peer-focus-visible:ring-3 peer-focus-visible:ring-ring',
                      )}
                    >
                      {t(`orders.refund.by.${by}`)}
                    </span>
                  </label>
                ))}
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {t(`orders.refund.byHint.${draft.by}`)}
              </p>
            </fieldset>

            <fieldset>
              <legend className="mb-2 text-sm font-medium">{t('orders.refund.what')}</legend>
              {lines.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('orders.refund.nothingLeft')}</p>
              ) : (
                <ul className="space-y-2">
                  {lines.map((line) => {
                    const name =
                      line.kind === 'delivery'
                        ? t('orders.refund.delivery')
                        : (line.description ?? '')
                    const value = draft.values[line.id] ?? ''
                    const error = lineError(line.id)
                    const part = checked.perLine.get(line.id)
                    // A delivery is taken back whole, never by a count: what is left of it is an
                    // amount in both ways.
                    const leftText =
                      draft.by === 'quantity' && line.kind !== 'delivery'
                        ? t('orders.refund.leftQty', {
                            qty: (line.unit
                              ? unitQuantity(line.left.qty, line.unit)
                              : line.left.qty
                            ).replaceAll(' ', NBSP),
                          })
                        : t('orders.refund.leftAmount', {
                            amount: money(line.left.typed, sale.currency),
                          })
                    const setValue = (next: string) =>
                      set({ values: { ...draft.values, [line.id]: next } })
                    return (
                      <li
                        key={line.id}
                        data-refund-line={line.kind}
                        className="rounded-xl border bg-background/60 p-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                          <div className="min-w-0">
                            <p className="font-medium break-words">
                              <bdi>{name}</bdi>
                            </p>
                            <p className="text-sm text-muted-foreground">{leftText}</p>
                          </div>
                          {draft.by === 'quantity' && line.kind === 'delivery' ? (
                            <label className="flex min-h-11 items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={value === '1'}
                                onChange={(event) => setValue(event.target.checked ? '1' : '')}
                                className="size-5 accent-primary"
                              />
                              {t('orders.refund.deliveryBack')}
                            </label>
                          ) : draft.by === 'quantity' ? (
                            <Input
                              aria-label={t('orders.refund.qtyOf', { name })}
                              aria-invalid={Boolean(error)}
                              inputMode="decimal"
                              dir="ltr"
                              autoComplete="off"
                              spellCheck={false}
                              placeholder="0"
                              value={value}
                              onChange={(event) => setValue(event.target.value)}
                              onBlur={() => setValue(withLatinDigits(value))}
                              className="w-28 tabular-nums rtl:text-end"
                            />
                          ) : (
                            <MoneyInput
                              label={t('orders.refund.amountOf', { name })}
                              value={value}
                              invalid={Boolean(error)}
                              onChange={setValue}
                              className="w-40"
                            />
                          )}
                        </div>
                        {error ? (
                          <p role="alert" className="mt-1.5 text-sm text-destructive">
                            {error}
                          </p>
                        ) : part ? (
                          <p className="mt-1.5 text-end text-sm text-muted-foreground">
                            {t('orders.refund.lineBack', {
                              amount: money(part.total, sale.currency),
                            })}
                          </p>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              )}
              {shown(checked.errors.nothing) ? (
                <p role="alert" className="mt-2 text-sm text-destructive">
                  {shown(checked.errors.nothing)}
                </p>
              ) : null}
            </fieldset>

            <div data-refund-total className="space-y-1 rounded-xl bg-muted/60 px-4 py-3 text-sm">
              <p className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">{t('orders.refund.total')}</span>
                <bdi className="font-semibold tabular-nums">
                  {money(checked.amounts?.total ?? '0', sale.currency)}
                </bdi>
              </p>
              {sale.vatRegistered &&
              checked.amounts &&
              compareDecimal(checked.amounts.vat, '0') > 0 ? (
                <p className="text-muted-foreground">
                  {t('orders.refund.vatPart', {
                    amount: money(checked.amounts.vat, sale.currency),
                  })}
                </p>
              ) : null}
              {checked.owedAfter !== null && !offered ? (
                <p data-owed-after className="text-muted-foreground">
                  {t('orders.refund.owedAfter', {
                    amount: money(checked.owedAfter, sale.currency),
                  })}
                </p>
              ) : null}
            </div>

            <TextField
              label={t('orders.refund.date')}
              type="date"
              min={minDate}
              max={today}
              value={draft.businessDate}
              onChange={(event) => set({ businessDate: event.target.value })}
              error={shown(checked.errors.businessDate)}
            />

            {offered ? (
              <div data-give-back className="space-y-4 rounded-xl border p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <label htmlFor={`${byId}-back`} className="text-sm font-medium">
                      {t('orders.refund.giveBack')}
                    </label>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {t('orders.refund.giveBackHint', {
                        amount: money(checked.canGiveBack, sale.currency),
                      })}
                    </p>
                  </div>
                  <Switch
                    id={`${byId}-back`}
                    checked={draft.giveBack}
                    onCheckedChange={(giveBack) => set({ giveBack })}
                  />
                </div>
                {draft.giveBack ? (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <TextField
                      label={t('orders.payment.amount')}
                      error={shown(checked.errors.amount)}
                      render={(a11y) => (
                        <MoneyInput
                          id={a11y.id}
                          invalid={a11y['aria-invalid']}
                          describedBy={a11y['aria-describedby']}
                          value={effective.amount}
                          onChange={(amount) => {
                            setAmountTouched(true)
                            set({ amount })
                          }}
                        />
                      )}
                    />
                    <TextField
                      label={<Required>{t('orders.payment.methodBack')}</Required>}
                      error={shown(checked.errors.method)}
                      render={(a11y) => (
                        <NativeSelect
                          {...a11y}
                          aria-required
                          value={draft.method}
                          onChange={(event) =>
                            set({ method: event.target.value as SettlementMethod })
                          }
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
                  </div>
                ) : null}
              </div>
            ) : owed === null ? (
              <p className="text-sm text-muted-foreground">{t('orders.refund.paidWhenMade')}</p>
            ) : null}

            <TextField
              label={t('orders.refund.notes')}
              error={shown(checked.errors.notes)}
              hint={(id) => (
                <p id={id} className="text-sm text-muted-foreground">
                  {t('orders.refund.notesHint')}
                </p>
              )}
              render={(a11y) => (
                <Textarea
                  {...a11y}
                  className="[unicode-bidi:plaintext]"
                  rows={2}
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
              {busy ? t('status.saving') : t('orders.refund.save')}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
