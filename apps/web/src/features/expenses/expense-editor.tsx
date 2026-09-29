'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { ExpenseDto, ExpenseResultDto, SupplierDto } from '@bizcost/contracts'
import {
  isOwedPaymentMethod,
  newId,
  PAYMENT_METHODS,
  PURCHASE_DOCUMENT_TYPES,
  type CurrencyCode,
  type PaymentMethod,
  type PurchaseDocumentType,
} from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftIcon, CheckCheckIcon, SendIcon, Trash2Icon } from 'lucide-react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { Required } from '@/components/form/required'
import { TextField } from '@/components/form/text-field'
import { sameData } from '@/components/form/unsaved'
import { useBeforeNavigate, useUnsavedChanges } from '@/components/form/unsaved-changes'
import { isolate } from '@/components/form/use-message'
import { PageContainer } from '@/components/shell/page-container'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { FieldError } from '@/features/catalog/numbers'
import { useBusinessDate, useMoney } from '@/features/purchasing/amounts'
import { closedFor, firstOpenDay } from '@/features/purchasing/books'
import { ConfirmDialog } from '@/features/purchasing/confirm-dialog'
import {
  hasModule,
  useLocationOptions,
  useRefreshOwnRecords,
  useSupplierOptions,
} from '@/features/purchasing/data'
import { Panel } from '@/features/purchasing/panel'
import { MoneyInput, VatModeChoice, VatSelect } from '@/features/purchasing/purchase-lines'
import {
  PendingReceipts,
  ReceiptError,
  Receipts,
  useUploadReceipt,
} from '@/features/purchasing/receipts'
import { SupplierSheet } from '@/features/purchasing/supplier-sheet'
import { Totals } from '@/features/purchasing/totals'
import { can } from '@/features/settings/sections'
import { useBusinessContext } from '@/lib/trpc/client'
import { CategoryField } from './category-field'
import {
  canManageCategories,
  mayReviewExpenses,
  useCategoryOptions,
  useExpenseSettings,
} from './data'
import {
  checkExpense,
  EXPENSE_MISSING,
  expenseDraft,
  withDocumentType,
  type ExpenseDraft,
  type ExpenseFields,
} from './expense-draft'
import { ExpenseStatusBadge } from './status-badge'

// Enter an expense (M2 Step 5; D-114, D-157, D-159, D-164, D-168): a new one, a saved draft, or one
// that was rejected. Quick on a phone: the amount first (before VAT or with it, for a VAT-registered
// business), its category, the day, the document it came with, how it was paid (required: on credit
// needs the supplier, paid by an employee names who), what it was for and a photo of the receipt;
// the rest under "More details". "Save draft" keeps it without counting it. With approval on (a team
// and the business's setting), a member who may not approve sends it for approval; otherwise
// "Finalize" (expenses.documents.post) saves and posts it after a confirmation; with approval off, a
// member who may not finalize saves a draft that waits for someone who may, and is told so (D-180).
// A member who may not see supplier prices still works on their own expense with its amounts
// (expense.getMine, D-181). Leaving with changes not saved asks first (D-161).

const NEW_SUPPLIER = '__new-supplier__'

