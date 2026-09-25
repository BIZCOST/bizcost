import type { Metadata } from 'next'
import { SignupForm } from '@/features/auth/signup-form'
import { getT } from '@/lib/i18n/server'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('auth.signup.title') }
}

export default function Page() {
  return <SignupForm />
}
