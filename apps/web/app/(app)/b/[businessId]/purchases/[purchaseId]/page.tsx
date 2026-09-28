import { isUuid } from '@bizcost/domain'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { PurchasePage } from '@/features/purchasing/purchase-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('purchases') ? 'purchasing.view.pageTitle' : 'notFound.title') }
}

export default async function Page({ params }: { params: Promise<{ purchaseId: string }> }) {
  const { purchaseId } = await params
  if (!isUuid(purchaseId)) notFound()
  return <PurchasePage purchaseId={purchaseId.toLowerCase()} />
}
