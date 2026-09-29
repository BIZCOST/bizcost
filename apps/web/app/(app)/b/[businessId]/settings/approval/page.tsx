import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ApprovalSettings } from '@/features/settings/approval-settings'
import { Messages } from '@/lib/i18n/messages'
import { SETTINGS_SECTION_MESSAGES } from '@/lib/i18n/route-messages'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

// Whether expenses need approval (M2 Step 5, D-164): part of the Expenses module, so the page exists
// only while that module is released on this server (until M2 Step 7, only the dev-only preview,
// D-125).

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('expenses') ? 'settings.approval.title' : 'notFound.title') }
}

export default async function Page({ params }: { params: Promise<{ businessId: string }> }) {
  if (!isModuleServed('expenses')) notFound()
  const { businessId } = await params
  return (
    <Messages specs={SETTINGS_SECTION_MESSAGES.approval}>
      <ApprovalSettings businessId={businessId} />
    </Messages>
  )
}
