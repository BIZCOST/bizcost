import type { Metadata } from 'next'
import { NewPurchasePage } from '@/features/purchasing/purchase-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('purchases') ? 'purchasing.editor.newTitle' : 'notFound.title') }
}

export default function Page() {
  return <NewPurchasePage />
}
