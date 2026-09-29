import { isUuid } from '@bizcost/domain'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ProductCostPage } from '@/features/costing/product-cost-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return {
    title: t(isModuleServed('cost_engine') ? 'costing.detail.pageTitle' : 'notFound.title'),
  }
}

export default async function Page({ params }: { params: Promise<{ productId: string }> }) {
  const { productId } = await params
  if (!isUuid(productId)) notFound()
  return <ProductCostPage productId={productId.toLowerCase()} />
}
