import type { Metadata } from 'next'
import { Dashboard } from '@/features/dashboard/dashboard'
import { getMe } from '@/lib/trpc/server'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ businessId: string }>
}): Promise<Metadata> {
  const [{ businessId }, me] = await Promise.all([params, getMe()])
  const membership = me?.memberships.find((m) => m.businessId === businessId)
  return membership ? { title: membership.legalName } : {}
}

/** The business home: the Dashboard (ROADMAP.md Step 7); its data comes from the layout. */
export default function BusinessPage() {
  return <Dashboard />
}
