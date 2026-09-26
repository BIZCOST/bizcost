import { CompassIcon } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { Logo } from '@/components/brand/logo'
import { LanguageMenu } from '@/components/language-menu'
import { PlainShell } from '@/components/shell/plain-shell'
import { StatePanel } from '@/components/states/state-panel'
import { Button } from '@/components/ui/button'
import { getT } from '@/lib/i18n/server'
import { SessionProvider } from '@/lib/session'
import { sessionEmail } from '@/lib/supabase/server'
import { ApiProvider } from '@/lib/trpc/client'
import { getMe } from '@/lib/trpc/server'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('notFound.title') }
}

async function signedInMe() {
  try {
    return await getMe()
  } catch {
    return null
  }
}

/**
 * An address that does not exist (a page inside a business has its own, inside the shell). Signed in:
 * under the plain top bar of the pages outside a business, with the account menu; otherwise the same
 * bar with the logo and the language.
 */
export default async function NotFound() {
  const [t, me] = await Promise.all([getT(), signedInMe()])
  const panel = (
    <StatePanel
      icon={CompassIcon}
      title={t('notFound.title')}
      body={t('notFound.body')}
      tone="accent"
      card={false}
      className="py-16"
    >
      <Button asChild size="lg">
        <Link href="/">{t('notFound.home')}</Link>
      </Button>
    </StatePanel>
  )
  if (me) {
    return (
      <ApiProvider me={me}>
        <SessionProvider email={await sessionEmail()}>
          <PlainShell>{panel}</PlainShell>
        </SessionProvider>
      </ApiProvider>
    )
  }
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b bg-card/90 backdrop-blur supports-backdrop-filter:bg-card/80">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-2 px-4 sm:gap-4 sm:px-6">
          <Link
            href="/"
            aria-label={t('brand.logoLabel')}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md"
          >
            <Logo />
          </Link>
          <LanguageMenu />
        </div>
      </header>
      <main className="flex-1">{panel}</main>
    </div>
  )
}
