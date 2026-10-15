import { isUuid } from '@bizcost/domain'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { CustomerPage } from '@/features/customers/customer-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return {
    title: t(isModuleServed('customers') ? 'orders.customers.page.pageTitle' : 'notFound.title'),
  }
}

export default async function Page({ params }: { params: Promise<{ customerId: string }> }) {
  const { customerId } = await params
  if (!isUuid(customerId)) notFound()
  return <CustomerPage customerId={customerId.toLowerCase()} />
}
