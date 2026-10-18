'use client'

import { useTRPC } from '@bizcost/app-core'
import type { BusinessContextDto, QuotationDto } from '@bizcost/contracts'
import { quotationActions, type QuotationAction } from '@bizcost/domain'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { hasModule } from '@/features/purchasing/data'
import { can } from '@/features/settings/sections'

// Who may do what with quotations (M3 Step 7; Q10, D-286), what a revision offers, and what a change
// to one makes stale. The API checks the same keys; this only decides what the screens offer.

/** Quotations is on and the member sees them. */
export function mayViewQuotations(context: BusinessContextDto): boolean {
  return hasModule(context, 'quotations') && can(context, 'quotations.documents.view')
}

/** The member prepares, sends, revises, copies and discards quotations. */
export function mayManageQuotations(context: BusinessContextDto): boolean {
  return mayViewQuotations(context) && can(context, 'quotations.documents.manage')
}

/** The member records the customer's answer (accepted or declined). */
export function mayDecideQuotations(context: BusinessContextDto): boolean {
  return mayViewQuotations(context) && can(context, 'quotations.documents.decide')
}

/** The member makes an order of an accepted quotation (Orders on, orders.documents.manage). */
export function mayOrderQuotations(context: BusinessContextDto): boolean {
  return (
    mayManageQuotations(context) &&
    hasModule(context, 'orders') &&
    can(context, 'orders.documents.manage')
  )
}

/** What a revision offers this member (the domain's transitions, then the member's keys). */
export function offeredActions(
  quotation: Pick<QuotationDto, 'status' | 'latest' | 'orderId' | 'otherHasOrder'>,
  context: BusinessContextDto,
): Set<QuotationAction> {
  const actions = quotationActions({
    status: quotation.status,
    latest: quotation.latest,
    hasOrder: quotation.orderId !== null,
    otherHasOrder: quotation.otherHasOrder,
  })
  return new Set(
    actions.filter((action) => {
      if (action === 'accept' || action === 'decline') return mayDecideQuotations(context)
      if (action === 'to_order') return mayOrderQuotations(context)
      return mayManageQuotations(context)
    }),
  )
}

/** After a quotation changes: its lists, its revisions and history are read again (and orders). */
export function useRefreshQuotations() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  return useCallback(
    () =>
      Promise.all(
        [trpc.quotation.pathKey(), trpc.order.pathKey(), trpc.attachment.pathKey()].map(
          (queryKey) => queryClient.invalidateQueries({ queryKey }),
        ),
      ),
    [trpc, queryClient],
  )
}
