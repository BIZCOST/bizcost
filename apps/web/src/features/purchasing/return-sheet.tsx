'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { PurchaseDto, PurchaseLineDto, PurchaseReturnResultDto } from '@bizcost/contracts'
import { compareDecimal, newId, type PurchaseReturnKind } from '@bizcost/domain'
import { formatList, type I18nKey } from '@bizcost/i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCheckIcon, Trash2Icon, Undo2Icon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { TextField } from '@/components/form/text-field'
import { isolate } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { withLatinDigits, type FieldError } from '@/features/catalog/numbers'
import { useFormatQuantity, useUnitQuantity } from '@/features/catalog/unit-parts'
import { nameAfterQuantity, NBSP } from '@/features/catalog/units'
import { can } from '@/features/settings/sections'
import { useLocale } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { Money, useBusinessDate, useMoney } from './amounts'
import { closedFor, firstOpenDay } from './books'
import { ConfirmDialog } from './confirm-dialog'
import { MoneyInput } from './purchase-lines'
import {
  checkReturn,
  creditTotal,
  quantityLeft,
  returnableLines,
  returnAmount,
  returnDraft,
  type ReturnDraft,
} from './return-draft'
import { StatusBadge } from './status-badge'

// A supplier return or credit note of a final purchase (M2 Step 3; D-120, D-136), in a sheet on
// phones and a side panel on a desktop. A return: how many of each line went back (at most what is
// left); they leave the stock at the price paid for them. A credit note: an amount before VAT per
// line, or one amount the API shares over the lines; the goods' cost goes down by it. Drafts are
// saved, finalized (purchases.documents.post), discarded; a final one can be reversed
// (purchases.documents.reverse).

/** "2 bags", "1.5 kg": a quantity in a purchase line's own unit. */
export function useLineQuantity() {
  const format = useFormatQuantity()
  const unitQuantity = useUnitQuantity()
  return (qty: string, line: Pick<PurchaseLineDto, 'unit' | 'packName'>) =>
    line.unit
      ? unitQuantity(qty, line.unit)
      : `${format(qty)}${NBSP}${nameAfterQuantity(line.packName ?? '', qty)}`
}

type Busy = 'saving' | 'finalizing' | 'reversing' | 'discarding' | null

