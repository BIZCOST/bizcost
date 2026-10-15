import { isUuid } from '@bizcost/domain'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { OrderPage } from '@/features/orders/order-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('orders') ? 'orders.editor.pageTitle' : 'notFound.title') }
}

/** A pending order changed (an order that no longer waits shows as it is). */
export default async function Page({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params
  if (!isUuid(orderId)) notFound()
  return <OrderPage orderId={orderId.toLowerCase()} edit />
}
