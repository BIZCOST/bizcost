import type { Metadata } from 'next'
import { ResetForm } from '@/features/auth/reset-form'
import { getT } from '@/lib/i18n/server'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('auth.forgot.title') }
}

export default function Page() {
  return <ResetForm />
}
