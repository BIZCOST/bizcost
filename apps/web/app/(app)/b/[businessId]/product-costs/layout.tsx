import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { Messages } from '@/lib/i18n/messages'
import { PRODUCT_COSTS_MESSAGES } from '@/lib/i18n/route-messages'
import { isModuleServed } from '@/lib/trpc/server'

// Product costs (the Cost Engine, M2 Step 6): its pages exist only while the module is released on
// this server. Until M2 Step 7 releases it, that is only the dev-only preview (D-125); anywhere else
// the address is "Page not found". The messages of the pages and of their loading states.
export default function Layout({ children }: { children: ReactNode }) {
  if (!isModuleServed('cost_engine')) notFound()
  return <Messages specs={PRODUCT_COSTS_MESSAGES}>{children}</Messages>
}
