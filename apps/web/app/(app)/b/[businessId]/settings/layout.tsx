import type { ReactNode } from 'react'
import { SettingsShell } from '@/features/settings/settings-shell'

// Settings of one business (ROADMAP.md Step 6): their own layout until the app shell (Step 7).
export default async function SettingsLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ businessId: string }>
}) {
  const { businessId } = await params
  return <SettingsShell businessId={businessId}>{children}</SettingsShell>
}
