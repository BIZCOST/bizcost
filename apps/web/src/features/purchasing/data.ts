'use client'

import { useTRPC } from '@bizcost/app-core'
import type { BusinessContextDto, MaterialDto } from '@bizcost/contracts'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo } from 'react'
import { can } from '@/features/settings/sections'

// What the purchase screens read besides the purchase: the materials a line can name, the suppliers,
// the branches and the books-closed date. Each only when the business uses it and the member may see
// it (the API refuses the rest).

/** Whether module `id` is on for the business (released, or previewed on a local server). */
export function hasModule(context: BusinessContextDto, id: string): boolean {
  return context.modules.some((module) => module.id === id)
}

/**
 * Whether the member may see what the business owes others (payable.list): a kind's payments key
 * with its module on (the amounts also need supplier prices: without them the page says so, D-160).
 */
export function mayListPayables(context: BusinessContextDto): boolean {
  return (
    (hasModule(context, 'purchases') && can(context, 'purchases.payments.view')) ||
    (hasModule(context, 'expenses') && can(context, 'expenses.payments.view'))
  )
}

/**
 * After a change to an expense, a purchase or a payment: the member's own records (My expenses, an
 * expense of theirs with its amounts, Owed to me; D-181) are read again.
 */
export function useRefreshOwnRecords() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  return useCallback(
    () =>
      Promise.all(
        [
          trpc.expense.mine.pathKey(),
          trpc.expense.getMine.pathKey(),
          trpc.payable.mine.pathKey(),
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      ),
    [trpc, queryClient],
  )
}

/**
 * Every material of the business, archived ones too (a draft may name one), in pages of 100 read one
 * after the other. `ready` once all are here.
 */
export function useAllMaterials(enabled: boolean) {
  const trpc = useTRPC()
  const query = useInfiniteQuery({
    ...trpc.material.list.infiniteQueryOptions(
      { status: 'all', limit: 100 },
      { getNextPageParam: (page) => page.nextCursor },
    ),
    enabled,
  })
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])
  const materials = useMemo(
    () =>
      new Map<string, MaterialDto>(
        (query.data?.pages ?? []).flatMap((page) => page.items).map((m) => [m.id, m] as const),
      ),
    [query.data],
  )
  return {
    materials,
    ready: !enabled || (query.isSuccess && !hasNextPage),
    error: query.isError ? query.error : null,
  }
}

/**
 * Every supplier (archived ones too), for a picker or a filter, in pages of 100 read one after the
 * other; only for members who may see suppliers.
 */
export function useSupplierOptions(context: BusinessContextDto | undefined) {
  const trpc = useTRPC()
  const enabled =
    context !== undefined && hasModule(context, 'suppliers') && can(context, 'suppliers.items.view')
  const query = useInfiniteQuery({
    ...trpc.supplier.list.infiniteQueryOptions(
      { status: 'all', limit: 100 },
      { getNextPageParam: (page) => page.nextCursor },
    ),
    enabled,
  })
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])
  const suppliers = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.items),
    [query.data],
  )
  return { enabled, suppliers }
}

/** The branches, for a business with branches and a member who may see them. */
export function useLocationOptions(context: BusinessContextDto | undefined) {
  const trpc = useTRPC()
  const enabled =
    context?.capabilities.multi_location === true && can(context, 'settings.locations.manage')
  const query = useQuery({ ...trpc.location.list.queryOptions(), enabled })
  return { enabled, locations: query.data ?? [] }
}
