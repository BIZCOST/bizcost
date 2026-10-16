import type { Metadata } from 'next'
import { CustomersPage } from '@/features/customers/customers-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

// "New customer", the "+" action of Customers (Release A, M3 Step 6): the list with a new customer's
// form open, as products/new (D-195). Closing the form leaves the list at its own address.

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('customers') ? 'common.nav.new_customer' : 'notFound.title') }
}

export default function Page() {
  return <CustomersPage startNew />
}
