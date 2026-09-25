import type { Metadata } from 'next'
import { LoginForm } from '@/features/auth/login-form'
import { parseNotice } from '@/features/auth/notices'
import { getT } from '@/lib/i18n/server'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('auth.login.title') }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { notice } = await searchParams
  return <LoginForm notice={parseNotice(notice)} />
}
