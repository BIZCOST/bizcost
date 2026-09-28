import { CatalogLoading } from '@/features/catalog/catalog-loading'

/** While a page is on its way: the section's title and the list's placeholders. */
export default function Loading() {
  return <CatalogLoading titleKey="common.nav.purchases" />
}
