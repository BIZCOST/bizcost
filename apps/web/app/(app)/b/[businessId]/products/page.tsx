import { isUuid } from '@bizcost/domain'
import type { Metadata } from 'next'
import { ProductsPage } from '@/features/catalog/products-page'
import { getT, wordingKey } from '@/lib/i18n/server'
import { getBusinessContext, isModuleServed } from '@/lib/trpc/server'

/** The page's title in the business's wording (the section's name in the nav). */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ businessId: string }>
}): Promise<Metadata> {
  const [{ businessId }, t] = await Promise.all([params, getT()])
  if (!isModuleServed('products')) return { title: t('notFound.title') }
  const context = isUuid(businessId) ? await getBusinessContext(businessId) : null
  const profile = typeof context === 'object' && context ? context.terminologyProfile : null
  return { title: t(wordingKey('common.nav.products', profile)) }
}

export default function Page() {
  return <ProductsPage />
}
