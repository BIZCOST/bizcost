import { isUuid } from '@bizcost/domain'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { InvoicePage } from '@/features/invoices/invoice-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return {
    title: t(isModuleServed('invoices') ? 'documents.invoices.editor.pageTitle' : 'notFound.title'),
  }
}

/** A draft changed (an issued invoice shows as it is). */
export default async function Page({ params }: { params: Promise<{ invoiceId: string }> }) {
  const { invoiceId } = await params
  if (!isUuid(invoiceId)) notFound()
  return <InvoicePage invoiceId={invoiceId.toLowerCase()} edit />
}
