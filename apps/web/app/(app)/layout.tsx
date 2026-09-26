import type { ReactNode } from 'react'
import { LocaleSync, SessionEnded } from '@/components/app/session-sync'
import { getLocale } from '@/lib/i18n/server'
import { SessionProvider } from '@/lib/session'
import { sessionEmail } from '@/lib/supabase/server'
import { ApiProvider } from '@/lib/trpc/client'
import { getMe } from '@/lib/trpc/server'

// Signed-in pages. proxy.ts already sent signed-out visitors to /login; `me` is loaded here through
// the server caller (no HTTP hop) and handed to the client cache. The frame comes from below: the
// plain top bar outside a business ((main)/layout.tsx), the business shell inside one (D-089).

export default async function AppLayout({ children }: { children: ReactNode }) {
  const me = await getMe()
  if (!me) return <SessionEnded />
  const [locale, email] = await Promise.all([getLocale(), sessionEmail()])
  return (
    <ApiProvider me={me}>
      <SessionProvider email={email}>
        {me.profile.locale !== locale ? <LocaleSync locale={me.profile.locale} /> : null}
        {children}
      </SessionProvider>
    </ApiProvider>
  )
}
