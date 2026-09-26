import type { ReactNode } from 'react'
import { AuthShell } from '@/components/auth/auth-shell'
import { Messages } from '@/lib/i18n/messages'
import { AUTH_MESSAGES } from '@/lib/i18n/route-messages'
import { getT } from '@/lib/i18n/server'

export default async function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <Messages specs={AUTH_MESSAGES}>
      <AuthShell t={await getT()}>{children}</AuthShell>
    </Messages>
  )
}
