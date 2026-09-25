import type { ReactNode } from 'react'
import { AuthShell } from '@/components/auth/auth-shell'
import { getT } from '@/lib/i18n/server'

export default async function AuthLayout({ children }: { children: ReactNode }) {
  return <AuthShell t={await getT()}>{children}</AuthShell>
}
