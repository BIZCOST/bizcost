import { isUuid } from '@bizcost/domain'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { StatementPage } from '@/features/invoices/statement-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

// A customer's statement (M3 Step 8, Q27): since Release B (M3 Step 9) for every business with
// Customers and Payments on, orders-only ones included (B10); the page says so when the member may
// not see it.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return {
    title: t(
      isModuleServed('payments') ? 'documents.invoices.statement.pageTitle' : 'notFound.title',
    ),
  }
}

export default async function Page({ params }: { params: Promise<{ customerId: string }> }) {
  const { customerId } = await params
  if (!isUuid(customerId) || !isModuleServed('payments')) notFound()
  return <StatementPage customerId={customerId.toLowerCase()} />
}
