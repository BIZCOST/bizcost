import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { landingBusinessId } from '@/features/business/memberships'
import { HomeView } from '@/features/home/home-view'
import { getT } from '@/lib/i18n/server'
import { getMe } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('nav.home') }
}

/**
 * A user with a business goes to the one opened last (else the first); without one, home offers
 * Smart Setup.
 */
export default async function HomePage() {
  const me = await getMe()
  const businessId = me ? landingBusinessId(me) : null
  if (businessId) redirect(`/b/${businessId}`)
  return <HomeView />
}