export function ReturnSheet({
  purchase,
  kind,
  returnId,
  today,
  closedThrough,
  onClose,
}: {
  purchase: PurchaseDto
  kind: PurchaseReturnKind
  /** Absent: a new one. */
  returnId?: string
  today: string
  /** The books-closed date: said next to the date before Finalize (D-143). */
  closedThrough: string | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const existing = useQuery({
    ...trpc.purchaseReturn.get.queryOptions({ id: returnId ?? '' }),
    enabled: returnId !== undefined,
  })
  // It could not be read (e.g. discarded meanwhile): say so, and close.
  const failed = returnId !== undefined && existing.isError ? existing.error : null
  useEffect(() => {
    if (failed) {
      toast.error(t(apiErrorKey(failed)))
      onClose()
    }
  }, [failed, onClose, t])
  if (returnId && !existing.data) return null
  return (
    <ReturnForm
      purchase={purchase}
      kind={existing.data?.data.kind ?? kind}
      stored={existing.data}
      today={today}
      closedThrough={closedThrough}
      onClose={onClose}
    />
  )
}

function ReturnForm({
  purchase,
  kind,
  stored,
  today,
  closedThrough,
  onClose,
}: {
  purchase: PurchaseDto
  kind: PurchaseReturnKind
  stored: PurchaseReturnResultDto | undefined
  today: string
  closedThrough: string | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const businessDate = useBusinessDate()
  const money = useMoney()
  const lineQuantity = useLineQuantity()
  const { data: context } = useBusinessContext()
  // Not VAT-registered: amounts are what was paid, never "before VAT".
  const vatRegistered = context?.capabilities.vat_registered === true
  const create = useMutation(trpc.purchaseReturn.create.mutationOptions())
  const update = useMutation(trpc.purchaseReturn.update.mutationOptions())
  const post = useMutation(trpc.purchaseReturn.post.mutationOptions())
  const reverse = useMutation(trpc.purchaseReturn.reverse.mutationOptions())
  const discard = useMutation(trpc.purchaseReturn.discard.mutationOptions())
  const document = stored?.data
  const [id] = useState(() => document?.id ?? newId())
  const [version, setVersion] = useState<number | null>(document?.version ?? null)
  const [status, setStatus] = useState(document?.status ?? 'draft')
  const [draft, setDraft] = useState<ReturnDraft>(() => returnDraft(kind, document, today))
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<I18nKey | null>(null)
  const [confirm, setConfirm] = useState<'finalize' | 'reverse' | 'discard' | null>(null)
  const [confirmError, setConfirmError] = useState<I18nKey | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  // Finalize was tapped while the closed books stop it: said at the top too.
  const [finalizeBlocked, setFinalizeBlocked] = useState(false)
  const form = useRef<HTMLFormElement>(null)

  const canManage = context ? can(context, 'purchases.documents.manage') : false
  const canPost = context ? can(context, 'purchases.documents.post') : false
  const canReverse = context ? can(context, 'purchases.documents.reverse') : false
  // A draft whose amounts this member may not see cannot be saved back whole: it is only shown.
  const editable =
    status === 'draft' && canManage && (stored === undefined || stored.meta.redacted.length === 0)
  const lines = returnableLines(purchase)
  const check = checkReturn(kind, draft, purchase, { today, stored: document })
  // More than is left is said at once; the rest once the person tries to save.
  const shown = (error: FieldError | undefined): string | undefined =>
    error && (submitted || error.key === 'errors.exceeds_purchase')
      ? t(error.key, error.values)
      : undefined
  const isReturn = kind === 'return'
  // The books-closed date stops finalizing on this date (D-114 rule 6): said under the date at once.
  const closed = editable && canPost ? closedFor(draft.businessDate, today, closedThrough) : null
  const closedNote =
    closed && closedThrough
      ? t(
          closed === 'today' ? 'purchasing.editor.closedToday' : 'purchasing.editor.closedEarlier',
          {
            date: businessDate(closedThrough),
          },
        )
      : null
  const openFrom = canPost ? firstOpenDay(today, closedThrough) : undefined
  const minDate = openFrom && openFrom > purchase.businessDate ? openFrom : purchase.businessDate

  // The materials it concerns, for the confirmations.
  const concerned = lines.filter((line) =>
    draft.split ? true : (draft.values[line.id] ?? '').trim() !== '',
  )
  const names = formatList(
    locale,
    [...new Set(concerned.map((line) => line.description ?? ''))]
      .filter(Boolean)
      .map((name) => isolate(name)),
  )
  const fields = check.fields
  const items = fields
    ? formatList(
        locale,
        (fields.lines ?? []).flatMap((typed) => {
          const line = lines.find((l) => l.id === typed.purchaseLineId)
          return line && typed.qty
            ? [
                t('purchasing.returns.qtyOf', {
                  qty: lineQuantity(typed.qty, line),
                  name: isolate(line.description ?? ''),
                }),
              ]
            : []
        }),
      )
    : ''
  const amount = !fields ? null : isReturn ? returnAmount(purchase, fields) : creditTotal(fields)
  let confirmBody: string
  if (amount === null) {
    confirmBody = isReturn
      ? t('purchasing.returns.confirmReturnBody', { names })
      : t('purchasing.returns.confirmCreditBody', { names })
  } else if (isReturn) {
    confirmBody = t(
      vatRegistered
        ? 'purchasing.returns.confirmReturnAmount'
        : 'purchasing.returns.confirmReturnAmountNoVat',
      { items, names, amount: money(amount, purchase.currency) },
    )
  } else {
    confirmBody = t(
      vatRegistered
        ? 'purchasing.returns.confirmCreditAmount'
        : 'purchasing.returns.confirmCreditAmountNoVat',
      { names, amount: money(amount, purchase.currency) },
    )
  }

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.purchase.get.queryKey({ id: purchase.id }) }),
      queryClient.invalidateQueries({ queryKey: trpc.purchaseReturn.get.pathKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.purchase.list.pathKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.material.costs.pathKey() }),
    ])
  }

  function errorKey(error: unknown): I18nKey {
    return apiErrorCode(error) === 'conflict' ? 'purchasing.editor.conflict' : apiErrorKey(error)
  }

  async function save(): Promise<number> {
    const fields = check.fields!
    const result =
      version === null
        ? await create.mutateAsync({ id, purchaseId: purchase.id, kind, ...fields })
        : await update.mutateAsync({ id, version, ...fields })
    setVersion(result.data.version)
    return result.data.version
  }

  function ready(): boolean {
    setSubmitted(true)
    setServerError(null)
    if (!check.fields) {
      setTimeout(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus())
      return false
    }
    return true
  }

  async function saveDraft() {
    if (busy || !ready()) return
    setBusy('saving')
    try {
      await save()
      await refresh()
      toast.success(t('purchasing.editor.saved'))
      onClose()
    } catch (error) {
      setServerError(errorKey(error))
    } finally {
      setBusy(null)
    }
  }

  async function finalize() {
    setBusy('finalizing')
    setConfirmError(null)
    try {
      const saved = await save()
      await post.mutateAsync({ id, version: saved })
      await refresh()
      toast.success(
        t(isReturn ? 'purchasing.returns.returnFinalized' : 'purchasing.returns.creditFinalized', {
          names,
        }),
      )
      setConfirm(null)
      onClose()
    } catch (error) {
      setConfirmError(errorKey(error))
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  async function reverseIt() {
    setBusy('reversing')
    setConfirmError(null)
    try {
      await reverse.mutateAsync({ id })
      setStatus('reversed')
      await refresh()
      toast.success(t('purchasing.returns.reversed'))
      setConfirm(null)
      onClose()
    } catch (error) {
      setConfirmError(
        apiErrorCode(error) === 'books_closed'
          ? 'purchasing.confirm.reverseClosed'
          : errorKey(error),
      )
    } finally {
      setBusy(null)
    }
  }

  async function discardIt() {
    if (version === null) return
    setBusy('discarding')
    setConfirmError(null)
    try {
      await discard.mutateAsync({ id, version })
      await refresh()
      toast.success(t('purchasing.confirm.discarded'))
      setConfirm(null)
      onClose()
    } catch (error) {
      setConfirmError(errorKey(error))
    } finally {
      setBusy(null)
    }
  }

  const title = isReturn ? t('purchasing.returns.returnTitle') : t('purchasing.returns.creditTitle')
  const storedLine = (purchaseLineId: string) =>
    document?.lines.find((line) => line.purchaseLineId === purchaseLineId)

  return (
    <Sheet open onOpenChange={(open) => !open && busy === null && onClose()}>
      <SheetContent closeLabel={t('actions.close')}>
        <form
          ref={form}
          method="post"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            event.stopPropagation()
            void saveDraft()
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <SheetHeader>
            <div className="flex flex-wrap items-center gap-2">
              <SheetTitle>{title}</SheetTitle>
              {version !== null ? <StatusBadge status={status} kind="document" /> : null}
            </div>
            {/* Kept on a phone too: it is what tells a return from a credit note. */}
            <SheetDescription className="max-sm:not-sr-only">
              {isReturn
                ? t('purchasing.returns.returnDescription')
                : t('purchasing.returns.creditDescription')}
            </SheetDescription>
          </SheetHeader>
          <SheetBody className="space-y-6">
            {serverError ? <FormAlert tone="error">{t(serverError)}</FormAlert> : null}
            {finalizeBlocked && closedNote ? (
              <FormAlert tone="error">{closedNote}</FormAlert>
            ) : null}
            {status === 'reversed' && document?.reversalDate ? (
              <FormAlert tone="info">
                {t('purchasing.returns.reversedNote', {
                  date: businessDate(document.reversalDate),
                })}
              </FormAlert>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label={t('purchasing.editor.date')}
                type="date"
                min={minDate}
                max={today}
                readOnly={!editable}
                value={draft.businessDate}
                onChange={(event) => setDraft((d) => ({ ...d, businessDate: event.target.value }))}
                error={
                  shown(check.errors.businessDate) ??
                  (closed === 'earlier' && closedNote ? closedNote : undefined)
                }
                hint={
                  closed === 'today' && closedNote
                    ? (id) => (
                        <div id={id}>
                          <FormAlert tone="info">{closedNote}</FormAlert>
                        </div>
                      )
                    : undefined
                }
              />
              <TextField
                label={
                  isReturn
                    ? t('purchasing.returns.returnReference')
                    : t('purchasing.returns.creditReference')
                }
                autoComplete="off"
                readOnly={!editable}
                className="[unicode-bidi:plaintext]"
                value={draft.reference}
                onChange={(event) => setDraft((d) => ({ ...d, reference: event.target.value }))}
                error={shown(check.errors.reference)}
              />
            </div>

            {!isReturn && editable ? (
              <fieldset className="space-y-2">
                <legend className="mb-2 text-sm font-semibold">
                  {t('purchasing.returns.howCredit')}
                </legend>
                {([false, true] as const).map((split) => (
                  <label
                    key={String(split)}
                    className="flex min-h-11 cursor-pointer items-start gap-3 py-1"
                  >
                    <input
                      type="radio"
                      name="credit-split"
                      checked={draft.split === split}
                      onChange={() => setDraft((d) => ({ ...d, split }))}
                      className="mt-0.5 size-5 shrink-0 accent-primary"
                    />
                    <span className="min-w-0 text-sm">
                      <span className="block font-medium">
                        {split ? t('purchasing.returns.split') : t('purchasing.returns.perLine')}
                      </span>
                      {split ? (
                        <span className="block text-muted-foreground">
                          {t('purchasing.returns.splitHint')}
                        </span>
                      ) : null}
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : null}

            {!isReturn && draft.split && editable ? (
              <TextField
                label={
                  vatRegistered
                    ? t('purchasing.returns.splitAmount')
                    : t('purchasing.returns.splitAmountNoVat')
                }
                error={shown(check.errors.splitAmount)}
                render={(a11y) => (
                  <MoneyInput
                    id={a11y.id}
                    value={draft.splitAmount}
                    invalid={a11y['aria-invalid']}
                    describedBy={a11y['aria-describedby']}
                    onChange={(splitAmount) => setDraft((d) => ({ ...d, splitAmount }))}
                  />
                )}
              />
            ) : (
              <section className="space-y-3">
                <h3 className="text-sm font-semibold">{t('purchasing.returns.items')}</h3>
                {lines.map((line, index) => {
                  const left = quantityLeft(line)
                  const saved = storedLine(line.id)
                  const error = shown(check.errors.lines[line.id])
                  if (!editable && !saved) return null
                  return (
                    <div
                      key={line.id}
                      data-return-line={index + 1}
                      className="rounded-xl border bg-background/60 p-3"
                    >
                      <p dir="auto" className="font-medium">
                        {line.description}
                      </p>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {t('purchasing.returns.bought', { qty: lineQuantity(line.qty, line) })}
                        {compareDecimal(line.returnedQty, '0') > 0
                          ? ` · ${t('purchasing.view.returned', { qty: lineQuantity(line.returnedQty, line) })}`
                          : null}
                        {!isReturn ? (
                          <>
                            {' · '}
                            {vatRegistered
                              ? t('purchasing.returns.paidBeforeVat')
                              : t('purchasing.returns.paidNoVat')}{' '}
                            <Money value={line.taxable} currency={purchase.currency} />
                          </>
                        ) : null}
                      </p>
                      {editable ? (
                        <div className="mt-2">
                          {isReturn ? (
                            <div className="flex items-center gap-2">
                              <Input
                                aria-label={t('purchasing.returns.howMany', {
                                  name: isolate(line.description ?? ''),
                                })}
                                aria-invalid={Boolean(error)}
                                inputMode="decimal"
                                dir="ltr"
                                autoComplete="off"
                                spellCheck={false}
                                placeholder="0"
                                value={draft.values[line.id] ?? ''}
                                onChange={(event) =>
                                  setDraft((d) => ({
                                    ...d,
                                    values: { ...d.values, [line.id]: event.target.value },
                                  }))
                                }
                                onBlur={() =>
                                  setDraft((d) => ({
                                    ...d,
                                    values: {
                                      ...d.values,
                                      [line.id]: withLatinDigits(d.values[line.id] ?? ''),
                                    },
                                  }))
                                }
                                className="w-28 shrink-0 tabular-nums rtl:text-end"
                              />
                              <span className="text-sm text-muted-foreground">
                                {t('purchasing.returns.upTo', { qty: lineQuantity(left, line) })}
                              </span>
                            </div>
                          ) : (
                            <MoneyInput
                              label={t(
                                vatRegistered
                                  ? 'purchasing.returns.amountFor'
                                  : 'purchasing.returns.amountForNoVat',
                                { name: isolate(line.description ?? '') },
                              )}
                              value={draft.values[line.id] ?? ''}
                              invalid={Boolean(error)}
                              onChange={(value) =>
                                setDraft((d) => ({
                                  ...d,
                                  values: { ...d.values, [line.id]: value },
                                }))
                              }
                            />
                          )}
                          {error ? (
                            <p role="alert" className="mt-1.5 text-sm text-destructive">
                              {error}
                            </p>
                          ) : null}
                        </div>
                      ) : saved ? (
                        <p className="mt-2 text-sm">
                          {isReturn && saved.qty ? (
                            t('purchasing.returns.returnedQty', {
                              qty: lineQuantity(saved.qty, line),
                            })
                          ) : (
                            <>
                              {vatRegistered
                                ? t('purchasing.returns.creditAmount')
                                : t('purchasing.returns.creditAmountNoVat')}{' '}
                              <Money value={saved.amount} currency={purchase.currency} />
                            </>
                          )}
                        </p>
                      ) : null}
                    </div>
                  )
                })}
                {check.errors.document && submitted ? (
                  <p role="alert" className="text-sm text-destructive">
                    {t(check.errors.document.key)}
                  </p>
                ) : null}
              </section>
            )}

            {document && version !== null ? (
              <dl className="space-y-1.5 rounded-xl bg-muted/50 p-3 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{t('purchasing.totals.subtotal')}</dt>
                  <dd className="tabular-nums">
                    <Money value={document.netTotal} currency={document.currency} />
                  </dd>
                </div>
                {context?.capabilities.vat_registered ? (
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">{t('purchasing.totals.vat')}</dt>
                    <dd className="tabular-nums">
                      <Money value={document.vatTotal} currency={document.currency} />
                    </dd>
                  </div>
                ) : null}
                <div className="flex justify-between gap-4 font-semibold">
                  <dt>{t('purchasing.totals.total')}</dt>
                  <dd className="tabular-nums">
                    <Money value={document.total} currency={document.currency} />
                  </dd>
                </div>
              </dl>
            ) : null}

            <TextField
              label={t('purchasing.notes')}
              error={shown(check.errors.notes)}
              render={(a11y) => (
                <Textarea
                  {...a11y}
                  className="[unicode-bidi:plaintext]"
                  rows={2}
                  readOnly={!editable}
                  value={draft.notes}
                  onChange={(event) => setDraft((d) => ({ ...d, notes: event.target.value }))}
                />
              )}
            />
            {editable && version !== null ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => {
                  setConfirmError(null)
                  setConfirm('discard')
                }}
              >
                <Trash2Icon aria-hidden />
                {t('purchasing.editor.discard')}
              </Button>
            ) : null}
          </SheetBody>
          <SheetFooter className={editable && canPost ? 'grid-cols-3' : undefined}>
            <Button type="button" variant="outline" disabled={busy !== null} onClick={onClose}>
              {editable ? t('actions.cancel') : t('actions.close')}
            </Button>
            {editable ? (
              canPost ? (
                <>
                  <Button type="submit" variant="outline" disabled={busy !== null}>
                    {busy === 'saving' ? t('status.saving') : t('purchasing.editor.saveDraft')}
                  </Button>
                  <Button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => {
                      if (!ready()) return
                      if (closed) {
                        setFinalizeBlocked(true)
                        setTimeout(() =>
                          form.current?.querySelector<HTMLElement>('input[type="date"]')?.focus(),
                        )
                        return
                      }
                      setFinalizeBlocked(false)
                      setConfirmError(null)
                      setConfirm('finalize')
                    }}
                  >
                    <CheckCheckIcon aria-hidden />
                    {t('purchasing.editor.finalize')}
                  </Button>
                </>
              ) : (
                <Button type="submit" disabled={busy !== null}>
                  {busy === 'saving' ? t('status.saving') : t('purchasing.editor.saveDraft')}
                </Button>
              )
            ) : status === 'posted' && canReverse ? (
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  setConfirmError(null)
                  setConfirm('reverse')
                }}
              >
                <Undo2Icon aria-hidden />
                {t('purchasing.view.reverse')}
              </Button>
            ) : null}
          </SheetFooter>
        </form>
      </SheetContent>
      <ConfirmDialog
        open={confirm === 'finalize'}
        icon={CheckCheckIcon}
        title={
          isReturn
            ? t('purchasing.returns.confirmReturnTitle')
            : t('purchasing.returns.confirmCreditTitle')
        }
        body={confirmBody}
        note={t('purchasing.returns.confirmNote')}
        action={t('purchasing.confirm.finalizeAction')}
        busyLabel={t('purchasing.confirm.finalizing')}
        busy={busy === 'finalizing'}
        error={confirmError}
        onConfirm={() => void finalize()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'reverse'}
        icon={Undo2Icon}
        title={
          isReturn
            ? t('purchasing.returns.reverseReturnTitle')
            : t('purchasing.returns.reverseCreditTitle')
        }
        body={t('purchasing.returns.reverseBody', { names })}
        note={t('purchasing.confirm.reverseNote')}
        action={t('purchasing.view.reverse')}
        busyLabel={t('purchasing.confirm.reversing')}
        busy={busy === 'reversing'}
        error={confirmError}
        destructive
        onConfirm={() => void reverseIt()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'discard'}
        icon={Trash2Icon}
        title={t('purchasing.confirm.discardTitle')}
        body={t('purchasing.returns.discardBody')}
        action={t('purchasing.confirm.discardAction')}
        busyLabel={t('status.deleting')}
        busy={busy === 'discarding'}
        error={confirmError}
        destructive
        onConfirm={() => void discardIt()}
        onClose={() => setConfirm(null)}
      />
    </Sheet>
  )
}
