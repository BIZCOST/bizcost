'use client'

import type { OrderStatus, PaymentState } from '@bizcost/domain'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'

// An order's status (Q16: Pending → Delivered or Cancelled) and, apart from it, how it is paid: Paid,
// Deposit paid (part paid, once delivered or on a sale "they'll pay later"), Not paid, or "Money back
// owed" (paid beyond what it now comes to: a refund, or a cancelled order's deposit, not yet given
// back). The badges of the order list, the order, the customer's page and What customers owe. With
// them, the customer's reference as those rows show it.

const STATUS_TONES = { pending: 'warning', delivered: 'success', cancelled: 'neutral' } as const

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const { t } = useTranslation()
  return (
    <Badge data-order-status={status} tone={STATUS_TONES[status]}>
      {t(`orders.status.${status}`)}
    </Badge>
  )
}

const PAYMENT_TONES = {
  unpaid: 'neutral',
  deposit: 'primary',
  paid: 'success',
  overpaid: 'warning',
} as const

/**
 * Paid / Deposit paid / Not paid. `pending`: a part payment of an order still waiting is its deposit;
 * once delivered (or on a sale) it is a part payment.
 */
export function PaymentBadge({
  state,
  pending = false,
  cancelled = false,
}: {
  state: PaymentState
  pending?: boolean
  /** A cancelled order: nothing is owed, so only money back owed (or nothing) is said. */
  cancelled?: boolean
}) {
  const { t } = useTranslation()
  if (cancelled && state !== 'overpaid') return null
  return (
    <Badge data-payment-state={state} tone={PAYMENT_TONES[state]}>
      {state === 'deposit' && !pending
        ? t('orders.paymentState.part')
        : t(`orders.paymentState.${state}`)}
    </Badge>
  )
}

/**
 * The customer's reference (an LPO "PO-2291"): one piece that moves to the next line whole rather
 * than splitting at its hyphen; one longer than the line still wraps.
 */
export function CustomerRef({ value }: { value: string }) {
  return <bdi className="inline-block max-w-full break-words">{value}</bdi>
}
