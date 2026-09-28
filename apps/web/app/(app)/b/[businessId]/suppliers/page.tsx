import type { Metadata } from 'next'
import { SuppliersPage } from '@/features/purchasing/suppliers-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('suppliers') ? 'common.nav.suppliers' : 'notFound.title') }
}

export default function Page() {
  return <SuppliersPage />
}
