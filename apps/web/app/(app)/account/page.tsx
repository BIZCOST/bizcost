import type { Metadata } from 'next'
import { AccountView } from '@/features/account/account-view'
import { getT } from '@/lib/i18n/server'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('account.title') }
}

export default function AccountPage() {
  return <AccountView />
}
