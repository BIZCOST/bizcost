import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getT } from '@/lib/i18n/server'

// The title of the "Page not found" state (a not-found file inside the app sets none).
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('notFound.title') }
}

// Any other address inside Settings: "Page not found" inside the shell ([businessId]/not-found.tsx).
export default function Page() {
  notFound()
}
