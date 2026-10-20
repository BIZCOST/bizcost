'use client'

import { useTRPC } from '@bizcost/app-core'
import type { BusinessContextDto } from '@bizcost/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { hasModule } from '@/features/purchasing/data'
import { profitQueryKeys } from '@/features/reports/refresh'
import { can } from '@/features/settings/sections'

// Who may do what with orders and customer payments (M3 Step 5; Q10, D-265, D-267, D-269), and what
// a change to them makes stale (D-212).

/** Orders is on and the member enters orders (and changes and cancels pending ones). */
export function mayEnterOrders(context: BusinessContextDto): boolean {
  return hasModule(context, 'orders') && can(context, 'orders.documents.manage')
}

/** The member delivers orders (each counts as a sale on its delivery day). */
export function mayDeliverOrders(context: BusinessContextDto): boolean {
  return hasModule(context, 'orders') && can(context, 'orders.documents.deliver')
}

/** The member undoes deliveries and refunds delivered orders. */
export function mayReverseOrders(context: BusinessContextDto): boolean {
  return hasModule(context, 'orders') && can(context, 'orders.documents.reverse')
}

/** The member sees every order (not only their own). */
export function maySeeEveryOrder(context: BusinessContextDto): boolean {
  return hasModule(context, 'orders') && can(context, 'orders.documents.view')
}

/** Payments is on and the member sees what customers pay and owe. */
export function maySeePayments(context: BusinessContextDto): boolean {
  return hasModule(context, 'payments') && can(context, 'payments.customers.view')
}

/** Payments is on and the member records customers' payments and money given back. */
export function mayRecordPayments(context: BusinessContextDto): boolean {
  return hasModule(context, 'payments') && can(context, 'payments.customers.record')
}

/**
 * After an order, a delivery, a refund or a customer payment changes: the orders, sales, payments and
 * what customers owe are read again, and what real profit shows (D-212: the Dashboard's cards too).
 */
export function useRefreshOrders() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  return useCallback(
    () =>
      Promise.all(
        [
          trpc.order.pathKey(),
          trpc.sale.list.pathKey(),
          trpc.sale.get.pathKey(),
          trpc.sale.daySheet.pathKey(),
          trpc.customerPayment.pathKey(),
          trpc.receivable.pathKey(),
          // M3 Step 8: what an invoice is paid and owes, and a customer's statement.
          trpc.invoice.pathKey(),
          trpc.customer.statement.pathKey(),
          ...profitQueryKeys(trpc),
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      ),
    [trpc, queryClient],
  )
}
