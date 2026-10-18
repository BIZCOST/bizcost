import type { Metadata } from 'next'
import { NewQuotationPage } from '@/features/quotations/quotation-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return {
    title: t(
      isModuleServed('quotations') ? 'documents.quotations.editor.newTitle' : 'notFound.title',
    ),
  }
}

export default function Page() {
  return <NewQuotationPage />
}
