import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { Messages } from '@/lib/i18n/messages'
import { PURCHASES_MESSAGES } from '@/lib/i18n/route-messages'
import { isModuleServed } from '@/lib/trpc/server'

// Amounts owed (the owner's request of 2026-09-29): a page of Purchases and of Expenses (D-166), so it
// exists while either is released on this server (until M2 Step 7, the dev-only preview, D-125);
// anywhere else the address is "Page not found". The purchasing messages (the payment sheet too).
export default function Layout({ children }: { children: ReactNode }) {
  if (!isModuleServed('purchases') && !isModuleServed('expenses')) notFound()
  return <Messages specs={PURCHASES_MESSAGES}>{children}</Messages>
}
