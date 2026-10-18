import type { Metadata } from 'next'
import { QuotationsPage } from '@/features/quotations/quotations-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('quotations') ? 'common.nav.quotations' : 'notFound.title') }
}

export default function Page() {
  return <QuotationsPage />
}
