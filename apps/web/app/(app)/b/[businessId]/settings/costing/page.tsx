import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { CostingSettings } from '@/features/settings/costing-settings'
import { Messages } from '@/lib/i18n/messages'
import { SETTINGS_SECTION_MESSAGES } from '@/lib/i18n/route-messages'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

// How product costs are worked out (M2 Step 6; D-116, D-119): part of the Cost Engine, so the page
// exists only while that module is released on this server (until M2 Step 7, only the dev-only
// preview, D-125).

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('cost_engine') ? 'settings.costing.title' : 'notFound.title') }
}

export default async function Page({ params }: { params: Promise<{ businessId: string }> }) {
  if (!isModuleServed('cost_engine')) notFound()
  const { businessId } = await params
  return (
    <Messages specs={SETTINGS_SECTION_MESSAGES.costing}>
      <CostingSettings businessId={businessId} />
    </Messages>
  )
}
