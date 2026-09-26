import type { ReactNode } from 'react'
import { PlainShell } from '@/components/shell/plain-shell'

/** Signed-in pages outside a business: home, the account and Smart Setup. */
export default function MainLayout({ children }: { children: ReactNode }) {
  return <PlainShell>{children}</PlainShell>
}
