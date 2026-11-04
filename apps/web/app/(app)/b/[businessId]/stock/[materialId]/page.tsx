import { isUuid } from '@bizcost/domain'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { StockCardPage } from '@/features/stock/stock-card-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('inventory') ? 'stock.card.title' : 'notFound.title') }
}

export default async function Page({ params }: { params: Promise<{ materialId: string }> }) {
  const { materialId } = await params
  if (!isUuid(materialId)) notFound()
  return <StockCardPage materialId={materialId.toLowerCase()} />
}
