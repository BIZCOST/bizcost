import type { Metadata } from 'next'
import { LanguageSettings } from '@/features/settings/language-settings'
import { getT } from '@/lib/i18n/server'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('settings.language.title') }
}

export default async function Page({ params }: { params: Promise<{ businessId: string }> }) {
  const { businessId } = await params
  return <LanguageSettings businessId={businessId} />
}
