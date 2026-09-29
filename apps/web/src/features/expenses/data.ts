'use client'

import { useTRPC } from '@bizcost/app-core'
import type { BusinessContextDto, CostCategoryDto } from '@bizcost/contracts'
import { STARTER_COST_CATEGORIES } from '@bizcost/domain'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { hasModule } from '@/features/purchasing/data'
import { can } from '@/features/settings/sections'
import { orderCategories } from './categories'

// What the expense and running-cost screens read besides their records (M2 Step 5): the categories
// they share (D-116, D-167), who may change them, and whether expenses need approval (D-164).

/**
 * Every category of the business, archived ones too (a record may have one), in pages of 100 read one
 * after the other, in the order people look for them (the starter list first, "Other" last). `ready`
 * once all are here.
 */
export function useCostCategories(enabled = true) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const query = useInfiniteQuery({
    ...trpc.costCategory.list.infiniteQueryOptions(
      { status: 'all', limit: 100 },
      { getNextPageParam: (page) => page.nextCursor },
    ),
    enabled,
  })
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])
  const starterNames = STARTER_COST_CATEGORIES.map((key) => t(`setup.cost_categories.${key}`))
  const starterKey = starterNames.join('\n')
  const categories = useMemo<CostCategoryDto[]>(
    () =>
      orderCategories(
        (query.data?.pages ?? []).flatMap((page) => page.items),
        starterKey.split('\n'),
      ),
    [query.data, starterKey],
  )
  return {
    categories,
    ready: !enabled || (query.isSuccess && !hasNextPage),
    error: query.isError ? query.error : null,
    refetch: query.refetch,
  }
}

/**
 * The categories a form picks from: every category (useCostCategories), and the ones added from the
 * form itself until the list has read them (`add`).
 */
export function useCategoryOptions(enabled = true) {
  const { categories, ready } = useCostCategories(enabled)
  const [added, setAdded] = useState<CostCategoryDto[]>([])
  const all = useMemo(
    () => [...categories, ...added.filter((a) => !categories.some((c) => c.id === a.id))],
    [categories, added],
  )
  const add = useCallback(
    (category: CostCategoryDto) =>
      setAdded((current) => [...current.filter((c) => c.id !== category.id), category]),
    [],
  )
  return { categories: all, ready, add }
}

/**
 * Whether the member may add, rename or archive categories: whoever may enter expenses or change
 * running costs, with that module on (D-167; the API checks the same).
 */
export function canManageCategories(context: BusinessContextDto): boolean {
  return (
    (hasModule(context, 'expenses') && can(context, 'expenses.documents.manage')) ||
    (hasModule(context, 'running_costs') && can(context, 'running_costs.items.manage'))
  )
}

/**
 * Whether the member reviews expenses: approves or rejects them, or finalizes one as its approver.
 * Reviewing needs the amounts visible (supplier prices, D-165): what is approved is what they saw
 * (D-175; the API refuses the others).
 */
export function mayReviewExpenses(context: BusinessContextDto): boolean {
  return (
    can(context, 'expenses.documents.approve') &&
    context.visibleCategories.includes('supplier_price')
  )
}

/** Whether expenses need approval now (expense.settings), for members who may see expenses. */
export function useExpenseSettings(context: BusinessContextDto | undefined) {
  const trpc = useTRPC()
  const enabled =
    context !== undefined &&
    hasModule(context, 'expenses') &&
    can(context, 'expenses.documents.view')
  return useQuery({ ...trpc.expense.settings.queryOptions(), enabled })
}
