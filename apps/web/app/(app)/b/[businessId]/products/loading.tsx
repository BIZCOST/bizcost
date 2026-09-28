import { CatalogLoading } from '@/features/catalog/catalog-loading'

/** While the page is on its way: its title and the list's placeholders. */
export default function Loading() {
  return <CatalogLoading titleKey="common.nav.products" />
}
