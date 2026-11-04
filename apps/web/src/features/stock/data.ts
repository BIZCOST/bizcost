'use client'

import { useTRPC } from '@bizcost/app-core'
import type { BusinessContextDto, StockItemDto } from '@bizcost/contracts'
import { STOCK_PAGE_SIZE_MAX } from '@bizcost/contracts'
import type { StockCountKind } from '@bizcost/domain'
import { hashKey, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo } from 'react'
import { invalidateProfit } from '@/features/reports/refresh'
import { can } from '@/features/settings/sections'

// What the stock screens read besides one answer (M4 Step 2): who may do what (the API checks the
// same: inventory.stock.view sees stock, .counts.enter fills counts blind, .counts.manage starts,
// reviews, finalizes and reverses them), today and the books-closed date, the branches the member
// sees, every tracked material, and what a change to a count makes stale.

/** Sees stock on hand, stock cards and finalized counts. */
export function maySeeStock(context: BusinessContextDto): boolean {
  return can(context, 'inventory.stock.view') || mayManageCounts(context)
}

/** Fills counts (blind without managing them). */
export function mayEnterCounts(context: BusinessContextDto): boolean {
  return can(context, 'inventory.counts.enter') || mayManageCounts(context)
}

/** Starts tracking, starts, reviews, finalizes, discards and reverses counts. */
export function mayManageCounts(context: BusinessContextDto): boolean {
  return can(context, 'inventory.counts.manage')
}

/**
 * Starts or changes a first count: it covers every branch on one day, so only a member who works in
 * every branch (the API refuses the others).
 */
export function mayStartTracking(context: BusinessContextDto): boolean {
  return mayManageCounts(context) && context.locationScope.all
}

/**
 * Discards, adds to, reviews, finalizes, takes lines off and reverses a count of `kind`: a manager of
 * counts, and for a first count one who works in every branch (the API refuses the others).
 */
export function mayChangeCount(context: BusinessContextDto, kind: StockCountKind): boolean {
  return kind === 'opening' ? mayStartTracking(context) : mayManageCounts(context)
}

/** Whether the business has branches (more than its one location). */
export function hasBranches(context: BusinessContextDto): boolean {
  return context.capabilities.multi_location === true
}

/** Today and the books-closed date. */
export function useBooks() {
  const trpc = useTRPC()
  return useQuery(trpc.books.get.queryOptions())
}

export interface StockBranch {
  readonly id: string
  readonly name: string
}

/**
 * What stock.list says besides its items (one item asked for): the live branches the member works
 * in (their own when limited to some, D-234), by name, and whether anything is tracked yet.
 * `branches` are those for a picker or a filter: empty for a business without the branches setting
 * (its one location); `live` all of them. Both are empty while it is read (`ready` false), and
 * `anyTracked` is undefined then.
 */
export function useStockBranches(context: BusinessContextDto | undefined): {
  branches: readonly StockBranch[]
  live: readonly StockBranch[]
  anyTracked: boolean | undefined
  ready: boolean
} {
  const trpc = useTRPC()
  const enabled = context !== undefined && maySeeStock(context)
  const query = useQuery({ ...trpc.stock.list.queryOptions({ limit: 1 }), enabled })
  const withBranches = context !== undefined && hasBranches(context)
  const live = useMemo(() => query.data?.data.branches ?? [], [query.data])
  return {
    branches: withBranches ? live : NO_BRANCHES,
    live,
    anyTracked: query.data ? query.data.data.items.length > 0 : undefined,
    ready: !enabled || query.isSuccess,
  }
}

const NO_BRANCHES: readonly StockBranch[] = []

/**
 * Every tracked material with its stock in the member's branches, in pages read one after the other
 * (a count's picker; the last count of each in each branch). `ready` once all are here.
 */
export function useAllTracked(enabled: boolean) {
  const trpc = useTRPC()
  const query = useInfiniteQuery({
    ...trpc.stock.list.infiniteQueryOptions(
      { limit: STOCK_PAGE_SIZE_MAX },
      { getNextPageParam: (page) => page.data.nextCursor },
    ),
    enabled,
  })
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])
  const items = useMemo<StockItemDto[]>(
    () => (query.data?.pages ?? []).flatMap((page) => page.data.items),
    [query.data],
  )
  return {
    items,
    ready: !enabled || (query.isSuccess && !hasNextPage),
    error: query.isError ? query.error : null,
  }
}

/**
 * After a count is started, changed, finalized, discarded or reversed: stock, counts and stock cards
 * are read again, and what a material's average feeds (its cost, product costs, recipes, real
 * profit): a first count switches a material to its stock average (D-339 Q2). `gone`: a count just
 * discarded, whose own page is left, not read again (it would say NOT_FOUND on its way out).
 */
export function useRefreshStock() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  return useCallback(
    (gone?: string) => {
      const skipped = gone
        ? new Set([
            hashKey(trpc.count.get.queryKey({ id: gone })),
            hashKey(trpc.count.review.queryKey({ id: gone })),
          ])
        : null
      return Promise.all([
        ...[
          trpc.stock.pathKey(),
          trpc.count.list.pathKey(),
          trpc.count.get.pathKey(),
          trpc.count.review.pathKey(),
          trpc.material.costs.pathKey(),
          trpc.product.costs.pathKey(),
          trpc.recipe.get.pathKey(),
        ].map((queryKey) =>
          queryClient.invalidateQueries({
            queryKey,
            predicate: (query) => !skipped?.has(query.queryHash),
          }),
        ),
        invalidateProfit(queryClient, trpc),
      ])
    },
    [trpc, queryClient],
  )
}
