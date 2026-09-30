import { isUuid } from '@bizcost/domain'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { MemberAccess } from '@/features/settings/member-access'
import { Messages } from '@/lib/i18n/messages'
import { MEMBER_ACCESS_MESSAGES } from '@/lib/i18n/route-messages'
import { getT } from '@/lib/i18n/server'

// A member's own permissions (M2 Step 7, D-191): Settings → Team → a member → Permissions.

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('settings.members.access') }
}

export default async function Page({
  params,
}: {
  params: Promise<{ businessId: string; memberId: string }>
}) {
  const { businessId, memberId } = await params
  if (!isUuid(memberId)) notFound()
  return (
    <Messages specs={MEMBER_ACCESS_MESSAGES}>
      <MemberAccess businessId={businessId} memberId={memberId.toLowerCase()} />
    </Messages>
  )
}
