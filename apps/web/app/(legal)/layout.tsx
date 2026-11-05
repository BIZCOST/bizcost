import Link from 'next/link'
import type { ReactNode } from 'react'
import { Logo } from '@/components/brand/logo'
import { LanguageMenu } from '@/components/language-menu'
import { getT } from '@/lib/i18n/server'

/** The privacy policy and the terms (D-358): open to everyone, signed in or not. */
export default async function LegalLayout({ children }: { children: ReactNode }) {
  const t = await getT()
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="sticky top-0 z-40 border-b bg-card/90 backdrop-blur supports-backdrop-filter:bg-card/80">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link
            href="/"
            aria-label={t('brand.logoLabel')}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md"
          >
            <Logo />
          </Link>
          <LanguageMenu />
        </div>
      </header>
      <main id="main" className="flex-1">
        {children}
      </main>
    </div>
  )
}
