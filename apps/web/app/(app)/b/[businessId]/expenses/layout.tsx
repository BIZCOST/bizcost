import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { Messages } from '@/lib/i18n/messages'
import { EXPENSES_MESSAGES } from '@/lib/i18n/route-messages'
import { isModuleServed } from '@/lib/trpc/server'

// Expenses (M2 Step 5): its pages exist only while the module is released on this server. Until M2
// Step 7 releases it, that is only the dev-only preview (D-125); anywhere else the address is "Page
// not found", like any other. The messages of the pages and of their loading state.
export default function Layout({ children }: { children: ReactNode }) {
  if (!isModuleServed('expenses')) notFound()
  return <Messages specs={EXPENSES_MESSAGES}>{children}</Messages>
}
