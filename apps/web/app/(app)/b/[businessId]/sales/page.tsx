import type { Metadata } from 'next'
import { SalesPage } from '@/features/sales/sales-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('sales') ? 'common.nav.sales' : 'notFound.title') }
}

export default function Page() {
  return <SalesPage />
}
