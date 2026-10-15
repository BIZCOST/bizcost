import { isUuid } from '@bizcost/domain'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ChannelStatements } from '@/features/settings/channel-statements'
import { Messages } from '@/lib/i18n/messages'
import { SETTINGS_SECTION_MESSAGES } from '@/lib/i18n/route-messages'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

// A sales channel's statements (M3 Step 4; Q8): Settings → Sales channels → a channel. Part of Sales,
// so the page exists only while that module is served on this server (the dev-only preview until
// Release A, D-125).

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return {
    title: t(isModuleServed('sales') ? 'settings.channels.statements.title' : 'notFound.title'),
  }
}

export default async function Page({
  params,
}: {
  params: Promise<{ businessId: string; channelId: string }>
}) {
  if (!isModuleServed('sales')) notFound()
  const { businessId, channelId } = await params
  if (!isUuid(channelId)) notFound()
  return (
    <Messages specs={SETTINGS_SECTION_MESSAGES.channels}>
      <ChannelStatements businessId={businessId} channelId={channelId.toLowerCase()} />
    </Messages>
  )
}
