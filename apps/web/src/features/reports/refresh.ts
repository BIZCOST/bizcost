'use client'

import type { useTRPC } from '@bizcost/app-core'
import type { useQueryClient } from '@tanstack/react-query'

// What a change to sales or costs makes stale (D-212, M3 Step 3): real profit is worked out on read
// from the finalized sales, their frozen costs, the month's costs, the channels' fees and the owner's
// time, and nothing caches it on the server. So after a sale, a purchase or a return, an expense, a
// running cost, a category, a channel, a product or its recipe, a material, the hourly rate, the VAT
// registration or Customize BizCost changes, the screens that show it read it again: Product costs
// (the share is live), Reports → Real profit, the Dashboard's cards and its checklist ("Add or import
// your sales", "See your real profit"). Those on the screen are read again at once, the others when
// they are next opened.

type Trpc = ReturnType<typeof useTRPC>

/** The queries a change to sales or costs makes stale. */
export function profitQueryKeys(trpc: Trpc) {
  return [
    trpc.productCost.pathKey(),
    trpc.profit.pathKey(),
    trpc.dashboard.cards.pathKey(),
    trpc.dashboard.checklist.pathKey(),
  ]
}

/** Marks them stale, for code that holds the query client (a change's refresh). */
export function invalidateProfit(
  queryClient: ReturnType<typeof useQueryClient>,
  trpc: Trpc,
): Promise<unknown> {
  return Promise.all(
    profitQueryKeys(trpc).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  )
}
