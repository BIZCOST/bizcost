import type { Metadata } from 'next'
import { CustomizeSettings } from '@/features/settings/customize-settings'
import { getT } from '@/lib/i18n/server'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('settings.modules.title') }
}

export default async function Page({ params }: { params: Promise<{ businessId: string }> }) {
  const { businessId } = await params
  return <CustomizeSettings businessId={businessId} />
}
