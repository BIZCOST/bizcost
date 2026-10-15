'use client'

import { useTRPC } from '@bizcost/app-core'
import type { BusinessContextDto } from '@bizcost/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { profitQueryKeys } from '@/features/reports/refresh'
import { can } from '@/features/settings/sections'

// What the import screens read and make stale (M3 Step 4).

/**
 * Whether the member imports sales from a file: the import key (it grants nothing without entering
 * and finalizing sales, D-190) with Products & Services on (the names are matched to products).
 */
export function mayImport(context: BusinessContextDto): boolean {
  return can(context, 'sales.imports.manage') && context.modules.some((m) => m.id === 'products')
}

/** The member sees costs (the costs switch): a file's fee column, statements, unpriced materials. */
export function seesCosts(context: BusinessContextDto): boolean {
  return context.visibleCategories.includes('cost')
}

/**
 * After an import changes (made, rows sent, names answered, finalized, reversed): the imports, the
 * sales and Today's sales, products (an "Add as new"), and what real profit shows (D-212).
 */
export function useRefreshImports() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  return useCallback(
    () =>
      Promise.all(
        [
          trpc.saleImport.list.pathKey(),
          trpc.saleImport.get.pathKey(),
          trpc.importProfile.list.pathKey(),
          trpc.sale.list.pathKey(),
          trpc.sale.get.pathKey(),
          trpc.sale.daySheet.pathKey(),
          trpc.product.list.pathKey(),
          trpc.channelStatement.list.pathKey(),
          ...profitQueryKeys(trpc),
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      ),
    [trpc, queryClient],
  )
}

/** The address of an import's page. */
export function importHref(businessId: string, importId: string): string {
  return `/b/${businessId}/sales/import/${importId}`
}
