import type { Metadata } from 'next'
import { RunningCostsPage } from '@/features/expenses/running-costs-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return {
    title: t(isModuleServed('running_costs') ? 'common.nav.running_costs' : 'notFound.title'),
  }
}

export default function Page() {
  return <RunningCostsPage />
}
