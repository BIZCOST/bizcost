import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { Messages } from '@/lib/i18n/messages'
import { QUOTATIONS_MESSAGES } from '@/lib/i18n/route-messages'
import { isModuleServed } from '@/lib/trpc/server'

// Quotations (M3 Step 7): its pages exist only while the module is released on this server (since
// Release B, M3 Step 9; before it only the dev-only preview, D-125); anywhere else the address is
// "Page not found", like any other. The messages of the pages and of their loading state.
export default function Layout({ children }: { children: ReactNode }) {
  if (!isModuleServed('quotations')) notFound()
  return <Messages specs={QUOTATIONS_MESSAGES}>{children}</Messages>
}
