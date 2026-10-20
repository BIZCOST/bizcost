'use client'

import { useTRPC } from '@bizcost/app-core'
import type { BusinessContextDto } from '@bizcost/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { maySeeCustomers } from '@/features/customers/data'
import { maySeePayments } from '@/features/orders/data'
import { hasModule } from '@/features/purchasing/data'
import { profitQueryKeys } from '@/features/reports/refresh'
import { can } from '@/features/settings/sections'

export {
  creditNoteKindKey,
  invoiceDtoState,
  invoiceKindKey,
  invoiceStateOf,
  type InvoiceState,
} from './states'

// Who may do what with invoices and credit notes (M3 Step 8; the plan's Q10 table, D-306), what an
// invoice is called, the state it shows in the list, and what a change to one makes stale. The API
// checks the same keys; this only decides what the screens offer.

/** Invoices is on and the member sees invoices and credit notes. */
export function mayViewInvoices(context: BusinessContextDto): boolean {
  return hasModule(context, 'invoices') && can(context, 'invoices.documents.view')
}

/** The member prepares drafts (from scratch, a quotation, an order or a sale) and copies them. */
export function mayManageInvoices(context: BusinessContextDto): boolean {
  return mayViewInvoices(context) && can(context, 'invoices.documents.manage')
}

/** The member issues invoices (the number is taken; it is frozen). */
export function mayIssueInvoices(context: BusinessContextDto): boolean {
  return mayViewInvoices(context) && can(context, 'invoices.documents.issue')
}

/** The member prepares and issues credit notes. */
export function mayCreditInvoices(context: BusinessContextDto): boolean {
  return mayViewInvoices(context) && can(context, 'invoices.documents.credit')
}

/**
 * A customer's statement (Q27): for every business with Customers on, orders-only ones included
 * (Release B, B10), with payments seen and the customer's particulars seen (it prints them, D-263).
 */
export function maySeeStatements(context: BusinessContextDto): boolean {
  return maySeePayments(context) && maySeeCustomers(context)
}

/**
 * After an invoice or a credit note changes: invoices, credit notes, what customers owe, payments,
 * the orders and sales they bill (and what real profit shows: an issued invoice can post a sale).
 */
export function useRefreshInvoices() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  return useCallback(
    () =>
      Promise.all(
        [
          trpc.invoice.pathKey(),
          trpc.creditNote.pathKey(),
          trpc.customerPayment.pathKey(),
          trpc.receivable.pathKey(),
          trpc.customer.statement.pathKey(),
          trpc.order.pathKey(),
          trpc.quotation.pathKey(),
          trpc.sale.list.pathKey(),
          trpc.sale.get.pathKey(),
          trpc.attachment.pathKey(),
          ...profitQueryKeys(trpc),
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      ),
    [trpc, queryClient],
  )
}
