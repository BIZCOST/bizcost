'use client'

import { useTRPC } from '@bizcost/app-core'
import type { BusinessContextDto, ProductDto, SaleDto, SalesChannelDto } from '@bizcost/contracts'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useMoney } from '@/features/documents/amounts'
import { can } from '@/features/settings/sections'

// What the sales screens read besides a sale (M3 Step 2): the business's channels, its products and
// services (a sale line names one), today and the books-closed date; and what a change to a sale
// makes stale (D-212).

/** Whether the member enters sales (Today's sales and One sale). */
export function mayEnterSales(context: BusinessContextDto): boolean {
  return can(context, 'sales.documents.manage')
}

/** Which kind of channel a sheet or a sale starts on: the business's own ways of selling first. */
const KIND_ORDER = ['shop', 'messages', 'website', 'other', 'delivery_app', 'marketplace'] as const

/**
 * The channel a sheet or a new sale starts on when none is chosen: null with one channel (the API
 * takes the business's only active one); with two or more, its own ways of selling before the apps
 * and marketplaces (a café's Shop, not Talabat), then by name (the list's order).
 */
export function defaultChannelId(channels: readonly SalesChannelDto[]): string | null {
  if (channels.length < 2) return null
  const rank = (channel: SalesChannelDto) => KIND_ORDER.indexOf(channel.kind)
  return [...channels].sort((a, b) => rank(a) - rank(b))[0]!.id
}

/** The business's sales channels (any sales key lists them), active ones by default. */
export function useChannels(status: 'active' | 'all' = 'active') {
  const trpc = useTRPC()
  const query = useQuery(trpc.channel.list.queryOptions({ status }))
  return { channels: query.data?.data.items ?? [], query }
}

/**
 * What finalized sales count as: before VAT (with those words) for a VAT-registered sale, as the
 * confirmation said it before Finalize; the total otherwise (D-236).
 */
export function useCountedAmount() {
  const { t } = useTranslation()
  const money = useMoney()
  return (sale: Pick<SaleDto, 'vatRegistered' | 'netTotal' | 'total' | 'currency'>) =>
    sale.vatRegistered
      ? `${money(sale.netTotal, sale.currency)} ${t('sales.list.beforeVat')}`
      : money(sale.total, sale.currency)
}

/** Today and the books-closed date. */
export function useBooks() {
  const trpc = useTRPC()
  return useQuery(trpc.books.get.queryOptions())
}

/**
 * Every product and service of the business, archived ones too (a draft may name one), in pages of
 * 100 read one after the other. `ready` once all are here.
 */
export function useAllProducts(enabled: boolean) {
  const trpc = useTRPC()
  const query = useInfiniteQuery({
    ...trpc.product.list.infiniteQueryOptions(
      { status: 'all', limit: 100 },
      { getNextPageParam: (page) => page.nextCursor },
    ),
    enabled,
  })
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])
  const products = useMemo(
    () =>
      new Map<string, ProductDto>(
        (query.data?.pages ?? []).flatMap((page) => page.items).map((p) => [p.id, p] as const),
      ),
    [query.data],
  )
  return {
    products,
    ready: !enabled || (query.isSuccess && !hasNextPage),
    error: query.isError ? query.error : null,
  }
}

/**
 * The branches the member may sell at, for One sale's picker (with branches only): the day sheet
 * lists them for every member who enters sales, also those who may not manage locations, and only
 * their own when they are limited to some (Q12). Null without branches or while it is read.
 */
export function useSaleLocations(
  context: BusinessContextDto | undefined,
  today: string,
  channelId: string | null,
) {
  const trpc = useTRPC()
  const scope = context?.locationScope
  const enabled = context?.capabilities.multi_location === true && mayEnterSales(context)
  const query = useQuery({
    ...trpc.sale.daySheet.queryOptions({
      businessDate: today,
      periodFrom: null,
      channelId,
      locationId: scope && !scope.all ? (scope.ids[0] ?? null) : null,
    }),
    enabled,
  })
  return enabled ? (query.data?.data.locations ?? null) : null
}

/** After a sale is saved, finalized, reversed or corrected: the lists and sheets are read again. */
export function useRefreshSales() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  return useCallback(
    () =>
      Promise.all(
        [trpc.sale.list.pathKey(), trpc.sale.get.pathKey(), trpc.sale.daySheet.pathKey()].map(
          (queryKey) => queryClient.invalidateQueries({ queryKey }),
        ),
      ),
    [trpc, queryClient],
  )
}
