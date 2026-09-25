import type { Metadata } from 'next'
import { RolesSettings } from '@/features/settings/roles-settings'
import { getT } from '@/lib/i18n/server'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('settings.roles.title') }
}

export default async function Page({ params }: { params: Promise<{ businessId: string }> }) {
  const { businessId } = await params
  return <RolesSettings businessId={businessId} />
}
