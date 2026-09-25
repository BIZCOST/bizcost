import type { Metadata } from 'next'
import { SettingsHome } from '@/features/settings/settings-shell'
import { getT } from '@/lib/i18n/server'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('settings.title') }
}

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ businessId: string }>
}) {
  const { businessId } = await params
  return <SettingsHome businessId={businessId} />
}
