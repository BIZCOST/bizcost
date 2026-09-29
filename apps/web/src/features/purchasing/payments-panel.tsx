'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { PurchasePaymentDto } from '@bizcost/contracts'
import { compareDecimal } from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { HandCoinsIcon, Undo2Icon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { isolate } from '@/components/form/use-message'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Money, useBusinessDate, useMoney } from './amounts'
import { ConfirmDialog } from './confirm-dialog'
import { Panel } from './panel'
import { PaymentSheet, type OwedAmounts, type OwedDocument } from './payment-sheet'

// The payments of a purchase (the owner's request of 2026-09-29) or an expense (M2 Step 5, D-166)
// bought on credit or paid by a member: who it is owed to, its total, what returns and credit notes took off, what was paid
// and what is still owed; each payment with its day, how it was paid, who recorded it and its note.
// A payment recorded by mistake is reversed (it stays listed, marked reversed, with who reversed it).
// A return or credit note posted after it was paid can leave it paid beyond what it came to: then the
// last row says how much, in place of "Still owed", and a line says who owes it back (D-162).

/** Whether more was paid than it came to after its returns and credit notes (D-162). */
function isOverpaid(owed: OwedAmounts): boolean {
  return owed.overpaid !== undefined && compareDecimal(owed.overpaid, '0') > 0
}

