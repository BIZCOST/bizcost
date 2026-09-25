import { CompassIcon } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { Logo } from '@/components/brand/logo'
import { LanguageMenu } from '@/components/language-menu'
import { Button } from '@/components/ui/button'
import { getT } from '@/lib/i18n/server'

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('notFound.title') }
}

export default async function NotFound() {
  const t = await getT()
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center justify-between gap-4 px-4 pt-4 sm:px-8 sm:pt-6">
        <Link href="/" aria-label={t('brand.logoLabel')} className="rounded-md">
          <Logo />
        </Link>
        <LanguageMenu />
      </header>
      <main className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-12 text-center">
        <span className="flex size-14 items-center justify-center rounded-2xl bg-accent text-primary">
          <CompassIcon aria-hidden className="size-7" />
        </span>
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">{t('notFound.title')}</h1>
          <p className="text-muted-foreground">{t('notFound.body')}</p>
        </div>
        <Button asChild size="lg">
          <Link href="/">{t('notFound.home')}</Link>
        </Button>
      </main>
    </div>
  )
}
