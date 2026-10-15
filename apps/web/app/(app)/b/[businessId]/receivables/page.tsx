import type { Metadata } from 'next'
import { ReceivablesPage } from '@/features/receivables/receivables-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('payments') ? 'common.nav.receivables' : 'notFound.title') }
}

export default function Page() {
  return <ReceivablesPage />
}
