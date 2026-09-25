import type { Metadata } from 'next'
import { BusinessHome } from '@/features/business/business-home'
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

export default async function BusinessPage({
  params,
}: {
  params: Promise<{ businessId: string }>
}) {
  const { businessId } = await params
  return <BusinessHome businessId={businessId} />
}
