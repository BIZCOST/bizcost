import type { Metadata } from 'next'
import { CountsPage } from '@/features/stock/counts-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('inventory') ? 'stock.tabs.counts' : 'notFound.title') }
}

export default function Page() {
  return <CountsPage />
}