export function ExpenseEditor({
  expense,
  mine = true,
  today,
  closedThrough,
}: {
  /** Absent: a new expense. A draft or a rejected expense otherwise. */
  expense?: ExpenseDto
  /** Whether the member entered it (a rejected expense says what to do by who is reading). */
  mine?: boolean
  /** Today in the business's time zone (books.get). */
  today: string
  /** The books-closed date (books.get): said next to the date before Finalize (D-143). */
  closedThrough: string | null
}) {
  const { t } = useTranslation()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  const beforeNavigate = useBeforeNavigate()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const settings = useExpenseSettings(context)
  const vatRegistered = context?.capabilities.vat_registered === true
  const canPost = context ? can(context, 'expenses.documents.post') : false
  const mayApprove = context ? mayReviewExpenses(context) : false
  const approvalRequired = settings.data?.approvalRequired ?? expense?.approvalRequired
  // With approval on, only a member who may approve (and sees what they approve, D-175) finalizes a
  // draft (their approval goes with it, D-164); anyone else sends it for approval. Neither is offered
  // until the setting is known.
  const finalizeOffered =
    approvalRequired !== undefined && canPost && (!approvalRequired || mayApprove)
  const submitOffered = approvalRequired === true && !finalizeOffered
  // Approval off and no right to finalize: the draft waits for someone who may (D-180).
  const waitsForPoster = approvalRequired === false && !canPost
  const canAddSupplier =
    context !== undefined &&
    hasModule(context, 'suppliers') &&
    can(context, 'suppliers.items.manage')
  const supplierOptions = useSupplierOptions(context)
  const locationOptions = useLocationOptions(context)
  const categoryOptions = useCategoryOptions()
  const payers = useQuery({ ...trpc.expense.payers.queryOptions(), staleTime: 60_000 })
  const upload = useUploadReceipt('expense')
  const create = useMutation(trpc.expense.create.mutationOptions())
  const update = useMutation(trpc.expense.update.mutationOptions())
  const post = useMutation(trpc.expense.post.mutationOptions())
  const submit = useMutation(trpc.expense.submit.mutationOptions())
  const discard = useMutation(trpc.expense.discard.mutationOptions())
  const refreshOwn = useRefreshOwnRecords()

  const [expenseId] = useState(() => expense?.id ?? newId())
  // The saved version (null until the first save of a new expense).
  const [version, setVersion] = useState<number | null>(expense?.version ?? null)
  // Still the rejected expense it was opened as (its first save makes it a draft again, D-164).
  const rejected = expense?.status === 'rejected' && version === expense.version
  const [initial] = useState<ExpenseDraft>(() => expenseDraft(expense, { today, vatRegistered }))
  const [draft, setDraft] = useState<ExpenseDraft>(initial)
  // What was last saved (or opened): changes since are asked about before leaving.
  const [baseline, setBaseline] = useState<ExpenseDraft>(initial)
  // A saved expense keeps its choice; a new one follows the document type until the person chooses.
  const [vatModeChosen, setVatModeChosen] = useState(expense !== undefined)
  const [pending, setPending] = useState<File[]>([])
  const [submitted, setSubmitted] = useState(false)
  const [serverError, setServerError] = useState<I18nKey | null>(null)
  const [confirm, setConfirm] = useState<'finalize' | 'submit' | 'discard' | null>(null)
  const [confirmError, setConfirmError] = useState<I18nKey | null>(null)
  const [busy, setBusy] = useState<'saving' | 'finalizing' | 'submitting' | 'discarding' | null>(
    null,
  )
  const [addingSupplier, setAddingSupplier] = useState(false)
  // Finalize was tapped while the closed books stop it: said at the top too.
  const [finalizeBlocked, setFinalizeBlocked] = useState(false)
  const form = useRef<HTMLFormElement>(null)

  const payerItems = payers.data?.items
  const payerIds = useMemo(
    () => (payerItems ? new Set(payerItems.map((payer) => payer.memberId)) : undefined),
    [payerItems],
  )
  const me = payerItems?.find((payer) => payer.isMe)
  // An archived category stays only on the expense that already had it (D-167).
  const savedCategoryId = expense?.categoryId ?? ''
  const categoryIds = useMemo(
    () =>
      categoryOptions.ready
        ? new Set(
            categoryOptions.categories
              .filter((c) => c.archivedAt === null || c.id === savedCategoryId)
              .map((c) => c.id),
          )
        : undefined,
    [categoryOptions.ready, categoryOptions.categories, savedCategoryId],
  )

  const currency = (expense?.currency ?? context?.currency ?? 'AED') as CurrencyCode
  const check = useMemo(
    () =>
      checkExpense(draft, {
        currency,
        vatRegistered,
        today,
        categories: categoryIds,
        payers: payerIds,
      }),
    [draft, currency, vatRegistered, today, categoryIds, payerIds],
  )
  const shown = (error: FieldError | undefined): string | undefined =>
    error && (submitted || !EXPENSE_MISSING.has(error.key)) ? t(error.key, error.values) : undefined
  const supplierNeeded =
    check.errors.paymentMethod?.key === 'purchasing.editor.errors.paymentMethodSupplier' &&
    shown(check.errors.paymentMethod) !== undefined
  const listHref = `/b/${businessId}/expenses`
  // The books-closed date stops finalizing on this date (D-114 rule 6): said under the date at once
  // to a member who may finalize.
  const closed = finalizeOffered ? closedFor(draft.businessDate, today, closedThrough) : null
  const closedNote =
    closed && closedThrough
      ? t(
          closed === 'today' ? 'purchasing.editor.closedToday' : 'purchasing.editor.closedEarlier',
          { date: businessDate(closedThrough) },
        )
      : null
  const pickableSuppliers = supplierOptions.suppliers.filter(
    (supplier) => supplier.archivedAt === null || supplier.id === draft.supplierId,
  )
  const categoryName =
    categoryOptions.categories.find((c) => c.id === draft.categoryId)?.name ??
    expense?.categoryName ??
    ''

  const set = (patch: Partial<ExpenseDraft>) => setDraft((d) => ({ ...d, ...patch }))

  // Paid by a member: the one entering it, until someone else is picked.
  const meId = me?.memberId
  useEffect(() => {
    if (draft.paymentMethod === 'paid_by_member' && draft.paidByMemberId === '' && meId) {
      setDraft((d) => ({ ...d, paidByMemberId: meId }))
    }
  }, [draft.paymentMethod, draft.paidByMemberId, meId])

  function setDocumentType(documentType: PurchaseDocumentType) {
    setDraft((d) => withDocumentType(d, documentType, { vatRegistered, vatModeChosen }))
  }

  function setPaymentMethod(paymentMethod: PaymentMethod | '') {
    set({
      paymentMethod,
      paidByMemberId:
        paymentMethod === 'paid_by_member' ? draft.paidByMemberId || (meId ?? '') : '',
    })
  }

  // The first field to fix, in the middle of the screen (its label too, not under the top bar).
  const focusFirstError = () =>
    setTimeout(() => {
      const field = form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
      field?.focus({ preventScroll: true })
      field?.scrollIntoView({ block: 'center' })
    })

  /** Creates or updates the expense, then attaches the receipts picked before its first save. */
  async function save(fields: ExpenseFields): Promise<ExpenseResultDto> {
    const snapshot = draft
    const result =
      version === null
        ? await create.mutateAsync({ id: expenseId, ...fields })
        : await update.mutateAsync({ id: expenseId, version, ...fields })
    setVersion(result.data.version)
    setBaseline(snapshot)
    queryClient.setQueryData(trpc.expense.get.queryKey({ id: expenseId }), result)
    if (pending.length > 0) {
      const files = pending
      setPending([])
      for (const file of files) {
        try {
          await upload(expenseId, file)
        } catch (caught) {
          toast.error(
            t(caught instanceof ReceiptError ? caught.key : 'errors.internal') + ` (${file.name})`,
          )
        }
      }
    }
    void queryClient.invalidateQueries({ queryKey: trpc.expense.list.pathKey() })
    void refreshOwn()
    return result
  }

  function errorKey(error: unknown): I18nKey {
    const code = apiErrorCode(error)
    if (code === 'conflict') return 'purchasing.editor.conflict'
    // Posting checks again that the member who paid is still a member (NOT_FOUND otherwise).
    if (
      code === 'not_found' &&
      confirm === 'finalize' &&
      draft.paymentMethod === 'paid_by_member'
    ) {
      return 'expenses.confirm.payerLeft'
    }
    return apiErrorKey(error)
  }

  /** Checks the form; true when it can be saved (else the first field to fix gets the focus). */
  function ready(): boolean {
    setSubmitted(true)
    setServerError(null)
    if (!check.fields) {
      focusFirstError()
      return false
    }
    return true
  }

  /** Saves the draft where it is; true once saved (the form says what went wrong otherwise). */
  async function saveHere(): Promise<boolean> {
    if (busy || !ready()) return false
    setBusy('saving')
    try {
      await save(check.fields!)
      toast.success(t('expenses.editor.saved'))
      return true
    } catch (error) {
      setServerError(errorKey(error))
      return false
    } finally {
      setBusy(null)
    }
  }

  // Leaving with changes asks first (Save saves the draft, then leaves).
  const dirty = !sameData(draft, baseline) || pending.length > 0
  useUnsavedChanges({ dirty, save: saveHere })

  /** A new expense, once saved, opens at its own address (in place of the new-expense page). */
  async function openSaved() {
    await beforeNavigate()
    router.replace(`${listHref}/${expenseId}`)
  }

  async function saveDraft(event: FormEvent) {
    event.preventDefault()
    const isNew = version === null
    if (!(await saveHere())) return
    if (isNew) await openSaved()
  }

  function askFinalize() {
    if (busy || !ready()) return
    if (closed) {
      setFinalizeBlocked(true)
      setTimeout(() => form.current?.querySelector<HTMLElement>('input[type="date"]')?.focus())
      return
    }
    setFinalizeBlocked(false)
    setConfirmError(null)
    setConfirm('finalize')
  }

  function askSubmit() {
    if (busy || !ready()) return
    setConfirmError(null)
    setConfirm('submit')
  }

  /** Saves, then finalizes or sends for approval (`action`). */
  async function saveAnd(action: 'finalize' | 'submit') {
    if (!check.fields) return
    setBusy(action === 'finalize' ? 'finalizing' : 'submitting')
    setConfirmError(null)
    const isNew = version === null
    let saved: ExpenseResultDto | null = null
    try {
      saved = await save(check.fields)
      const next =
        action === 'finalize'
          ? await post.mutateAsync({ id: expenseId, version: saved.data.version })
          : await submit.mutateAsync({ id: expenseId, version: saved.data.version })
      queryClient.setQueryData(trpc.expense.get.queryKey({ id: expenseId }), next)
      void queryClient.invalidateQueries({ queryKey: trpc.expense.list.pathKey() })
      void queryClient.invalidateQueries({ queryKey: trpc.payable.list.pathKey() })
      void refreshOwn()
      toast.success(
        t(action === 'finalize' ? 'expenses.confirm.finalized' : 'expenses.confirm.submitted'),
      )
      setConfirm(null)
      if (isNew) await openSaved()
    } catch (error) {
      if (isNew && saved) {
        // Saved as a draft, then the next step failed: the draft's own page from now on, with the
        // problem said there (this page and its dialog go away).
        toast.error(
          t(
            action === 'finalize'
              ? 'expenses.editor.savedNotFinalized'
              : 'expenses.editor.savedNotSent',
            { reason: t(errorKey(error)) },
          ),
        )
        setConfirm(null)
        await openSaved()
      } else setConfirmError(errorKey(error))
    } finally {
      setBusy(null)
    }
  }

  async function discardDraft() {
    if (version === null) return
    setBusy('discarding')
    setConfirmError(null)
    try {
      await discard.mutateAsync({ id: expenseId, version })
      setBaseline(draft)
      setPending([])
      void queryClient.invalidateQueries({ queryKey: trpc.expense.list.pathKey() })
      void refreshOwn()
      toast.success(
        t(rejected ? 'expenses.confirm.discardedRejected' : 'expenses.confirm.discarded'),
      )
      await beforeNavigate()
      router.replace(listHref)
    } catch (error) {
      setConfirmError(errorKey(error))
      setBusy(null)
    }
  }

  function pickSupplier(value: string) {
    if (value === NEW_SUPPLIER) setAddingSupplier(true)
    else set({ supplierId: value })
  }

  const hasShownErrors = submitted && check.fields === null
  // The one who paid, when they have left the business since (a draft saved before).
  const leftPayer =
    draft.paymentMethod === 'paid_by_member' &&
    draft.paidByMemberId !== '' &&
    payerIds !== undefined &&
    !payerIds.has(draft.paidByMemberId)
      ? draft.paidByMemberId
      : null
  const includesVat = vatRegistered && draft.pricesIncludeVat
  const confirmSummary = {
    amount: money(check.amounts.total, currency),
    category: isolate(categoryName),
  }

  if (!context) return null
  return (
    <PageContainer>
      <Link
        href={listHref}
        className="-ms-2 -mt-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
        {t('common.nav.expenses')}
      </Link>
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {version === null
                ? t('expenses.editor.newTitle')
                : rejected
                  ? t('expenses.editor.rejectedTitle')
                  : t('expenses.editor.draftTitle')}
            </h1>
            {version === null ? null : (
              <ExpenseStatusBadge status={rejected ? 'rejected' : 'draft'} />
            )}
          </div>
          <p className="mt-1.5 max-w-2xl text-muted-foreground">
            {submitOffered
              ? t('expenses.editor.introApproval')
              : waitsForPoster
                ? // Once saved, it says it waits (not "save it" again, D-184).
                  version === null
                  ? t('expenses.editor.introWaits')
                  : t('expenses.view.draftWaits')
                : t('expenses.editor.intro')}
          </p>
        </div>
        {version === null ? null : (
          <Button
            type="button"
            variant="ghost"
            className="self-start text-destructive hover:text-destructive"
            onClick={() => {
              setConfirmError(null)
              setConfirm('discard')
            }}
          >
            <Trash2Icon aria-hidden />
            {rejected ? t('expenses.editor.discardRejected') : t('expenses.editor.discard')}
          </Button>
        )}
      </header>
      {rejected ? (
        <FormAlert tone="error" className="mb-4">
          {expense.rejectedBy?.name
            ? expense.rejectionReason
              ? t('expenses.editor.rejectedByReason', {
                  name: isolate(expense.rejectedBy.name),
                  reason: isolate(expense.rejectionReason),
                })
              : t('expenses.editor.rejectedBy', { name: isolate(expense.rejectedBy.name) })
            : t('expenses.editor.rejectedByFormer')}{' '}
          {/* What to do next, by who is reading: the one who entered it, or someone else (a
              reviewer who opened it to fix it). */}
          {!mine && expense.createdBy.name ? (
            <>
              {t('expenses.editor.rejectedBackTo', { name: isolate(expense.createdBy.name) })}{' '}
              {t(
                finalizeOffered
                  ? 'expenses.editor.rejectedOtherFinalize'
                  : 'expenses.editor.rejectedOtherSend',
              )}
            </>
          ) : (
            t(
              finalizeOffered
                ? 'expenses.editor.rejectedFinalize'
                : 'expenses.editor.rejectedSendAgain',
            )
          )}
        </FormAlert>
      ) : null}
      {expense?.copiedFromId ? (
        <FormAlert tone="info" className="mb-4">
          {t('expenses.editor.copiedFrom')}{' '}
          <Link
            href={`${listHref}/${expense.copiedFromId}`}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {t('expenses.editor.openOriginal')}
          </Link>
        </FormAlert>
      ) : null}

      <form
        ref={form}
        method="post"
        noValidate
        onSubmit={(event) => void saveDraft(event)}
        className="space-y-5"
      >
        {serverError ? <FormAlert tone="error">{t(serverError)}</FormAlert> : null}
        {finalizeBlocked && closedNote ? <FormAlert tone="error">{closedNote}</FormAlert> : null}
        {hasShownErrors && !serverError ? (
          <FormAlert tone="error">{t('catalog.form.fixErrors')}</FormAlert>
        ) : null}

        <Panel title={t('expenses.editor.expense')}>
          {vatRegistered ? (
            <VatModeChoice
              wording="amount"
              value={draft.pricesIncludeVat}
              onChange={(pricesIncludeVat) => {
                setVatModeChosen(true)
                set({ pricesIncludeVat })
              }}
            />
          ) : null}
          <div
            className={
              vatRegistered ? 'grid grid-cols-[minmax(0,1fr)_7rem] items-start gap-3' : undefined
            }
          >
            <TextField
              label={
                <Required>
                  {vatRegistered
                    ? includesVat
                      ? t('expenses.editor.amountInclVat')
                      : t('expenses.editor.amountBeforeVat')
                    : t('expenses.editor.amount')}
                </Required>
              }
              error={shown(check.errors.amount)}
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
            {vatRegistered ? (
              <TextField
                label={t('expenses.editor.vatRate')}
                render={(a11y) => (
                  <VatSelect
                    id={a11y.id}
                    value={draft.vatRate}
                    onChange={(vatRate) => set({ vatRate })}
                  />
                )}
              />
            ) : null}
          </div>
          {vatRegistered ? (
            <div className="mt-4 rounded-xl bg-muted/50 px-4 py-3">
              <Totals
                subtotal={check.amounts.net}
                discount="0"
                net={check.amounts.net}
                vat={check.amounts.vat}
                total={check.amounts.total}
                vatRegistered
                money={(amount) => money(amount, currency)}
              />
            </div>
          ) : null}
          <div className="mt-4 grid gap-4 sm:grid-flow-row-dense sm:grid-cols-2">
            <CategoryField
              value={draft.categoryId}
              onChange={(categoryId) => set({ categoryId })}
              categories={categoryOptions.categories}
              canAdd={canManageCategories(context)}
              error={shown(check.errors.category)}
              onAdded={categoryOptions.add}
            />
            <TextField
              label={t('purchasing.editor.date')}
              type="date"
              min={finalizeOffered ? firstOpenDay(today, closedThrough) : undefined}
              max={today}
              value={draft.businessDate}
              onChange={(event) => set({ businessDate: event.target.value })}
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
              label={t('purchasing.editor.documentType')}
              render={(a11y) => (
                <NativeSelect
                  {...a11y}
                  value={draft.documentType}
                  onChange={(event) => setDocumentType(event.target.value as PurchaseDocumentType)}
                >
                  {PURCHASE_DOCUMENT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(`purchasing.documentTypes.${type}`)}
                    </option>
                  ))}
                </NativeSelect>
              )}
            />
            <TextField
              label={<Required>{t('purchasing.editor.payment')}</Required>}
              error={shown(check.errors.paymentMethod)}
              hint={
                isOwedPaymentMethod(draft.paymentMethod)
                  ? (id) => (
                      <p id={id} className="text-sm text-muted-foreground">
                        {t(
                          draft.paymentMethod === 'supplier_credit'
                            ? 'purchasing.editor.owedToSupplierHint'
                            : 'purchasing.editor.owedToMemberHint',
                        )}
                      </p>
                    )
                  : undefined
              }
              render={(a11y) => (
                <NativeSelect
                  {...a11y}
                  aria-required
                  value={draft.paymentMethod}
                  onChange={(event) => setPaymentMethod(event.target.value as PaymentMethod | '')}
                >
                  <option value="" disabled>
                    {t('purchasing.editor.paymentPick')}
                  </option>
                  {PAYMENT_METHODS.map((method) => (
                    <option key={method} value={method}>
                      {t(`purchasing.paymentMethods.${method}`)}
                    </option>
                  ))}
                </NativeSelect>
              )}
            />
            {draft.paymentMethod === 'paid_by_member' ? (
              // Under how it was paid (which it depends on); the supplier fills the place beside
              // it from 640px (a dense grid).
              <div className="sm:col-start-2">
                <TextField
                  label={<Required>{t('purchasing.editor.payer')}</Required>}
                  render={(a11y) => (
                    <NativeSelect
                      {...a11y}
                      aria-required
                      value={draft.paidByMemberId}
                      onChange={(event) => set({ paidByMemberId: event.target.value })}
                    >
                      <option value="" disabled>
                        {t('purchasing.editor.payerPick')}
                      </option>
                      {leftPayer ? (
                        <option value={leftPayer} disabled>
                          {t('purchasing.editor.payerLeftOption', {
                            name: expense?.paidByMemberName ?? '…',
                          })}
                        </option>
                      ) : null}
                      {(payerItems ?? []).map((payer) => (
                        <option key={payer.memberId} value={payer.memberId}>
                          {payer.isMe
                            ? t('purchasing.editor.payerMe', { name: payer.name })
                            : payer.name}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                />
              </div>
            ) : null}
            <TextField
              label={t('expenses.editor.supplier')}
              hint={(id) => (
                <p id={id} className="text-sm text-muted-foreground">
                  {t('expenses.editor.supplierHint')}
                </p>
              )}
              render={(a11y) => (
                <NativeSelect
                  {...a11y}
                  // On credit without a supplier: the supplier is what to fix (the message is under
                  // how it was paid), so it is marked too.
                  aria-invalid={a11y['aria-invalid'] || supplierNeeded}
                  value={draft.supplierId}
                  onChange={(event) => pickSupplier(event.target.value)}
                  disabled={!supplierOptions.enabled}
                >
                  <option value="">{t('purchasing.noSupplier')}</option>
                  {supplierOptions.enabled ? null : draft.supplierId ? (
                    <option value={draft.supplierId}>{expense?.supplierName ?? '…'}</option>
                  ) : null}
                  {pickableSuppliers.map((supplier) => (
                    <option key={supplier.id} value={supplier.id}>
                      {supplier.name}
                    </option>
                  ))}
                  {canAddSupplier ? (
                    <option value={NEW_SUPPLIER}>{t('purchasing.editor.newSupplier')}</option>
                  ) : null}
                </NativeSelect>
              )}
            />
            <TextField
              label={t('expenses.editor.description')}
              autoComplete="off"
              className="[unicode-bidi:plaintext]"
              placeholder={t('expenses.editor.descriptionPlaceholder')}
              value={draft.description}
              onChange={(event) => set({ description: event.target.value })}
              error={shown(check.errors.description)}
            />
          </div>
          {vatRegistered && draft.documentType === 'tax_invoice' ? (
            <div className="mt-4 flex items-start justify-between gap-4 rounded-xl border bg-background/60 p-4">
              <div className="min-w-0">
                <p id="vat-not-reclaimable" className="text-sm font-medium">
                  {t('purchasing.editor.vatNotReclaimable')}
                </p>
                <p id="vat-not-reclaimable-hint" className="mt-0.5 text-sm text-muted-foreground">
                  {t('expenses.editor.vatNotReclaimableHint')}
                </p>
              </div>
              <Switch
                checked={draft.vatNotReclaimable}
                onCheckedChange={(checked) => set({ vatNotReclaimable: checked })}
                aria-labelledby="vat-not-reclaimable"
                aria-describedby="vat-not-reclaimable-hint"
                className="mt-1"
              />
            </div>
          ) : null}
        </Panel>

        <Panel title={t('expenses.editor.receipt')} hint={t('expenses.editor.receiptHint')}>
          {version === null ? (
            <PendingReceipts files={pending} onChange={setPending} />
          ) : (
            <Receipts entity="expense" recordId={expenseId} canManage />
          )}
        </Panel>

        <Panel title={t('expenses.editor.moreDetails')}>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label={t('purchasing.editor.reference')}
              autoComplete="off"
              className="[unicode-bidi:plaintext]"
              value={draft.reference}
              onChange={(event) => set({ reference: event.target.value })}
              error={shown(check.errors.reference)}
              hint={(id) => (
                <p id={id} className="text-sm text-muted-foreground">
                  {t('purchasing.optional')}
                </p>
              )}
            />
            {locationOptions.enabled ? (
              <TextField
                label={t('purchasing.editor.location')}
                render={(a11y) => (
                  <NativeSelect
                    {...a11y}
                    value={
                      draft.locationId ??
                      locationOptions.locations.find((location) => location.isDefault)?.id ??
                      ''
                    }
                    onChange={(event) => set({ locationId: event.target.value || null })}
                  >
                    {locationOptions.locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name}
                      </option>
                    ))}
                  </NativeSelect>
                )}
              />
            ) : null}
          </div>
          <div className="mt-4">
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
          </div>
        </Panel>

        {/* The total is never cut: when it and the buttons do not fit one row (a phone, a long
            label), the buttons go under it. */}
        <div
          data-expense-actions
          className="sticky bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-10 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-card/95 p-3 shadow-lg ring-1 ring-foreground/10 backdrop-blur md:bottom-4"
        >
          <div className="min-w-fit flex-1">
            <p className="text-xs text-muted-foreground">{t('purchasing.totals.total')}</p>
            <p data-expense-total className="font-semibold whitespace-nowrap tabular-nums">
              {money(check.amounts.total, currency)}
            </p>
          </div>
          <div className="flex grow justify-end gap-2 sm:grow-0">
            <Button type="submit" variant="outline" disabled={busy !== null}>
              {busy === 'saving' ? t('status.saving') : t('expenses.editor.saveDraft')}
            </Button>
            {finalizeOffered ? (
              <Button type="button" disabled={busy !== null} onClick={askFinalize}>
                <CheckCheckIcon aria-hidden />
                {t('expenses.editor.finalize')}
              </Button>
            ) : submitOffered ? (
              <Button type="button" disabled={busy !== null} onClick={askSubmit}>
                <SendIcon aria-hidden className="rtl:-scale-x-100" />
                {t('expenses.editor.submit')}
              </Button>
            ) : null}
          </div>
        </div>
      </form>

      <ConfirmDialog
        open={confirm === 'finalize'}
        icon={CheckCheckIcon}
        title={t('expenses.confirm.finalizeTitle')}
        body={t('expenses.confirm.finalizeBody', confirmSummary)}
        note={
          <>
            {approvalRequired === true ? <>{t('expenses.confirm.finalizeApproveNote')} </> : null}
            {t('expenses.confirm.finalizeNote')}
          </>
        }
        action={t('expenses.confirm.finalizeAction')}
        busyLabel={t('expenses.confirm.finalizing')}
        busy={busy === 'finalizing'}
        error={confirmError}
        onConfirm={() => void saveAnd('finalize')}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'submit'}
        icon={SendIcon}
        title={t('expenses.confirm.submitTitle')}
        body={t('expenses.confirm.submitBody', confirmSummary)}
        note={t('expenses.confirm.submitNote')}
        action={t('expenses.confirm.submitAction')}
        busyLabel={t('expenses.confirm.submitting')}
        busy={busy === 'submitting'}
        error={confirmError}
        onConfirm={() => void saveAnd('submit')}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'discard'}
        icon={Trash2Icon}
        title={
          rejected ? t('expenses.confirm.discardRejectedTitle') : t('expenses.confirm.discardTitle')
        }
        body={
          rejected ? t('expenses.confirm.discardRejectedBody') : t('expenses.confirm.discardBody')
        }
        action={t('expenses.confirm.discardAction')}
        busyLabel={t('status.deleting')}
        busy={busy === 'discarding'}
        error={confirmError}
        destructive
        onConfirm={() => void discardDraft()}
        onClose={() => setConfirm(null)}
      />
      {addingSupplier ? (
        <SupplierSheet
          onClose={() => setAddingSupplier(false)}
          onSaved={(supplier: SupplierDto) => set({ supplierId: supplier.id })}
        />
      ) : null}
    </PageContainer>
  )
}
