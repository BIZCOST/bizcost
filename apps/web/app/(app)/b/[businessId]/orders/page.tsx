import type { Metadata } from 'next'
import { OrdersPage } from '@/features/orders/orders-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('orders') ? 'common.nav.orders' : 'notFound.title') }
}

export default function Page() {
  return <OrdersPage />
}
