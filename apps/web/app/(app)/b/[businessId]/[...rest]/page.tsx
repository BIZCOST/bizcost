import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getT } from '@/lib/i18n/server'

// The title of the "Page not found" state (a not-found file inside the app sets none).
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('notFound.title') }
}

// Any other address inside a business (e.g. a module that is not released): "Page not found" inside
// the shell ([businessId]/not-found.tsx), not the app's bare one.
export default function Page() {
  notFound()
}
