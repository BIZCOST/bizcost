import type { Metadata } from 'next'
import { ProductCostsPage } from '@/features/costing/product-costs-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return {
    title: t(isModuleServed('cost_engine') ? 'common.nav.product_costs' : 'notFound.title'),
  }
}

export default function Page() {
  return <ProductCostsPage />
}
