import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { PlatformView } from '@/features/platform/platform-view'
import { Messages } from '@/lib/i18n/messages'
import { PLATFORM_MESSAGES } from '@/lib/i18n/route-messages'
import { getT } from '@/lib/i18n/server'
import { getMe } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const [t, me] = await Promise.all([getT(), getMe()])
  return { title: t(me?.isPlatformAdmin ? 'platform.title' : 'notFound.title') }
}

/**
 * The owner's beta page (D-357): the beta list and the feedback. For a platform admin only, by the
 * server's list (BIZCOST_PLATFORM_ADMINS): for anyone else this address does not exist. Every procedure
 * it calls checks the same.
 */
export default async function PlatformPage() {
  const me = await getMe()
  if (!me?.isPlatformAdmin) notFound()
  return (
    <Messages specs={PLATFORM_MESSAGES}>
      <PlatformView />
    </Messages>
  )
}
