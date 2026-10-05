'use client'

import { useTRPC } from '@bizcost/app-core'
import type { ProductCostDto, ProductDto } from '@bizcost/contracts'
import type { TerminologyProfile } from '@bizcost/domain'
import { useQueries } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Locked, useMoney } from '@/features/documents/amounts'
import { useTerminology } from '@/lib/i18n/client'
import { NBSP } from './units'

// What one unit of each product costs in materials, in the Products list (M2 Step 4; D-115, D-117):
// its recipe's materials at their average, divided by what the recipe makes (D-178: a cake that
// makes 12 slices costs its total ÷ 12 a slice): "Recipe cost: AED 3.00 per piece", then an
// "incomplete" tag while one has no price yet, which wraps whole and leaves no separator at a line's
// end; "No recipe yet" before anything goes into it; or, bought ready to sell, what it costs to buy
// ("Cost: AED 0.50 per piece"). Never 0 for a price that isn't known: "no price yet". Rounded only
// here; the API keeps 12 decimals. The amounts are `cost`: a member who may not see them sees a lock.

/** The material costs of the products of each loaded page of the list (product.costs takes a page). */
export function useProductCosts(
  pages: readonly { readonly items: readonly ProductDto[] }[],
  enabled: boolean,
): ReadonlyMap<string, ProductCostDto> {
  const trpc = useTRPC()
  const results = useQueries({
    queries: pages.map((page) => ({
      ...trpc.product.costs.queryOptions({ ids: page.items.map((product) => product.id) }),
      enabled: enabled && page.items.length > 0,
    })),
  })
  return new Map(
    results
      .flatMap((result) => result.data?.data.items ?? [])
      .map((cost) => [cost.productId, cost] as const),
  )
}

/** The product's material cost, on its own line of the row's details. */
export function ProductCostLine({
  cost,
  profile,
}: {
  cost: ProductCostDto | undefined
  profile: TerminologyProfile
}) {
  const { t } = useTranslation()
  const term = useTerminology()
  const money = useMoney()
  if (!cost) return null
  if (cost.kind === 'recipe' && cost.lineCount === 0) {
    return (
      <span data-product-cost="none" className="block">
        {term('catalog.products.cost.noRecipe', profile)}
      </span>
    )
  }
  // One unit sold: the recipe's total ÷ what it makes (the total itself when it makes one).
  const total = cost.cost.perUnit
  const amount =
    total === undefined ? (
      <Locked category="cost" />
    ) : total === null ? (
      // Null: never bought ("no price yet"), or too large to work out (absurd amounts, D-178).
      cost.cost.tooLarge ? (
        t('catalog.recipes.tooLarge')
      ) : (
        t('catalog.products.cost.noPrice')
      )
    ) : (
      // For one unit sold, as the price is: "AED 3.00 per piece".
      <span className="whitespace-nowrap">
        <bdi className="font-medium text-foreground tabular-nums">
          {money(total).replaceAll(' ', NBSP)}
        </bdi>
        {`${NBSP}${t(`units.per.${cost.unit}`).replaceAll(' ', NBSP)}`}
      </span>
    )
  const [before, after] = (
    cost.kind === 'resale'
      ? t('catalog.products.cost.resale', { amount: '\u0000' })
      : term('catalog.products.cost.recipe', profile, { amount: '\u0000' })
  ).split('\u0000')
  return (
    <span data-product-cost={cost.cost.complete ? 'complete' : 'incomplete'} className="block">
      {before}
      {amount}
      {after}
      {/* Incomplete says something only next to an amount (not "no price yet", not a lock). */}
      {typeof total === 'string' && !cost.cost.complete ? (
        <>
          {' '}
          <Badge tone="warning" className="align-middle">
            {t('catalog.products.cost.incomplete')}
          </Badge>
        </>
      ) : null}
    </span>
  )
}
