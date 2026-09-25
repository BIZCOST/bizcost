import type { Metadata } from 'next'
import { InviteView } from '@/features/invite/invite-view'
import { getT } from '@/lib/i18n/server'
import { sessionEmail } from '@/lib/supabase/server'
import { ApiProvider } from '@/lib/trpc/client'

export async function generateMetadata(): Promise<Metadata> {
  // The token stays out of the title and the history's page names.
  return { title: (await getT())('auth.invite.pageTitle'), referrer: 'no-referrer' }
}

/**
 * An invitation link (ROADMAP.md Step 6), open signed in or not (proxy.ts). The session's email only
 * decides what the page offers; the API checks the invited, verified email on accept.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const [{ token }, email] = await Promise.all([params, sessionEmail()])
  return (
    <ApiProvider>
      <InviteView token={token} email={email} />
    </ApiProvider>
  )
}
