import type { Metadata } from 'next'
import { NewOrderPage } from '@/features/orders/order-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('orders') ? 'common.nav.new_order' : 'notFound.title') }
}

export default function Page() {
  return <NewOrderPage />
}
