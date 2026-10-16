'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import type { CustomerPaymentDto, OwedDocumentDto } from '@bizcost/contracts'
import { compareDecimal } from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { HandCoinsIcon, Undo2Icon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { isolate } from '@/components/form/use-message'
import { LoadError } from '@/components/states/query-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Money, useBusinessDate, useMoney } from '@/features/documents/amounts'
import { ConfirmDialog } from '@/features/documents/confirm-dialog'
import { Panel } from '@/features/documents/panel'
import { useRefreshOrders } from '@/features/orders/data'
import { useBusinessContext } from '@/lib/trpc/client'
import { cn } from '@/lib/utils'
import { CustomerPaymentSheet, type PaidDocument } from './payment-sheet'

// What an order or a sale "they'll pay later" is paid and owes (M3 Step 5; Q17, D-267; one figure per
// obligation, A2): its total, its refunds, what was paid, money given back, and what is still owed or,
// paid beyond it, "Money back to the customer" (a refund, or a cancelled order's deposit). Each
// payment with its day, how it was paid, who recorded it (with a team only, D-278) and its note; one
// recorded by mistake is reversed (it stays listed, marked reversed). Payments are never edited.

const positive = (value: string) => compareDecimal(value, '0') > 0

/** Its total, refunds, payments, money given back and what is still owed (or paid beyond it). */
export function OwedSummary({ owed }: { owed: OwedDocumentDto }) {
  const { t } = useTranslation()
  const rows: { key: string; label: string; value: string; strong?: boolean }[] = [
    { key: 'total', label: t('orders.payments.total'), value: owed.total },
  ]
  if (positive(owed.credited)) {
    rows.push({ key: 'credited', label: t('orders.payments.credited'), value: owed.credited })
  }
  rows.push({ key: 'paid', label: t('orders.payments.paid'), value: owed.paid })
  if (positive(owed.refunded)) {
    rows.push({ key: 'refunded', label: t('orders.payments.refunded'), value: owed.refunded })
  }
  rows.push(
    positive(owed.overpaid)
      ? {
          key: 'overpaid',
          label: t('orders.payments.overpaid'),
          value: owed.overpaid,
          strong: true,
        }
      : { key: 'owed', label: t('orders.payments.owed'), value: owed.owed, strong: true },
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

/** One payment, or money given back, as recorded. */
export function PaymentRow({
  payment,
  onReverse,
  showDocument = false,
}: {
  payment: CustomerPaymentDto
  /** Absent: the member may not reverse payments. */
  onReverse?: () => void
  /** On a customer's page: which order or sale it was for. */
  showDocument?: boolean
}) {
  const { t } = useTranslation()
  const businessDate = useBusinessDate()
  const { data: context } = useBusinessContext()
  // Who recorded or reversed it only with a team ("Entered by" only with a team, D-278).
  const team = context?.capabilities.has_team === true
  const reversed = payment.status === 'reversed'
  return (
    <li data-payment className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 py-3">
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
          {payment.kind === 'refund' ? (
            <Badge tone="warning">{t('orders.payments.moneyBackTag')}</Badge>
          ) : null}
          {reversed ? <Badge tone="neutral">{t('orders.payments.reversedTag')}</Badge> : null}
        </p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {businessDate(payment.businessDate)}
          {showDocument ? (
            <>
              {' · '}
              {payment.documentNumber
                ? t('orders.payments.forOrder', { number: isolate(payment.documentNumber) })
                : t('orders.payments.forSale')}
            </>
          ) : null}
          {team ? (
            <>
              {' · '}
              {payment.recordedBy.name
                ? t('orders.payments.recordedBy', { name: isolate(payment.recordedBy.name) })
                : t('orders.payments.recordedByFormer')}
            </>
          ) : null}
        </p>
        {payment.note ? (
          <p className="mt-0.5 text-sm whitespace-pre-line [unicode-bidi:plaintext]">
            {payment.note}
          </p>
        ) : null}
        {reversed ? (
          <p className="mt-0.5 text-sm text-muted-foreground">
            {team
              ? t('orders.payments.reversedOn', {
                  date: businessDate(payment.reversalDate ?? payment.businessDate),
                  name: isolate(payment.reversedBy?.name ?? '…'),
                })
              : t('orders.payments.reversedOnAlone', {
                  date: businessDate(payment.reversalDate ?? payment.businessDate),
                })}
          </p>
        ) : null}
      </div>
      {!reversed && onReverse ? (
        <Button
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={onReverse}
        >
          <Undo2Icon aria-hidden />
          {t('orders.payments.reverse')}
        </Button>
      ) : null}
    </li>
  )
}

/** "Reverse this payment?", then customerPayment.reverse. */
export function ReversePaymentDialog({
  payment,
  onClose,
  onDone,
}: {
  payment: CustomerPaymentDto | null
  onClose: () => void
  onDone?: () => void
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const money = useMoney()
  const queryClient = useQueryClient()
  const refresh = useRefreshOrders()
  const reverse = useMutation(trpc.customerPayment.reverse.mutationOptions())
  const [error, setError] = useState<I18nKey | null>(null)

  async function doReverse() {
    if (!payment) return
    setError(null)
    try {
      const result = await reverse.mutateAsync({ id: payment.id })
      queryClient.setQueryData(
        trpc.customerPayment.list.queryKey(
          result.document.kind === 'order'
            ? { orderId: result.document.id }
            : { saleId: result.document.id },
        ),
        { ...result, nextCursor: null },
      )
      await refresh()
      toast.success(t('orders.payments.reversed'))
      onDone?.()
      onClose()
    } catch (caught) {
      setError(
        apiErrorCode(caught) === 'books_closed'
          ? 'orders.payments.reverseClosed'
          : apiErrorKey(caught),
      )
    }
  }

  return (
    <ConfirmDialog
      open={payment !== null}
      icon={Undo2Icon}
      title={t(
        payment?.kind === 'refund'
          ? 'orders.payments.reverseBackTitle'
          : 'orders.payments.reverseTitle',
      )}
      body={t(
        payment?.kind === 'refund'
          ? 'orders.payments.reverseBackBody'
          : 'orders.payments.reverseBody',
        { amount: payment ? money(payment.amount, payment.currency) : '' },
      )}
      note={t('orders.payments.reverseNote')}
      action={t('orders.payments.reverse')}
      busyLabel={t('orders.payments.reversing')}
      busy={reverse.isPending}
      error={error}
      destructive
      onConfirm={() => void doReverse()}
      onClose={() => {
        setError(null)
        onClose()
      }}
    />
  )
}

/**
 * The payments panel of an order (`orderId`) or a sale "they'll pay later" (`saleId`):
 * customerPayment.list with what it owes. `canPay`: the document takes a payment now (a pending or
 * delivered order, a final sale). `cancelled`: a cancelled order, which owes nothing: once its
 * deposit is given back it says so, never "Paid in full" (D-274).
 */
export function CustomerPaymentsPanel({
  document,
  canRecord,
  canPay,
  cancelled = false,
  today,
  closedThrough,
  hint,
}: {
  document: PaidDocument
  canRecord: boolean
  canPay: boolean
  cancelled?: boolean
  today: string
  closedThrough: string | null
  hint?: string
}) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const money = useMoney()
  const input = document.kind === 'order' ? { orderId: document.id } : { saleId: document.id }
  const list = useQuery(trpc.customerPayment.list.queryOptions(input))
  const [sheet, setSheet] = useState<'payment' | 'refund' | null>(null)
  const [reversing, setReversing] = useState<CustomerPaymentDto | null>(null)
  if (list.isError && !list.data) {
    return (
      <Panel title={t('orders.payments.title')}>
        <LoadError error={list.error} onRetry={() => void list.refetch()} />
      </Panel>
    )
  }
  const owed = list.data?.document
  if (!owed) {
    return (
      <Panel title={t('orders.payments.title')}>
        <p className="text-sm text-muted-foreground">{t('status.loading')}</p>
      </Panel>
    )
  }
  const items = list.data?.items ?? []
  const payable = canRecord && canPay && positive(owed.owed)
  const giveBack = canRecord && positive(owed.overpaid)
  return (
    <Panel
      title={t('orders.payments.title')}
      hint={hint}
      action={
        payable ? (
          <Button variant="outline" onClick={() => setSheet('payment')}>
            <HandCoinsIcon aria-hidden />
            {t('orders.payments.record')}
          </Button>
        ) : giveBack ? (
          <Button variant="outline" onClick={() => setSheet('refund')}>
            <HandCoinsIcon aria-hidden />
            {t('orders.payments.giveBack')}
          </Button>
        ) : null
      }
    >
      <OwedSummary owed={owed} />
      {positive(owed.overpaid) ? (
        <p data-money-back className="mt-2 text-sm font-medium text-warning">
          {t('orders.payments.overpaidNote', { amount: money(owed.overpaid, owed.currency) })}
        </p>
      ) : owed.state === 'paid' && positive(owed.paid) ? (
        cancelled ? (
          <p data-deposit-given-back className="mt-2 text-sm text-muted-foreground">
            {t('orders.payments.depositGivenBack')}
          </p>
        ) : (
          <p data-paid-in-full className="mt-2 text-sm text-success">
            {t('orders.payments.paidInFull')}
          </p>
        )
      ) : null}
      {items.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('orders.payments.none')}</p>
      ) : (
        <ul aria-label={t('orders.payments.title')} className="mt-4 divide-y border-t">
          {items.map((payment) => (
            <PaymentRow
              key={payment.id}
              payment={payment}
              onReverse={canRecord ? () => setReversing(payment) : undefined}
            />
          ))}
        </ul>
      )}
      <ReversePaymentDialog payment={reversing} onClose={() => setReversing(null)} />
      {sheet ? (
        <CustomerPaymentSheet
          document={document}
          mode={sheet}
          max={sheet === 'refund' ? owed.overpaid : owed.owed}
          currency={owed.currency}
          today={today}
          closedThrough={closedThrough}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </Panel>
  )
}
