import { isUuid } from '@bizcost/domain'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ImportViewPage } from '@/features/sales/import/import-view'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

// An import (M3 Step 4): a draft's names and preview, then «اعتمد نهائيًا»; a finalized one's days.

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  return { title: t(isModuleServed('sales') ? 'sales.import.pageTitle' : 'notFound.title') }
}

export default async function Page({ params }: { params: Promise<{ importId: string }> }) {
  const { importId } = await params
  if (!isUuid(importId)) notFound()
  return <ImportViewPage importId={importId.toLowerCase()} />
}
