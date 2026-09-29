import type { Metadata } from 'next'
import { PayablesPage } from '@/features/purchasing/payables-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  const served = isModuleServed('purchases') || isModuleServed('expenses')
  return { title: t(served ? 'common.nav.payables' : 'notFound.title') }
}

export default function Page() {
  return <PayablesPage />
}
