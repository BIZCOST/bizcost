'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import {
  CREDIT_REASON_TEXT_MAX_LENGTH,
  type CreditNoteDto,
  type InvoiceDto,
  type InvoiceLineDto,
} from '@bizcost/contracts'
import {
  compareDecimal,
  creditNoteKindOf,
  CREDIT_REASONS,
  newId,
  taxDocumentDueBy,
  taxDocumentLate,
  type CreditReason,
  type CurrencyCode,
} from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { FormAlert } from '@/components/form/form-alert'
import { Required } from '@/components/form/required'
import { TextField } from '@/components/form/text-field'
import { sameData } from '@/components/form/unsaved'
import { useUnsavedChanges } from '@/components/form/unsaved-changes'
import { isolate } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { readAmount, readQuantity, withLatinDigits } from '@/features/catalog/numbers'
import { useUnitQuantity } from '@/features/catalog/unit-parts'
import { NBSP } from '@/features/catalog/units'
import { useBusinessDate, useMoney } from '@/features/documents/amounts'
import { MoneyInput } from '@/features/documents/line-editor'
import { cn } from '@/lib/utils'
import { CountedQuestion } from './counted-question'
import { creditNoteKindKey, useRefreshInvoices } from './data'

// A credit note of an issued invoice (M3 Step 8; VAT DL Arts 61, 62; ER Art. 60; Q26): the reason (one
// of the law's five, Art. 61(1); a plain credit note has no tax reasons), a short explanation printed
// on it, the day it happened (a tax credit note is due within 14 days of it, Art. 62(2): a warning
// once that has passed), and what it takes back of each line, by quantity or by amount, never more
// than is left. "Is this refund already in your recorded sales?" when the invoice was counted
// elsewhere (Q3). Saved as a draft; the page then asks to issue it (its own number, CN-0001…).

/** The reasons a plain credit note may give: never one about tax (Q26). */
const PLAIN_REASONS: readonly CreditReason[] = ['cancelled', 'price_changed', 'goods_returned']

interface Draft {
  readonly reason: CreditReason | ''
  readonly reasonText: string
  readonly eventDate: string
  readonly by: 'quantity' | 'amount'
  /** What each line takes back, as typed ('' : nothing). */
  readonly values: Readonly<Record<string, string>>
  readonly countedElsewhere: '' | 'yes' | 'no'
  readonly notes: string
}

/** What may be taken back of a line, as it is typed: its quantity, or its amount. */
function leftOf(line: InvoiceLineDto, by: Draft['by']): string {
  return by === 'quantity' ? line.left.qty : line.priceIncludesVat ? line.left.total : line.left.net
}

