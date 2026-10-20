import type { Metadata } from 'next'
import { NewInvoicePage } from '@/features/invoices/invoice-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return {
    title: t(isModuleServed('invoices') ? 'documents.invoices.editor.newTitle' : 'notFound.title'),
  }
}

export default function Page() {
  return <NewInvoicePage />
}
