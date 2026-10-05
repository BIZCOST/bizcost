import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ChannelsSettings } from '@/features/settings/channels-settings'
import { Messages } from '@/lib/i18n/messages'
import { SETTINGS_SECTION_MESSAGES } from '@/lib/i18n/route-messages'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

// Sales channels (M3 Step 2; D-226): part of Sales, so the page exists only while that module is
// served on this server (until Release A, only the dev-only preview, D-125).

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('sales') ? 'settings.channels.title' : 'notFound.title') }
}

export default async function Page({ params }: { params: Promise<{ businessId: string }> }) {
  if (!isModuleServed('sales')) notFound()
  const { businessId } = await params
  return (
    <Messages specs={SETTINGS_SECTION_MESSAGES.channels}>
      <ChannelsSettings businessId={businessId} />
    </Messages>
  )
}
