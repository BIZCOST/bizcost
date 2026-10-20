import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { Messages } from '@/lib/i18n/messages'
import { INVOICES_MESSAGES } from '@/lib/i18n/route-messages'
import { isModuleServed } from '@/lib/trpc/server'

// Invoices (M3 Step 8): its pages exist only while the module is served on this server (until Release
// B, M3 Step 9, only the dev-only preview, D-125); anywhere else the address is "Page not found", like
// any other. The messages of the pages and of their loading state.
export default function Layout({ children }: { children: ReactNode }) {
  if (!isModuleServed('invoices')) notFound()
  return <Messages specs={INVOICES_MESSAGES}>{children}</Messages>
}
