'use client'

import { apiErrorCode, useTRPC } from '@bizcost/app-core'
import { useQuery } from '@tanstack/react-query'
import { LockKeyholeIcon, SearchXIcon } from 'lucide-react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ModuleGate } from '@/components/shell/module-gate'
import { PageContainer } from '@/components/shell/page-container'
import { LoadError, SectionSkeleton } from '@/components/states/query-state'
import { StatePanel } from '@/components/states/state-panel'
import { Button } from '@/components/ui/button'
import { can } from '@/features/settings/sections'
import { useBusinessContext } from '@/lib/trpc/client'
import { ExpenseEditor } from './expense-editor'
import { ExpenseView } from './expense-view'

// An expense's page (M2 Step 5): a draft opens in the editor for members who may enter expenses (and
// may see its amounts: a draft saved back without them would lose them), and so does a rejected
// expense for the one who entered it; anyone else sees a rejected expense as it was recorded, with
// "Edit" when they may fix it (the reviewer who rejected it stays on it). Anything else is shown as it
// was recorded, with the actions the member may take.

/** An expense page on its way (also its loading.tsx). */
export function ExpenseLoading() {
  return (
    <PageContainer>
      <SectionSkeleton cards={3} />
    </PageContainer>
  )
}

function BackToList() {
  const { t } = useTranslation()
  const { businessId } = useParams<{ businessId: string }>()
  return (
    <Button asChild variant="outline" size="lg">
      <Link href={`/b/${businessId}/expenses`}>
        {t('states.goTo', { section: t('common.nav.expenses') })}
      </Link>
    </Button>
  )
}

/** Today and the books-closed date (every expense page needs them). */
function useBooks() {
  const trpc = useTRPC()
  return useQuery(trpc.books.get.queryOptions())
}

function NewExpense() {
  const { t } = useTranslation()
  const { data: context } = useBusinessContext()
  const books = useBooks()
  if (!context) return null
  if (!can(context, 'expenses.documents.manage')) {
    return (
      <PageContainer>
        <StatePanel
          icon={LockKeyholeIcon}
          title={t('states.forbidden.title')}
          body={t('states.forbidden.body')}
          documentTitle={`${t('states.forbidden.title')} · ${t('appName')}`}
        >
          <BackToList />
        </StatePanel>
      </PageContainer>
    )
  }
  if (books.isError) {
    return (
      <PageContainer>
        <LoadError error={books.error} onRetry={() => void books.refetch()} />
      </PageContainer>
    )
  }
  if (!books.data) return <ExpenseLoading />
  return <ExpenseEditor today={books.data.today} closedThrough={books.data.closedThrough} />
}

function OneExpense({ expenseId }: { expenseId: string }) {
  const { t } = useTranslation()
  const trpc = useTRPC()
  const { data: context } = useBusinessContext()
  const books = useBooks()
  const expense = useQuery(trpc.expense.get.queryOptions({ id: expenseId }))
  const canManage = context !== undefined && can(context, 'expenses.documents.manage')
  // Who is reading (`isMe` among the members who may have paid): a rejected expense opens in the
  // editor only for the one who entered it. Read ahead, so a rejection does not wait for it.
  const payers = useQuery({
    ...trpc.expense.payers.queryOptions(),
    staleTime: 60_000,
    enabled: canManage,
  })
  const [editing, setEditing] = useState(false)
  if (!context) return null
  if (expense.isError && apiErrorCode(expense.error) === 'not_found') {
    return (
      <PageContainer>
        <StatePanel
          icon={SearchXIcon}
          title={t('expenses.view.notFound')}
          body={t('expenses.view.notFoundBody')}
          documentTitle={`${t('expenses.view.notFound')} · ${t('appName')}`}
        >
          <BackToList />
        </StatePanel>
      </PageContainer>
    )
  }
  const error = expense.error ?? books.error
  if (error && (!expense.data || !books.data)) {
    return (
      <PageContainer>
        <LoadError
          error={error}
          onRetry={() => {
            void expense.refetch()
            void books.refetch()
          }}
        />
      </PageContainer>
    )
  }
  if (!expense.data || !books.data) return <ExpenseLoading />
  const result = expense.data
  const status = result.data.status
  const canEdit =
    (status === 'draft' || status === 'rejected') && canManage && result.meta.redacted.length === 0
  if (canEdit && status === 'rejected' && payers.isPending) return <ExpenseLoading />
  const me = payers.data?.items.find((payer) => payer.isMe)
  const mine = me === undefined ? undefined : me.memberId === result.data.createdBy.memberId
  if (canEdit && (status === 'draft' || mine === true || editing)) {
    return (
      <ExpenseEditor
        key={result.data.id}
        expense={result.data}
        mine={mine !== false}
        today={books.data.today}
        closedThrough={books.data.closedThrough}
      />
    )
  }
  return (
    <ExpenseView
      result={result}
      mine={mine}
      onEdit={canEdit ? () => setEditing(true) : undefined}
      today={books.data.today}
      closedThrough={books.data.closedThrough}
    />
  )
}

/** A new expense, inside the module's gate. */
export function NewExpensePage() {
  return (
    <ModuleGate moduleId="expenses" entryId="expenses">
      <NewExpense />
    </ModuleGate>
  )
}

/** One expense, inside the module's gate. */
export function ExpensePage({ expenseId }: { expenseId: string }) {
  return (
    <ModuleGate moduleId="expenses" entryId="expenses">
      <OneExpense expenseId={expenseId} />
    </ModuleGate>
  )
}
