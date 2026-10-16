import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { Messages } from '@/lib/i18n/messages'
import { RECEIVABLES_MESSAGES } from '@/lib/i18n/route-messages'
import { isModuleServed } from '@/lib/trpc/server'

// What customers owe (M3 Step 5, the Payments module's page): it exists only while the module is
// released on this server (since Release A, M3 Step 6; before it only the dev-only preview, D-125);
// anywhere else the address is "Page not found", like any other.
export default function Layout({ children }: { children: ReactNode }) {
  if (!isModuleServed('payments')) notFound()
  return <Messages specs={RECEIVABLES_MESSAGES}>{children}</Messages>
}
