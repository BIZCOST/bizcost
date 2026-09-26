import { businessDisplayName } from '@bizcost/domain'
import type { Metadata } from 'next'
import { Dashboard } from '@/features/dashboard/dashboard'
import { getLocale } from '@/lib/i18n/server'
import { getMe } from '@/lib/trpc/server'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ businessId: string }>
}): Promise<Metadata> {
  const [{ businessId }, me, locale] = await Promise.all([params, getMe(), getLocale()])
  const membership = me?.memberships.find((m) => m.businessId === businessId)
  // The name the page shows (its Arabic name in Arabic, D-097).
  return membership ? { title: businessDisplayName(membership, locale) } : {}
}

/** The business home: the Dashboard (ROADMAP.md Step 7); its data comes from the layout. */
export default function BusinessPage() {
  return <Dashboard />
}
