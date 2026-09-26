import { isUuid } from '@bizcost/domain'
import { notFound, redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { BusinessFrame } from '@/components/shell/business-frame'
import { getBusinessContext, getMe } from '@/lib/trpc/server'

// One business (docs/ARCHITECTURE.md §Active business): the id is in the URL, so each tab can have
// its own. `business.context` is loaded through the server caller and drives the app shell (D-089).
// A malformed id is "not found"; a business the user is not (or no longer) an active member of says
// so, the same for one that does not exist (the API gives one answer for both). The (app) layout
// handles an ended session.

export default async function BusinessLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ businessId: string }>
}) {
  const { businessId } = await params
  if (!isUuid(businessId)) notFound()
  // One spelling of each business link: `me`, the switcher and the API all use lowercase ids.
  const canonical = businessId.toLowerCase()
  if (businessId !== canonical) redirect(`/b/${canonical}`)
  const [me, context] = await Promise.all([getMe(), getBusinessContext(businessId)])
  if (!me || context === 'signed-out') return null
  return (
    <BusinessFrame businessId={businessId} me={me} context={context}>
      {children}
    </BusinessFrame>
  )
}