/** Its total, returns, payments and what is still owed (or what was paid beyond it). */
function Summary({ owed }: { owed: OwedAmounts }) {
  const { t } = useTranslation()
  const rows: { key: string; label: string; value: string | undefined; strong?: boolean }[] = [
    { key: 'total', label: t('purchasing.payments.total'), value: owed.total },
  ]
  if (owed.returned === undefined || compareDecimal(owed.returned, '0') > 0) {
    rows.push({ key: 'returned', label: t('purchasing.payments.returned'), value: owed.returned })
  }
  rows.push({ key: 'paid', label: t('purchasing.payments.paid'), value: owed.paid })
  rows.push(
    isOverpaid(owed)
      ? {
          key: 'overpaid',
          label: t('purchasing.payments.overpaid'),
          value: owed.overpaid,
          strong: true,
        }
      : {
          key: 'outstanding',
          label: t('purchasing.payments.outstanding'),
          value: owed.outstanding,
          strong: true,
        },
  )
  return (
    <dl className="space-y-1.5 text-sm">
      {rows.map((row) => (
        <div
          key={row.key}
          data-owed={row.key}
          className={cn(
            'flex items-baseline justify-between gap-4',
            row.strong && 'border-t pt-2 text-base font-semibold',
          )}
        >
          <dt className={row.strong ? undefined : 'text-muted-foreground'}>{row.label}</dt>
          <dd>
            <Money value={row.value} currency={owed.currency} />
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** "Bought on credit: owed to …" (or an expense on credit), or "Paid by … from their own money". */
const OWED_TO = {
  purchase: {
    supplier: 'purchasing.payments.owedToSupplier',
    member: 'purchasing.payments.owedToMember',
  },
  expense: {
    supplier: 'purchasing.payments.owedToSupplierExpense',
    member: 'purchasing.payments.owedToMember',
  },
} as const

export function PaymentsPanel({
  document,
  owed,
  today,
  closedThrough,
  canRecord,
}: {
  document: OwedDocument
  owed: OwedAmounts
  today: string
  closedThrough: string | null
  /** purchases.payments.record (or expenses.payments.record), with supplier prices visible. */
  canRecord: boolean
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const money = useMoney()
  const businessDate = useBusinessDate()
  const reversePurchase = useMutation(trpc.purchasePayment.reverse.mutationOptions())
  const reverseExpense = useMutation(trpc.expensePayment.reverse.mutationOptions())
  const reversingBusy = reversePurchase.isPending || reverseExpense.isPending
  const [recording, setRecording] = useState(false)
  const [reversing, setReversing] = useState<PurchasePaymentDto | null>(null)
  const [error, setError] = useState<I18nKey | null>(null)
  const owedTo = owed.owedTo
  const outstanding = owed.outstanding
  const canPay =
    canRecord &&
    owed.status === 'posted' &&
    outstanding !== undefined &&
    compareDecimal(outstanding, '0') > 0

  async function doReverse() {
    if (!reversing) return
    setError(null)
    try {
      if (document.kind === 'expense') {
        const result = await reverseExpense.mutateAsync({ id: reversing.id })
        queryClient.setQueryData(
          trpc.expensePayment.list.queryKey({ expenseId: document.id }),
          result,
        )
      } else {
        const result = await reversePurchase.mutateAsync({ id: reversing.id })
        queryClient.setQueryData(
          trpc.purchasePayment.list.queryKey({ purchaseId: document.id }),
          result,
        )
      }
      await queryClient.invalidateQueries({ queryKey: trpc.payable.list.pathKey() })
      toast.success(t('purchasing.payments.reversed'))
      setReversing(null)
    } catch (caught) {
      setError(
        apiErrorCode(caught) === 'books_closed'
          ? 'purchasing.payments.reverseClosed'
          : apiErrorKey(caught),
      )
    }
  }

  return (
    <Panel
      title={t('purchasing.payments.title')}
      hint={
        owedTo ? t(OWED_TO[document.kind][owedTo.party], { name: isolate(owedTo.name) }) : undefined
      }
      action={
        canPay ? (
          <Button variant="outline" onClick={() => setRecording(true)}>
            <HandCoinsIcon aria-hidden />
            {t('purchasing.payments.record')}
          </Button>
        ) : null
      }
    >
      <Summary owed={owed} />
      {isOverpaid(owed) ? (
        <p data-overpaid className="mt-2 text-sm font-medium text-warning">
          {owedTo?.party === 'member'
            ? t('purchasing.payments.overpaidMember', {
                amount: money(owed.overpaid!, owed.currency),
                name: isolate(owedTo.name),
              })
            : t('purchasing.payments.overpaidSupplier', {
                amount: money(owed.overpaid!, owed.currency),
              })}
        </p>
      ) : owed.status === 'posted' &&
        outstanding !== undefined &&
        compareDecimal(outstanding, '0') <= 0 ? (
        <p data-paid-in-full className="mt-2 text-sm text-success">
          {t('purchasing.payments.paidInFull')}
        </p>
      ) : null}
      {owed.payments.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('purchasing.payments.none')}</p>
      ) : (
        <ul aria-label={t('purchasing.payments.title')} className="mt-4 divide-y border-t">
          {owed.payments.map((payment) => {
            const reversed = payment.status === 'reversed'
            return (
              <li
                key={payment.id}
                data-payment
                className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    <Money
                      value={payment.amount}
                      currency={payment.currency}
                      className={cn(reversed && 'text-muted-foreground line-through')}
                    />
                    <span className="text-sm font-normal text-muted-foreground">
                      {t(`purchasing.paymentMethods.${payment.method}`)}
                    </span>
                    {reversed ? (
                      <Badge tone="neutral">{t('purchasing.payments.reversedTag')}</Badge>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {businessDate(payment.businessDate)}
                    {' · '}
                    {payment.recordedBy.name
                      ? t('purchasing.payments.recordedBy', {
                          name: isolate(payment.recordedBy.name),
                        })
                      : t('purchasing.payments.recordedByFormer')}
                  </p>
                  {payment.note ? (
                    <p className="mt-0.5 text-sm whitespace-pre-line [unicode-bidi:plaintext]">
                      {payment.note}
                    </p>
                  ) : null}
                  {reversed ? (
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {t('purchasing.payments.reversedOn', {
                        date: businessDate(payment.reversalDate ?? payment.businessDate),
                        name: isolate(payment.reversedBy?.name ?? '…'),
                      })}
                    </p>
                  ) : null}
                </div>
                {!reversed && canRecord ? (
                  <Button
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => {
                      setError(null)
                      setReversing(payment)
                    }}
                  >
                    <Undo2Icon aria-hidden />
                    {t('purchasing.payments.reverse')}
                  </Button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      <ConfirmDialog
        open={reversing !== null}
        icon={Undo2Icon}
        title={t('purchasing.payments.reverseTitle')}
        body={t('purchasing.payments.reverseBody', {
          amount:
            reversing?.amount === undefined ? '' : money(reversing.amount, reversing.currency),
        })}
        note={t('purchasing.payments.reverseNote')}
        action={t('purchasing.payments.reverse')}
        busyLabel={t('purchasing.confirm.reversing')}
        busy={reversingBusy}
        error={error}
        destructive
        onConfirm={() => void doReverse()}
        onClose={() => setReversing(null)}
      />
      {recording ? (
        <PaymentSheet
          document={document}
          owed={owed}
          today={today}
          closedThrough={closedThrough}
          onClose={() => setRecording(false)}
        />
      ) : null}
    </Panel>
  )
}
