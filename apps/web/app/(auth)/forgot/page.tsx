import type { Metadata } from 'next'
import { ForgotForm } from '@/features/auth/forgot-form'
import { getT } from '@/lib/i18n/server'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('auth.forgot.title') }
}

export default function Page() {
  return <ForgotForm />
}
