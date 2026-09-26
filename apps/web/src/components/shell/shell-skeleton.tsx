import { releasedModules } from '@bizcost/modules'
import { Skeleton } from '@/components/ui/skeleton'
import { getT } from '@/lib/i18n/server'
import { BusinessFrameLoading } from './business-frame'
import { navSlots } from './nav'
import { PAGE_CONTAINER } from './sizes'

/**
 * A business on its way (app/(app)/b/loading.tsx): the shell with its real controls and placeholders
 * where the business's sections and page go (as many sections as the released modules have), so the
 * frame does not move when the business arrives. The page's placeholder is rendered here, on the
 * server.
 */
export async function ShellSkeleton() {
  const t = await getT()
  return (
    <BusinessFrameLoading slots={navSlots(releasedModules())}>
      <div className={PAGE_CONTAINER}>
        <p role="status" className="sr-only">
          {t('status.loading')}
        </p>
        <div aria-hidden className="space-y-6">
          <Skeleton className="h-32 w-full rounded-2xl sm:h-36" />
          <div className="grid gap-6 xl:grid-cols-5">
            <Skeleton className="h-72 rounded-2xl xl:col-span-3" />
            <Skeleton className="h-72 rounded-2xl xl:col-span-2" />
          </div>
        </div>
      </div>
    </BusinessFrameLoading>
  )
}
