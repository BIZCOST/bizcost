import type { Metadata } from 'next'
import { MembersSettings } from '@/features/settings/members-settings'
import { getT } from '@/lib/i18n/server'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('settings.members.title') }
}

export default async function Page({ params }: { params: Promise<{ businessId: string }> }) {
  const { businessId } = await params
  return <MembersSettings businessId={businessId} />
}
