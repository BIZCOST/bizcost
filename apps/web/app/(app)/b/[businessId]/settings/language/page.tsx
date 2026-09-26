import type { Metadata } from 'next'
import { LanguageSettings } from '@/features/settings/language-settings'
import { Messages } from '@/lib/i18n/messages'
import { SETTINGS_SECTION_MESSAGES } from '@/lib/i18n/route-messages'
import { getT } from '@/lib/i18n/server'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('settings.language.title') }
}

export default async function Page({ params }: { params: Promise<{ businessId: string }> }) {
  const { businessId } = await params
  return (
    <Messages specs={SETTINGS_SECTION_MESSAGES.language}>
      <LanguageSettings businessId={businessId} />
    </Messages>
  )
}
