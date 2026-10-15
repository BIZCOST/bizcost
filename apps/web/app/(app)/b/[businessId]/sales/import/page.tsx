import type { Metadata } from 'next'
import { NewImportPage } from '@/features/sales/import/import-new'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

// Import sales from a file (M3 Step 4): the file, its columns, its days and the VAT question. The file
// is read in the browser (its library loads only here) and never uploaded.

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('sales') ? 'sales.import.title' : 'notFound.title') }
}

export default function Page() {
  return <NewImportPage />
}
