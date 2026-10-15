'use client'

import { useTRPC } from '@bizcost/app-core'
import type { BusinessContextDto, CustomerPickItemDto } from '@bizcost/contracts'
import { phoneLast4 } from '@bizcost/domain'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import { hasModule } from '@/features/purchasing/data'
import { can } from '@/features/settings/sections'

// Who may do what with customers (M3 Step 5; Q2, Q10, D-263, D-269): seeing customers (their list,
// their page, the whole phone number) needs customers.items.view; naming one on an order, a sale or a
// payment needs a key that names customers, and gives a member without .view the name and the phone's
// last 4 digits only (customer.pick); adding one needs .manage; changing or archiving one needs both.

/** Customers is on and the member sees them (list, page, details). */
export function maySeeCustomers(context: BusinessContextDto): boolean {
  return hasModule(context, 'customers') && can(context, 'customers.items.view')
}

/** The member may name a customer (customer.pick and customer.similar answer them). */
export function mayPickCustomers(context: BusinessContextDto): boolean {
  if (!hasModule(context, 'customers')) return false
  return (
    can(context, 'customers.items.view') ||
    can(context, 'customers.items.manage') ||
    (hasModule(context, 'orders') && can(context, 'orders.documents.manage')) ||
    (hasModule(context, 'sales') && can(context, 'sales.documents.manage')) ||
    (hasModule(context, 'payments') && can(context, 'payments.customers.record'))
  )
}

/** The member may add a customer (the Employee's quick add, Q10). */
export function mayAddCustomers(context: BusinessContextDto): boolean {
  return hasModule(context, 'customers') && can(context, 'customers.items.manage')
}

/** The member may change and archive customers (adding alone does not: D-263). */
export function mayChangeCustomers(context: BusinessContextDto): boolean {
  return mayAddCustomers(context) && can(context, 'customers.items.view')
}

/**
 * How a customer is told apart from another of the same name: their phone for a member who sees
 * customers, else its last 4 digits ("…4567"); null without a phone.
 */
export function phoneHint(
  customer: Pick<CustomerPickItemDto, 'phone' | 'phoneLast4'>,
): string | null {
  if (customer.phone) return customer.phone
  const last4 = customer.phoneLast4 ?? phoneLast4(customer.phone)
  return last4 ? `…${last4}` : null
}

/**
 * After a customer is added, changed or archived: the lists, pickers and pages that name them, and
 * the orders, sales and what customers owe, which show their name.
 */
export function useRefreshCustomers() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  return useCallback(
    () =>
      Promise.all(
        [
          trpc.customer.pathKey(),
          trpc.order.list.pathKey(),
          trpc.order.get.pathKey(),
          trpc.receivable.pathKey(),
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      ),
    [trpc, queryClient],
  )
}

/** `value` once it has stayed the same for `ms` (a search a moment after typing). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}
