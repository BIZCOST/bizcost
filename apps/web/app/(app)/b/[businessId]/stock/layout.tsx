import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { Messages } from '@/lib/i18n/messages'
import { STOCK_MESSAGES } from '@/lib/i18n/route-messages'
import { isModuleServed } from '@/lib/trpc/server'

// Stock: on hand, counts and stock cards (M4 Step 2): its pages exist only while the module is
// released on this server. Until Release A of M4 (Step 5) releases it, that is only the dev-only
// preview (D-125); anywhere else the address is "Page not found", like any other. The messages of the
// pages and of their loading state.
export default function Layout({ children }: { children: ReactNode }) {
  if (!isModuleServed('inventory')) notFound()
  return <Messages specs={STOCK_MESSAGES}>{children}</Messages>
}
