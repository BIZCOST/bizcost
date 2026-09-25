import type { Metadata } from 'next'
import { SetupView } from '@/features/setup/setup-view'
import { getT } from '@/lib/i18n/server'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('setup.title') }
}

/** Smart Setup (docs/PRODUCT.md §6). `?done=<businessId>` is its last screen, "Your BizCost is ready". */
export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { done } = await searchParams
  return <SetupView done={typeof done === 'string' ? done : null} />
}
