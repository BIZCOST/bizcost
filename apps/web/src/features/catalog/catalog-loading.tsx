'use client'

import type { I18nKey } from '@bizcost/i18n'
import { PageContainer } from '@/components/shell/page-container'
import { Skeleton } from '@/components/ui/skeleton'
import { useTerminology } from '@/lib/i18n/client'
import { useBusinessContext } from '@/lib/trpc/client'
import { ListSkeleton } from './catalog-list'

/**
 * A catalog page on its way (its loading.tsx): the page's title in the business's wording, and
 * placeholders where the search and the rows go, so nothing moves when the page arrives.
 */
export function CatalogLoading({ titleKey }: { titleKey: I18nKey }) {
  const term = useTerminology()
  const { data: context } = useBusinessContext()
  return (
    <PageContainer>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {term(titleKey, context?.terminologyProfile)}
        </h1>
        <Skeleton className="mt-3 h-4 w-full max-w-md" />
      </div>
      <Skeleton className="mb-4 h-11 w-full rounded-lg" />
      <ListSkeleton />
    </PageContainer>
  )
}
