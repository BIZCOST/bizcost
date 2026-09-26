import type { Metadata } from 'next'
import { AccountView } from '@/features/account/account-view'
import { Messages } from '@/lib/i18n/messages'
import { ACCOUNT_MESSAGES } from '@/lib/i18n/route-messages'
import { getT } from '@/lib/i18n/server'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('account.title') }
}

export default function AccountPage() {
  return (
    <Messages specs={ACCOUNT_MESSAGES}>
      <AccountView />
    </Messages>
  )
}
