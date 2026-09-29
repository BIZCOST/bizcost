'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import { REJECTION_REASON_MAX_LENGTH, type ExpenseResultDto } from '@bizcost/contracts'
import { expenseActions, isOwedPaymentMethod, newId } from '@bizcost/domain'
import { formatDate, type I18nKey } from '@bizcost/i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftIcon,
  CheckCheckIcon,
  CheckIcon,
  CopyIcon,
  PencilIcon,
  SendIcon,
  Trash2Icon,
  Undo2Icon,
  XIcon,
} from 'lucide-react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { FormAlert } from '@/components/form/form-alert'
import { TextField } from '@/components/form/text-field'
import { isolate } from '@/components/form/use-message'
import { PageContainer } from '@/components/shell/page-container'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Money, useBusinessDate, useMoney } from '@/features/purchasing/amounts'
import { closedFor, nextDay } from '@/features/purchasing/books'
import { ConfirmDialog } from '@/features/purchasing/confirm-dialog'
import { useLocationOptions, useRefreshOwnRecords } from '@/features/purchasing/data'
import { Panel } from '@/features/purchasing/panel'
import { PaymentsPanel } from '@/features/purchasing/payments-panel'
import { Receipts } from '@/features/purchasing/receipts'
import { Totals } from '@/features/purchasing/totals'
import { can } from '@/features/settings/sections'
import { useLocale } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { mayReviewExpenses } from './data'
import { ExpenseStatusBadge } from './status-badge'

// An expense as it was recorded (M2 Step 5; D-164, D-166, D-168): one sent for approval, approved,
// final or reversed, or a draft for a member who may not edit it. Its details, amounts, who sent,
// approved or rejected it, its payments (on credit or paid by an employee) and its receipts. The
// actions are the domain's (expenseActions: the approval rules) that the member's keys allow: send
// for approval, approve, reject (with an optional reason), finalize, reverse and correct, discard.
// Every action asks first, saying in plain words what it changes. A member who may not see supplier
// prices changes only what they entered, and only while it is a draft or rejected (D-184). A draft that nobody sends for
// approval (approval off) says it waits for someone who may finalize it, to a member who may not
// (D-180); a final expense the member paid themselves leads to what the business owes them (D-181).

type Confirm = 'submit' | 'approve' | 'reject' | 'finalize' | 'reverse' | 'correct' | 'discard'

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium break-words">{children}</dd>
    </div>
  )
}

