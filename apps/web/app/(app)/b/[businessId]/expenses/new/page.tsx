import type { Metadata } from 'next'
import { NewExpensePage } from '@/features/expenses/expense-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('expenses') ? 'expenses.editor.newTitle' : 'notFound.title') }
}

export default function Page() {
  return <NewExpensePage />
}
