import type { Metadata } from 'next'
import { InvoicesPage } from '@/features/invoices/invoices-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('invoices') ? 'common.nav.invoices' : 'notFound.title') }
}

export default function Page() {
  return <InvoicesPage />
}
