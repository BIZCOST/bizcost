import { isUuid } from '@bizcost/domain'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { CountReviewPage } from '@/features/stock/count-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('inventory') ? 'stock.review.title' : 'notFound.title') }
}

export default async function Page({ params }: { params: Promise<{ countId: string }> }) {
  const { countId } = await params
  if (!isUuid(countId)) notFound()
  return <CountReviewPage countId={countId.toLowerCase()} />
}
