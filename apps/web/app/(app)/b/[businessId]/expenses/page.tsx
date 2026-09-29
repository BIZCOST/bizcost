import type { Metadata } from 'next'
import { ExpensesPage } from '@/features/expenses/expenses-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('expenses') ? 'common.nav.expenses' : 'notFound.title') }
}

export default function Page() {
  return <ExpensesPage />
}
