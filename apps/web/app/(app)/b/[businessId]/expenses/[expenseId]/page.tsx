import { isUuid } from '@bizcost/domain'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ExpensePage } from '@/features/expenses/expense-page'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('expenses') ? 'expenses.view.pageTitle' : 'notFound.title') }
}

export default async function Page({ params }: { params: Promise<{ expenseId: string }> }) {
  const { expenseId } = await params
  if (!isUuid(expenseId)) notFound()
  return <ExpensePage expenseId={expenseId.toLowerCase()} />
}
