'use client'

import type { BusinessContextDto, MeDto } from '@bizcost/contracts'
import type { ReactNode } from 'react'
import { RememberBusiness } from '@/features/business/remember-business'
import { BusinessApiProvider } from '@/lib/trpc/client'
import { BusinessShell, LoadingShell } from './business-shell'
import type { NavSlots } from './nav'
import { NoLongerMember } from './no-longer-member'
import { PlainShell } from './plain-shell'

/**
 * Everything the business layout shows, as one client module (one entry for the bundler, so the top
 * bar's code is not bundled twice; b/loading.tsx uses BusinessFrameLoading from here too): the
 * business's API, cache and shell (D-079, D-089), or "This business isn't open to you" under the plain
 * top bar.
 */
export function BusinessFrame({
  businessId,
  me,
  context,
  children,
}: {
  businessId: string
  me: MeDto
  context: BusinessContextDto | 'forbidden'
  children: ReactNode
}) {
  if (context === 'forbidden') {
    return (
      <PlainShell>
        <NoLongerMember />
      </PlainShell>
    )
  }
  return (
    <BusinessApiProvider key={businessId} businessId={businessId} me={me} context={context}>
      <RememberBusiness businessId={businessId} />
      <BusinessShell businessId={businessId}>{children}</BusinessShell>
    </BusinessApiProvider>
  )
}

/** The shell while a business opens (b/loading.tsx), around the page's placeholder. */
export function BusinessFrameLoading({
  slots,
  children,
}: {
  slots: NavSlots
  children: ReactNode
}) {
  return <LoadingShell slots={slots}>{children}</LoadingShell>
}
