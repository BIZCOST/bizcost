import type { Metadata } from 'next'
import { RealProfitPage } from '@/features/reports/profit-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('reports') ? 'common.nav.real_profit' : 'notFound.title') }
}

/** Reports → Real profit (M3 Step 3; the dev-only preview until Release A). */
export default function Page() {
  return <RealProfitPage />
}