export function ExpenseView({
  result,
  mine,
  paidByMe = false,
  onEdit,
  today,
  closedThrough,
}: {
  result: ExpenseResultDto
  /** Whether the member entered it (unknown: undefined). */
  mine?: boolean
  /** Whether the member paid it from their own money. */
  paidByMe?: boolean
  /** Opens it in the editor (a rejected expense someone else entered, for a member who may fix it). */
  onEdit?: () => void
  today: string
  closedThrough: string | null
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const router = useRouter()
  const queryClient = useQueryClient()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const { locale } = useLocale()
  const { businessId } = useParams<{ businessId: string }>()
  const { data: context } = useBusinessContext()
  const expense = result.data
  const locationOptions = useLocationOptions(context)
  const submit = useMutation(trpc.expense.submit.mutationOptions())
  const approve = useMutation(trpc.expense.approve.mutationOptions())
  const reject = useMutation(trpc.expense.reject.mutationOptions())
  const post = useMutation(trpc.expense.post.mutationOptions())
  const reverse = useMutation(trpc.expense.reverse.mutationOptions())
  const correct = useMutation(trpc.expense.correct.mutationOptions())
  const discard = useMutation(trpc.expense.discard.mutationOptions())
  const refreshOwn = useRefreshOwnRecords()
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [confirmError, setConfirmError] = useState<I18nKey | null>(null)
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState('')
  const [correctionId] = useState(() => newId())
  // What is owed on it and its payments, for a final expense on credit or paid by a member.
  const showsPayments =
    context !== undefined &&
    (expense.status === 'posted' || expense.status === 'reversed') &&
    isOwedPaymentMethod(expense.paymentMethod) &&
    can(context, 'expenses.payments.view')
  const payments = useQuery({
    ...trpc.expensePayment.list.queryOptions({ expenseId: expense.id }),
    enabled: showsPayments,
  })
  if (!context) return null

  const vatRegistered = context.capabilities.vat_registered === true
  const canManage = can(context, 'expenses.documents.manage')
  const canPost = can(context, 'expenses.documents.post')
  // Reviewing needs the amounts visible (D-175): the API refuses the others.
  const mayApprove = mayReviewExpenses(context)
  const hasTeam = context.capabilities.has_team === true
  const inApproval = expense.status === 'submitted' || expense.status === 'approved'
  const canReverse = can(context, 'expenses.documents.reverse')
  // A member who may not see supplier prices changes only what they entered (D-184): never another
  // member's draft, never a correction (the copy carries the amounts). The API refuses the same.
  const seesPrices = context.visibleCategories.includes('supplier_price')
  const mayChange = canManage && (seesPrices || mine === true)
  const listHref = `/b/${businessId}/expenses`
  // What the approval rules allow in this status (D-164), then what this member's keys allow.
  const allowed = new Set(
    expenseActions({
      status: expense.status,
      approvalRequired: expense.approvalRequired,
      mayApprove,
    }),
  )
  const offers = {
    submit: allowed.has('submit') && mayChange,
    approve: allowed.has('approve') && mayApprove,
    reject: allowed.has('reject') && mayApprove,
    finalize: allowed.has('post') && canPost,
    discard: allowed.has('discard') && mayChange,
  }
  // A final expense is reversed (or corrected) only once its payments that stand are (D-166).
  const standingPayments = (payments.data?.data.payments ?? []).filter(
    (payment) => payment.status === 'recorded',
  )
  const reversible =
    allowed.has('reverse') &&
    // Offered once its payments are read (the API refuses it too: EXPENSE_HAS_PAYMENTS).
    (!showsPayments || payments.data !== undefined) &&
    standingPayments.length === 0
  // The reversal's day (D-137): its own, or the first day after the closed books; a day after today
  // can't be (books closed up to today), so it waits for tomorrow or open books.
  const firstOpen =
    closedThrough && expense.businessDate <= closedThrough ? nextDay(closedThrough) : null
  const reverseBlocked = firstOpen !== null && firstOpen > today
  const reversalDay = reverseBlocked ? null : firstOpen
  const finalizeClosed =
    expense.status !== 'posted' && expense.status !== 'reversed'
      ? closedFor(expense.businessDate, today, closedThrough)
      : null
  const location = locationOptions.locations.find((l) => l.id === expense.locationId)
  const summary = {
    amount: expense.total === undefined ? '' : money(expense.total, expense.currency),
    category: isolate(expense.categoryName),
  }
  const who = (member: { name: string | null } | null) =>
    isolate(member?.name ?? t('expenses.view.someone'))
  /** The day of a moment (sent, approved, rejected), as this device reads it. */
  const dayOf = (at: string | null) =>
    formatDate(locale, at ?? expense.createdAt, { dateStyle: 'medium' })

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.expense.get.queryKey({ id: expense.id }) }),
      queryClient.invalidateQueries({ queryKey: trpc.expense.list.pathKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.expensePayment.list.pathKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.payable.list.pathKey() }),
      refreshOwn(),
    ])
  }

  function errorKey(error: unknown): I18nKey {
    const code = apiErrorCode(error)
    if (code === 'conflict') return 'purchasing.editor.conflict'
    // Closed books refusing a reversal or a correction: say when it can be done.
    if (code === 'books_closed' && (confirm === 'reverse' || confirm === 'correct')) {
      return 'purchasing.confirm.reverseClosed'
    }
    // Posting checks again that the member who paid is still a member (NOT_FOUND otherwise).
    if (code === 'not_found' && confirm === 'finalize' && expense.paidByMemberId !== null) {
      return 'expenses.confirm.payerLeft'
    }
    return apiErrorKey(error)
  }

  function ask(action: Confirm) {
    setConfirmError(null)
    setReason('')
    setConfirm(action)
  }

  /** Runs a confirmed action; true once done (the dialog says what went wrong otherwise). */
  async function run(action: () => Promise<void>): Promise<boolean> {
    setBusy(true)
    setConfirmError(null)
    try {
      await action()
      setConfirm(null)
      return true
    } catch (error) {
      setConfirmError(errorKey(error))
      return false
    } finally {
      setBusy(false)
    }
  }

  /** A change that returns the expense: shown at once, then everything that reads it refreshed. */
  const change = (
    call: () => Promise<ExpenseResultDto>,
    done: I18nKey,
  ): (() => Promise<boolean>) => {
    return () =>
      run(async () => {
        const next = await call()
        queryClient.setQueryData(trpc.expense.get.queryKey({ id: expense.id }), next)
        await refresh()
        toast.success(t(done))
      })
  }
  const version = { id: expense.id, version: expense.version }
  const doSubmit = change(() => submit.mutateAsync(version), 'expenses.confirm.submitted')
  const doApprove = change(() => approve.mutateAsync(version), 'expenses.confirm.approved')
  const doReject = change(
    () => reject.mutateAsync({ ...version, reason: reason.trim() || null }),
    'expenses.confirm.rejected',
  )
  const doFinalize = change(() => post.mutateAsync(version), 'expenses.confirm.finalized')
  const doReverse = change(
    () => reverse.mutateAsync({ id: expense.id }),
    'expenses.confirm.reversed',
  )
  const doCorrect = () =>
    run(async () => {
      const copy = await correct.mutateAsync({ id: expense.id, newId: correctionId })
      queryClient.setQueryData(trpc.expense.get.queryKey({ id: copy.data.id }), copy)
      await refresh()
      toast.success(t('expenses.confirm.corrected'))
      router.push(`${listHref}/${copy.data.id}`)
    })
  const doDiscard = () =>
    run(async () => {
      await discard.mutateAsync(version)
      await refresh()
      toast.success(
        t(
          expense.status === 'rejected'
            ? 'expenses.confirm.discardedRejected'
            : 'expenses.confirm.discarded',
        ),
      )
      router.replace(listHref)
    })

  const title = t('expenses.view.title', { date: businessDate(expense.businessDate) })
  const tooLong = reason.trim().length > REJECTION_REASON_MAX_LENGTH
  const redacted = result.meta.redacted.length > 0

  return (
    <PageContainer>
      <Link
        href={listHref}
        className="-ms-2 -mt-2 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeftIcon aria-hidden className="size-4 rtl:rotate-180" />
        {t('common.nav.expenses')}
      </Link>
      <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
            <ExpenseStatusBadge status={expense.status} />
          </div>
          <p dir="auto" className="mt-1.5 text-muted-foreground">
            {expense.categoryName}
            {expense.description ? ` · ${expense.description}` : null}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {offers.discard ? (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => ask('discard')}
            >
              <Trash2Icon aria-hidden />
              {expense.status === 'rejected'
                ? t('expenses.editor.discardRejected')
                : t('expenses.editor.discard')}
            </Button>
          ) : null}
          {onEdit ? (
            <Button variant="outline" onClick={onEdit}>
              <PencilIcon aria-hidden />
              {t('expenses.view.edit')}
            </Button>
          ) : null}
          {reversible && canReverse && canManage && seesPrices ? (
            <Button variant="outline" onClick={() => ask('correct')}>
              <CopyIcon aria-hidden />
              {t('expenses.view.correct')}
            </Button>
          ) : null}
          {reversible && canReverse ? (
            <Button variant="destructive" onClick={() => ask('reverse')}>
              <Undo2Icon aria-hidden />
              {t('expenses.view.reverse')}
            </Button>
          ) : null}
          {offers.reject ? (
            <Button variant="outline" onClick={() => ask('reject')}>
              <XIcon aria-hidden />
              {t('expenses.view.reject')}
            </Button>
          ) : null}
          {offers.approve ? (
            <Button
              variant={offers.finalize ? 'outline' : 'default'}
              onClick={() => ask('approve')}
            >
              <CheckIcon aria-hidden />
              {t('expenses.view.approve')}
            </Button>
          ) : null}
          {offers.submit && !offers.finalize ? (
            <Button onClick={() => ask('submit')}>
              <SendIcon aria-hidden className="rtl:-scale-x-100" />
              {t('expenses.view.submit')}
            </Button>
          ) : null}
          {offers.finalize ? (
            <Button onClick={() => ask('finalize')}>
              <CheckCheckIcon aria-hidden />
              {expense.status === 'submitted'
                ? t('expenses.view.approveFinalize')
                : t('expenses.view.finalize')}
            </Button>
          ) : null}
        </div>
      </header>

      <div className="space-y-5">
        {expense.status === 'reversed' ? (
          <FormAlert tone="info">
            {t('expenses.view.reversedNote', {
              date: businessDate(expense.reversalDate ?? expense.businessDate),
            })}
          </FormAlert>
        ) : expense.status === 'submitted' ? (
          <FormAlert tone="info">
            {t('expenses.view.submittedNote', {
              date: dayOf(expense.submittedAt),
              name: who(expense.submittedBy),
            })}
          </FormAlert>
        ) : expense.status === 'approved' ? (
          <FormAlert tone="success">
            {t('expenses.view.approvedNote', {
              date: dayOf(expense.approvedAt),
              name: who(expense.approvedBy),
            })}
          </FormAlert>
        ) : expense.status === 'rejected' ? (
          <FormAlert tone="error">
            {t('expenses.view.rejectedNote', {
              date: dayOf(expense.rejectedAt),
              name: who(expense.rejectedBy),
            })}
            {expense.rejectionReason ? (
              <span className="mt-1 block [unicode-bidi:plaintext]">
                {t('expenses.view.rejectedReason', { reason: expense.rejectionReason })}
              </span>
            ) : null}
            {mine === false && expense.createdBy.name ? (
              <span className="mt-1 block">
                {t('expenses.view.rejectedBackTo', { name: isolate(expense.createdBy.name) })}
              </span>
            ) : null}
          </FormAlert>
        ) : expense.status === 'draft' ? (
          <FormAlert tone="info">
            {!expense.approvalRequired && !canPost
              ? t('expenses.view.draftWaits')
              : redacted && canManage
                ? t('expenses.view.draftLocked')
                : t('expenses.view.draftNote')}
          </FormAlert>
        ) : null}
        {paidByMe &&
        expense.status === 'posted' &&
        expense.paymentMethod === 'paid_by_member' &&
        !showsPayments ? (
          <FormAlert tone="info">
            {t('expenses.view.paidByYou')}{' '}
            <Link
              href={`/b/${businessId}/payables?to=me`}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {t('expenses.view.owedToYouLink')}
            </Link>
          </FormAlert>
        ) : null}
        {expense.copiedFromId ? (
          <FormAlert tone="info">
            {t('expenses.editor.copiedFrom')}{' '}
            <Link
              href={`${listHref}/${expense.copiedFromId}`}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {t('expenses.editor.openOriginal')}
            </Link>
          </FormAlert>
        ) : null}
        {redacted ? (
          <p className="text-sm text-muted-foreground">{t('common.locked.note')}</p>
        ) : null}

        <Panel title={t('expenses.editor.expense')}>
          <dl className="grid grid-cols-2 gap-4 lg:grid-cols-3">
            <Detail label={t('expenses.editor.category')}>
              <bdi>{expense.categoryName}</bdi>
            </Detail>
            <Detail label={t('purchasing.editor.date')}>
              {businessDate(expense.businessDate)}
            </Detail>
            <Detail label={t('purchasing.editor.documentType')}>
              {t(`purchasing.documentTypes.${expense.documentType}`)}
            </Detail>
            <Detail label={t('purchasing.editor.payment')}>
              {t(`purchasing.paymentMethods.${expense.paymentMethod}`)}
            </Detail>
            {expense.paymentMethod === 'paid_by_member' ? (
              <Detail label={t('purchasing.editor.payer')}>
                <bdi>{expense.paidByMemberName ?? t('expenses.view.someone')}</bdi>
              </Detail>
            ) : null}
            <Detail label={t('expenses.editor.supplier')}>
              <bdi>{expense.supplierName ?? t('purchasing.noSupplier')}</bdi>
            </Detail>
            {expense.description ? (
              <Detail label={t('expenses.editor.description')}>
                <bdi>{expense.description}</bdi>
              </Detail>
            ) : null}
            {expense.reference ? (
              <Detail label={t('purchasing.editor.reference')}>
                <bdi>{expense.reference}</bdi>
              </Detail>
            ) : null}
            {vatRegistered ? (
              <Detail label={t('purchasing.editor.vatModeAmount.label')}>
                {expense.pricesIncludeVat
                  ? t('expenses.view.amountIncluded')
                  : t('expenses.view.amountBefore')}
              </Detail>
            ) : null}
            {location && context.capabilities.multi_location ? (
              <Detail label={t('purchasing.editor.location')}>
                <bdi>{location.name}</bdi>
              </Detail>
            ) : null}
            {/* Who entered or approved it: only in a business with a team (as the list). */}
            {hasTeam ? (
              <Detail label={t('expenses.view.enteredBy')}>
                <bdi>{expense.createdBy.name ?? t('expenses.view.someone')}</bdi>
              </Detail>
            ) : null}
            {hasTeam && expense.status === 'posted' && expense.approvedBy ? (
              <Detail label={t('expenses.view.approvedBy')}>
                <bdi>{expense.approvedBy.name ?? t('expenses.view.someone')}</bdi>
              </Detail>
            ) : null}
          </dl>
          {expense.notes ? (
            <p dir="auto" className="mt-4 text-sm whitespace-pre-line">
              {expense.notes}
            </p>
          ) : null}
        </Panel>

        <Panel title={t('expenses.view.amount')}>
          <Totals
            subtotal={expense.netTotal}
            discount="0"
            net={expense.netTotal}
            vat={expense.vatTotal}
            total={expense.total}
            vatRegistered={vatRegistered}
            money={(amount) => money(amount, expense.currency)}
          />
          {expense.costTotal !== null && expense.status !== 'draft' ? (
            <p className="mt-3 border-t pt-3 text-sm">
              {t('expenses.view.costTotal')}{' '}
              <Money
                value={expense.costTotal}
                currency={expense.currency}
                className="font-medium"
              />
            </p>
          ) : null}
          {expense.vatInCost !== null && vatRegistered ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {expense.vatInCost ? t('expenses.view.vatInCost') : t('expenses.view.vatOutOfCost')}
            </p>
          ) : null}
        </Panel>

        {showsPayments && payments.data ? (
          <PaymentsPanel
            document={{ kind: 'expense', id: expense.id, businessDate: expense.businessDate }}
            owed={payments.data.data}
            today={today}
            closedThrough={closedThrough}
            canRecord={
              can(context, 'expenses.payments.record') &&
              context.visibleCategories.includes('supplier_price')
            }
          />
        ) : null}
        {expense.status === 'posted' && standingPayments.length > 0 && canReverse ? (
          <p data-reverse-payments-first className="text-sm text-muted-foreground">
            {t('expenses.view.reverseFirst')}
          </p>
        ) : null}

        <Panel title={t('expenses.editor.receipt')} hint={t('expenses.editor.receiptHint')}>
          {/* Frozen while it is reviewed, receipts included (D-176). */}
          <Receipts
            entity="expense"
            recordId={expense.id}
            canManage={
              !inApproval &&
              (seesPrices
                ? canManage
                : mayChange && (expense.status === 'draft' || expense.status === 'rejected'))
            }
          />
        </Panel>
      </div>

      <ConfirmDialog
        open={confirm === 'submit'}
        icon={SendIcon}
        title={t('expenses.confirm.submitTitle')}
        body={t('expenses.confirm.submitBody', summary)}
        note={t('expenses.confirm.submitNote')}
        action={t('expenses.confirm.submitAction')}
        busyLabel={t('expenses.confirm.submitting')}
        busy={busy}
        error={confirmError}
        onConfirm={() => void doSubmit()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'approve'}
        icon={CheckIcon}
        title={t('expenses.confirm.approveTitle')}
        body={t('expenses.confirm.approveBody', summary)}
        action={t('expenses.confirm.approveAction')}
        busyLabel={t('expenses.confirm.approving')}
        busy={busy}
        error={confirmError}
        onConfirm={() => void doApprove()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'reject'}
        icon={XIcon}
        title={t('expenses.confirm.rejectTitle')}
        body={
          expense.createdBy.name
            ? t('expenses.confirm.rejectBody', { name: isolate(expense.createdBy.name) })
            : t('expenses.confirm.rejectBodyFormer')
        }
        action={t('expenses.confirm.rejectAction')}
        busyLabel={t('expenses.confirm.rejecting')}
        busy={busy}
        error={confirmError}
        disabled={tooLong}
        destructive
        onConfirm={() => void doReject()}
        onClose={() => setConfirm(null)}
      >
        <TextField
          label={t('expenses.confirm.rejectReason')}
          error={
            tooLong ? t('purchasing.tooLong', { count: REJECTION_REASON_MAX_LENGTH }) : undefined
          }
          hint={(id) => (
            <p id={id} className="text-sm text-muted-foreground">
              {t('expenses.confirm.rejectReasonHint')}
            </p>
          )}
          render={(a11y) => (
            <Textarea
              {...a11y}
              className="[unicode-bidi:plaintext]"
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        />
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'finalize'}
        icon={CheckCheckIcon}
        title={t('expenses.confirm.finalizeTitle')}
        body={t('expenses.confirm.finalizeBody', summary)}
        note={
          <>
            {expense.approvalRequired && expense.status !== 'approved' ? (
              <>{t('expenses.confirm.finalizeApproveNote')} </>
            ) : null}
            {t('expenses.confirm.finalizeNote')}
          </>
        }
        action={t('expenses.confirm.finalizeAction')}
        busyLabel={t('expenses.confirm.finalizing')}
        busy={busy}
        error={
          confirmError ??
          (finalizeClosed === 'today'
            ? 'purchasing.confirm.finalizeClosedToday'
            : finalizeClosed === 'earlier'
              ? 'errors.books_closed'
              : null)
        }
        disabled={finalizeClosed !== null}
        onConfirm={() => void doFinalize()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'reverse'}
        icon={Undo2Icon}
        title={t('expenses.confirm.reverseTitle')}
        body={t('expenses.confirm.reverseBody', summary)}
        note={
          <>
            {t('expenses.confirm.reverseNote')}
            {reversalDay ? (
              <> {t('purchasing.confirm.reverseDated', { date: businessDate(reversalDay) })}</>
            ) : null}
          </>
        }
        action={t('expenses.view.reverse')}
        busyLabel={t('expenses.confirm.reversing')}
        busy={busy}
        error={confirmError ?? (reverseBlocked ? 'purchasing.confirm.reverseClosed' : null)}
        disabled={reverseBlocked}
        destructive
        onConfirm={() => void doReverse()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'correct'}
        icon={CopyIcon}
        title={t('expenses.confirm.correctTitle')}
        body={t('expenses.confirm.correctBody')}
        note={
          reversalDay
            ? t('purchasing.confirm.reverseDated', { date: businessDate(reversalDay) })
            : undefined
        }
        action={t('expenses.confirm.correctAction')}
        busyLabel={t('expenses.confirm.correcting')}
        busy={busy}
        error={confirmError ?? (reverseBlocked ? 'purchasing.confirm.reverseClosed' : null)}
        disabled={reverseBlocked}
        onConfirm={() => void doCorrect()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'discard'}
        icon={Trash2Icon}
        title={
          expense.status === 'rejected'
            ? t('expenses.confirm.discardRejectedTitle')
            : t('expenses.confirm.discardTitle')
        }
        body={
          expense.status === 'rejected'
            ? t('expenses.confirm.discardRejectedBody')
            : t('expenses.confirm.discardBody')
        }
        action={t('expenses.confirm.discardAction')}
        busyLabel={t('status.deleting')}
        busy={busy}
        error={confirmError}
        destructive
        onConfirm={() => void doDiscard()}
        onClose={() => setConfirm(null)}
      />
    </PageContainer>
  )
}