export function CreditNoteSheet({
  invoice,
  creditNote,
  today,
  onSaved,
  onClose,
}: {
  invoice: InvoiceDto
  /** A draft changed; absent: a new credit note. */
  creditNote?: CreditNoteDto
  today: string
  /** Saved as a draft: the page asks to issue it. */
  onSaved: (saved: CreditNoteDto) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const unitQuantity = useUnitQuantity()
  const refresh = useRefreshInvoices()
  const create = useMutation(trpc.creditNote.create.mutationOptions())
  const update = useMutation(trpc.creditNote.update.mutationOptions())
  const [id] = useState(() => creditNote?.id ?? newId())
  const kind = creditNoteKindOf(invoice.kind)
  const tax = kind === 'tax_credit_note'
  const reasons = tax ? CREDIT_REASONS : PLAIN_REASONS
  // The lines that can be credited: what is left of them (never a deposit taken off).
  const lines = useMemo(
    () =>
      invoice.lines.filter(
        (line) =>
          line.kind !== 'deduction' &&
          (compareDecimal(line.left.total, '0') > 0 ||
            creditNote?.lines.some((l) => l.invoiceLineId === line.id)),
      ),
    [invoice.lines, creditNote],
  )
  const [initial] = useState<Draft>(() => {
    if (!creditNote) {
      return {
        reason: '',
        reasonText: '',
        eventDate: today,
        by: 'quantity',
        values: {},
        countedElsewhere: '',
        notes: '',
      }
    }
    return {
      reason: creditNote.reason,
      reasonText: creditNote.reasonText,
      eventDate: creditNote.eventDate,
      by: creditNote.by,
      values: Object.fromEntries(
        creditNote.lines.map((line) => [
          line.invoiceLineId,
          creditNote.by === 'quantity' ? line.qty : line.priceIncludesVat ? line.total : line.net,
        ]),
      ),
      countedElsewhere:
        creditNote.countedElsewhere === null ? '' : creditNote.countedElsewhere ? 'yes' : 'no',
      notes: creditNote.notes ?? '',
    }
  })
  const [draft, setDraft] = useState<Draft>(initial)
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<I18nKey | null>(null)
  const form = useRef<HTMLFormElement>(null)
  const busy = create.isPending || update.isPending
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  const currency = invoice.currency as CurrencyCode
  // Asked when the invoice's sale was "already in your recorded sales" (the API decides at issue).
  const asks = creditNote ? creditNote.asksCountedElsewhere : invoice.countedElsewhere === true

  // Each line's value read against what is left of it.
  const lineErrors: Record<string, I18nKey> = {}
  const chosen: { invoiceLineId: string; qty?: string; amount?: string }[] = []
  for (const line of lines) {
    const typed = (draft.values[line.id] ?? '').trim()
    if (typed === '') continue
    const read =
      draft.by === 'quantity'
        ? readQuantity(typed)
        : readAmount(typed, { positive: true, currency })
    if (!read.ok) lineErrors[line.id] = read.error.key
    else if (compareDecimal(read.value, leftOf(line, draft.by)) > 0) {
      lineErrors[line.id] = 'documents.invoices.credit.errors.more'
    } else {
      chosen.push(
        draft.by === 'quantity'
          ? { invoiceLineId: line.id, qty: read.value }
          : { invoiceLineId: line.id, amount: read.value },
      )
    }
  }
  const errors: Partial<Record<'reason' | 'reasonText' | 'eventDate' | 'lines', I18nKey>> = {}
  if (draft.reason === '') errors.reason = 'documents.invoices.credit.errors.reason'
  if (draft.reasonText.trim() === '')
    errors.reasonText = 'documents.invoices.credit.errors.reasonText'
  else if (draft.reasonText.trim().length > CREDIT_REASON_TEXT_MAX_LENGTH) {
    errors.reasonText = 'documents.invoices.credit.errors.tooLong'
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.eventDate)) {
    errors.eventDate = 'documents.invoices.credit.errors.eventDate'
  } else if (draft.eventDate > today) errors.eventDate = 'errors.future_date'
  if (chosen.length === 0 && Object.keys(lineErrors).length === 0) {
    errors.lines = 'documents.invoices.credit.errors.lines'
  }
  const valid = Object.keys(errors).length === 0 && Object.keys(lineErrors).length === 0
  const late = tax && !errors.eventDate && taxDocumentLate(draft.eventDate, today)
  const shown = (key: I18nKey | undefined) => (submitted && key ? t(key) : undefined)

  function fillAll() {
    set({
      values: Object.fromEntries(lines.map((line) => [line.id, leftOf(line, draft.by)])),
    })
  }

  async function save(): Promise<CreditNoteDto | null> {
    setSubmitted(true)
    setServerError(null)
    if (!valid || draft.reason === '') {
      setTimeout(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
      return null
    }
    const fields = {
      eventDate: draft.eventDate,
      reason: draft.reason,
      reasonText: draft.reasonText.trim(),
      by: draft.by,
      lines: chosen,
      countedElsewhere:
        asks && draft.countedElsewhere !== '' ? draft.countedElsewhere === 'yes' : null,
      notes: draft.notes.trim() || null,
    }
    try {
      const saved = creditNote
        ? await update.mutateAsync({ id, version: creditNote.version, ...fields })
        : await create.mutateAsync({ id, invoiceId: invoice.id, ...fields })
      queryClient.setQueryData(trpc.creditNote.get.queryKey({ id }), saved)
      await refresh()
      return saved
    } catch (caught) {
      const code = apiErrorCode(caught)
      setServerError(
        code === 'conflict'
          ? 'documents.invoices.credit.conflict'
          : code === 'exceeds_invoice'
            ? 'errors.exceeds_invoice'
            : apiErrorKey(caught),
      )
      return null
    }
  }

  const guard = useUnsavedChanges({
    dirty: !sameData(draft, initial),
    save: async () => (await save()) !== null,
    close: onClose,
  })

  async function submit(event: FormEvent) {
    event.preventDefault()
    event.stopPropagation()
    if (busy) return
    const saved = await save()
    if (saved) onSaved(saved)
  }

  const kindName = t(creditNoteKindKey(kind))
  return (
    <Sheet open onOpenChange={(open) => !open && !busy && guard.requestLeave(onClose)}>
      <SheetContent closeLabel={t('actions.close')} className="sm:max-w-xl">
        <form
          ref={form}
          method="post"
          noValidate
          onSubmit={(event) => void submit(event)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <SheetHeader>
            <SheetTitle>
              {t('documents.invoices.credit.title', {
                kind: kindName,
                number: isolate(invoice.number ?? ''),
              })}
            </SheetTitle>
            <SheetDescription className="max-sm:not-sr-only">
              {t('documents.invoices.credit.description')}
            </SheetDescription>
          </SheetHeader>
          <SheetBody className="space-y-6">
            {serverError ? <FormAlert tone="error">{t(serverError)}</FormAlert> : null}
            <TextField
              label={<Required>{t('documents.invoices.credit.reason')}</Required>}
              error={shown(errors.reason)}
              render={(a11y) => (
                <NativeSelect
                  {...a11y}
                  aria-required
                  data-credit-reason
                  value={draft.reason}
                  onChange={(event) => set({ reason: event.target.value as CreditReason })}
                >
                  <option value="" disabled>
                    {t('documents.invoices.credit.reasonPick')}
                  </option>
                  {reasons.map((reason) => (
                    <option key={reason} value={reason}>
                      {t(`documents.invoices.credit.reasons.${reason}`)}
                    </option>
                  ))}
                </NativeSelect>
              )}
            />
            <TextField
              label={<Required>{t('documents.invoices.credit.reasonText')}</Required>}
              error={shown(errors.reasonText)}
              hint={(hintId) => (
                <p id={hintId} className="text-sm text-muted-foreground">
                  {t('documents.invoices.credit.reasonTextHint')}
                </p>
              )}
              render={(a11y) => (
                <Textarea
                  {...a11y}
                  data-credit-reason-text
                  className="[unicode-bidi:plaintext]"
                  rows={2}
                  value={draft.reasonText}
                  onChange={(event) => set({ reasonText: event.target.value })}
                />
              )}
            />
            <div className="space-y-2">
              <TextField
                label={t('documents.invoices.credit.eventDate')}
                type="date"
                max={today}
                data-credit-event-date
                value={draft.eventDate}
                onChange={(event) => set({ eventDate: event.target.value })}
                error={shown(errors.eventDate)}
                hint={(hintId) => (
                  <p id={hintId} className="text-sm text-muted-foreground">
                    {t('documents.invoices.credit.eventDateHint')}
                  </p>
                )}
              />
              {late ? (
                <FormAlert tone="error">
                  <span data-credit-late>
                    {t('documents.invoices.credit.late', {
                      date: businessDate(taxDocumentDueBy(draft.eventDate)),
                    })}
                  </span>
                </FormAlert>
              ) : null}
            </div>

            <fieldset className="min-w-0 space-y-3">
              <legend className="text-sm font-medium">
                {t('documents.invoices.credit.lines')}
              </legend>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex rounded-lg bg-muted p-1" role="radiogroup">
                  {(['quantity', 'amount'] as const).map((by) => (
                    <label key={by} className="relative">
                      <input
                        type="radio"
                        name="credit-by"
                        value={by}
                        data-credit-by={by}
                        checked={draft.by === by}
                        onChange={() => set({ by, values: {} })}
                        className="peer sr-only"
                      />
                      <span className="flex h-9 cursor-pointer items-center rounded-md px-3 text-sm font-medium text-muted-foreground peer-checked:bg-card peer-checked:text-foreground peer-checked:shadow-sm peer-focus-visible:ring-3 peer-focus-visible:ring-ring">
                        {t(`documents.invoices.credit.by.${by}`)}
                      </span>
                    </label>
                  ))}
                </div>
                <Button type="button" variant="link" className="h-9 px-0" onClick={fillAll}>
                  {t('documents.invoices.credit.all')}
                </Button>
              </div>
              {lines.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t('documents.invoices.credit.noneLeft')}
                </p>
              ) : (
                <ul className="divide-y rounded-xl border">
                  {lines.map((line) => {
                    const left = leftOf(line, draft.by)
                    const error = submitted ? lineErrors[line.id] : undefined
                    const label = t('documents.invoices.credit.lineValue', {
                      line: isolate(line.description),
                    })
                    return (
                      <li
                        key={line.id}
                        data-credit-line
                        className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_10rem] sm:items-center"
                      >
                        <div className="min-w-0 text-sm">
                          <p className="font-medium break-words">
                            <bdi>{line.description}</bdi>
                          </p>
                          <p className="text-muted-foreground">
                            {draft.by === 'quantity'
                              ? t('documents.invoices.credit.leftQty', {
                                  qty: (line.unit
                                    ? unitQuantity(left, line.unit)
                                    : left
                                  ).replaceAll(' ', NBSP),
                                })
                              : t(
                                  line.priceIncludesVat || !invoice.vatRegistered
                                    ? 'documents.invoices.credit.leftAmount'
                                    : 'documents.invoices.credit.leftAmountBeforeVat',
                                  { amount: money(left, invoice.currency) },
                                )}
                          </p>
                        </div>
                        <div>
                          {draft.by === 'quantity' ? (
                            <Input
                              aria-label={label}
                              aria-invalid={Boolean(error)}
                              inputMode="decimal"
                              dir="ltr"
                              autoComplete="off"
                              placeholder="0"
                              value={draft.values[line.id] ?? ''}
                              onChange={(event) =>
                                set({ values: { ...draft.values, [line.id]: event.target.value } })
                              }
                              onBlur={() =>
                                set({
                                  values: {
                                    ...draft.values,
                                    [line.id]: withLatinDigits(draft.values[line.id] ?? ''),
                                  },
                                })
                              }
                            />
                          ) : (
                            <MoneyInput
                              label={label}
                              invalid={Boolean(error)}
                              value={draft.values[line.id] ?? ''}
                              onChange={(value) =>
                                set({ values: { ...draft.values, [line.id]: value } })
                              }
                            />
                          )}
                          {error ? (
                            <p role="alert" className="mt-1 text-sm text-destructive">
                              {t(error)}
                            </p>
                          ) : null}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
              {shown(errors.lines) ? (
                <p role="alert" className={cn('text-sm text-destructive')}>
                  {shown(errors.lines)}
                </p>
              ) : null}
            </fieldset>

            {asks ? (
              <CountedQuestion
                credit
                value={draft.countedElsewhere}
                onChange={(countedElsewhere) => set({ countedElsewhere })}
              />
            ) : null}

            <TextField
              label={t('documents.invoices.credit.notes')}
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
            <Button type="submit" disabled={busy || lines.length === 0}>
              {busy ? t('status.saving') : t('documents.invoices.credit.continue')}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
