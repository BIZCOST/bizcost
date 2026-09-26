import type { ReactNode } from 'react'
import { SettingsShell } from '@/features/settings/settings-shell'
import { Messages } from '@/lib/i18n/messages'
import { SETTINGS_MESSAGES } from '@/lib/i18n/route-messages'

// Settings of one business (ROADMAP.md Step 6), inside the app shell (Step 7): the section list and
// the settings' messages, for the pages and for their loading state.
export default async function SettingsLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ businessId: string }>
}) {
  const { businessId } = await params
  return (
    <Messages specs={SETTINGS_MESSAGES}>
      <SettingsShell businessId={businessId}>{children}</SettingsShell>
    </Messages>
  )
}
