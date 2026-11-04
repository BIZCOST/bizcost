import type { Metadata } from 'next'
import { StockPage } from '@/features/stock/stock-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('inventory') ? 'common.nav.stock' : 'notFound.title') }
}

export default function Page() {
  return <StockPage />
}
