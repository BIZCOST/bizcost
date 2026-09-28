import type { Metadata } from 'next'
import { PurchasesPage } from '@/features/purchasing/purchases-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('purchases') ? 'common.nav.purchases' : 'notFound.title') }
}

export default function Page() {
  return <PurchasesPage />
}
