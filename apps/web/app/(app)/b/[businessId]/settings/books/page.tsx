import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { BooksSettings } from '@/features/settings/books-settings'
import { Messages } from '@/lib/i18n/messages'
import { SETTINGS_SECTION_MESSAGES } from '@/lib/i18n/route-messages'
import { getT } from '@/lib/i18n/server'
import { isModuleServed } from '@/lib/trpc/server'

// "Books closed up to" (M2 Step 3; D-114 rule 6, D-137): purchases and expenses obey it, so the page
// exists while either module is released on this server (until M2 Step 7, only the dev-only preview,
// D-125; D-176).

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT()
  const served = isModuleServed('purchases') || isModuleServed('expenses')
  return { title: t(served ? 'settings.books.title' : 'notFound.title') }
}

export default async function Page({ params }: { params: Promise<{ businessId: string }> }) {
  if (!isModuleServed('purchases') && !isModuleServed('expenses')) notFound()
  const { businessId } = await params
  return (
    <Messages specs={SETTINGS_SECTION_MESSAGES.books}>
      <BooksSettings businessId={businessId} />
    </Messages>
  )
}
