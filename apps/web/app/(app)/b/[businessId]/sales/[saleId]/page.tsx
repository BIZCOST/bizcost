import { isUuid } from '@bizcost/domain'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { SalePage } from '@/features/sales/sale-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('sales') ? 'sales.view.pageTitle' : 'notFound.title') }
}

export default async function Page({ params }: { params: Promise<{ saleId: string }> }) {
  const { saleId } = await params
  if (!isUuid(saleId)) notFound()
  return <SalePage saleId={saleId.toLowerCase()} />
}
