import type { Metadata } from 'next'
import { LocationsSettings } from '@/features/settings/locations-settings'
import { getT } from '@/lib/i18n/server'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('settings.locations.title') }
}

export default async function Page({ params }: { params: Promise<{ businessId: string }> }) {
  const { businessId } = await params
  return <LocationsSettings businessId={businessId} />
}
