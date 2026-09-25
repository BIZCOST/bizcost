import type { Metadata } from 'next'
import { VerifyForm } from '@/features/auth/verify-form'
import { getT } from '@/lib/i18n/server'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('auth.verify.title') }
}

export default function Page() {
  return <VerifyForm />
}
