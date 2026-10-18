import { isUuid } from '@bizcost/domain'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { QuotationPage } from '@/features/quotations/quotation-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return {
    title: t(
      isModuleServed('quotations') ? 'documents.quotations.view.pageTitle' : 'notFound.title',
    ),
  }
}

export default async function Page({ params }: { params: Promise<{ quotationId: string }> }) {
  const { quotationId } = await params
  if (!isUuid(quotationId)) notFound()
  return <QuotationPage quotationId={quotationId.toLowerCase()} />
}
