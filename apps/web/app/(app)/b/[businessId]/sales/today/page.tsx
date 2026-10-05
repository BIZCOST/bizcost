import type { Metadata } from 'next'
import { TodaySalesPage } from '@/features/sales/today-sales'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('sales') ? 'sales.sheet.title' : 'notFound.title') }
}

export default function Page() {
  return <TodaySalesPage />
}
