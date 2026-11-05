import type { Metadata } from 'next'
import { PRIVACY } from '@/features/legal/content'
import { LegalPage } from '@/features/legal/legal-page'
import { getT } from '@/lib/i18n/server'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('legal.privacy.title') }
}

export default function Page() {
  return <LegalPage document={PRIVACY} other="terms" />
}
