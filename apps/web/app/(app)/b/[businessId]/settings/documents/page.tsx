import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { DocumentsSettings } from '@/features/settings/documents-settings'
import { Messages } from '@/lib/i18n/messages'
import { SETTINGS_SECTION_MESSAGES } from '@/lib/i18n/route-messages'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

// Settings → Documents (M3 Step 7): numbers, the letterhead, the footer, the signature and the stamp.
// The page exists while Quotations or Invoices is served on this server (until Release B, M3 Step 9,
// only the dev-only preview, D-125).

const served = () => isModuleServed('quotations') || isModuleServed('invoices')

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(served() ? 'settings.documents.title' : 'notFound.title') }
}

export default async function Page({ params }: { params: Promise<{ businessId: string }> }) {
  if (!served()) notFound()
  const { businessId } = await params
  return (
    <Messages specs={SETTINGS_SECTION_MESSAGES.documents}>
      <DocumentsSettings businessId={businessId} />
    </Messages>
  )
}
