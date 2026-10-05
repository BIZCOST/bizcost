import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { Messages } from '@/lib/i18n/messages'
import { REPORTS_MESSAGES } from '@/lib/i18n/route-messages'
import { isModuleServed } from '@/lib/trpc/server'

// Reports (M3 Step 3): its pages exist only while the module is released on this server. Until Release
// A (M3 Step 6) that is only the dev-only preview (D-125); anywhere else the address is "Page not
// found", like any other. The messages of the pages and of their loading state.
export default function Layout({ children }: { children: ReactNode }) {
  if (!isModuleServed('reports')) notFound()
  return <Messages specs={REPORTS_MESSAGES}>{children}</Messages>
}
