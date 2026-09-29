import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { Messages } from '@/lib/i18n/messages'
import { RUNNING_COSTS_MESSAGES } from '@/lib/i18n/route-messages'
import { isModuleServed } from '@/lib/trpc/server'

// Running Costs (M2 Step 5): its page exists only while the module is released on this server. Until
// M2 Step 7 releases it, that is only the dev-only preview (D-125); anywhere else the address is
// "Page not found". The messages of the page and of its loading state.
export default function Layout({ children }: { children: ReactNode }) {
  if (!isModuleServed('running_costs')) notFound()
  return <Messages specs={RUNNING_COSTS_MESSAGES}>{children}</Messages>
}
