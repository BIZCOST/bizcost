import type { Metadata } from 'next'
import { NewSalePage } from '@/features/sales/sale-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('sales') ? 'sales.editor.newTitle' : 'notFound.title') }
}

export default function Page() {
  return <NewSalePage />
}
