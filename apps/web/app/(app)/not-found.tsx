import { CompassIcon } from 'lucide-react'
import type { Metadata } from 'next'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { getT } from '@/lib/i18n/server'

// "Not found" inside the signed-in pages: the (app) layout already shows the app header, so this one
// has only the message (the root not-found page brings its own header for pages outside the app).

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getT())('notFound.title') }
}

export default async function AppNotFound() {
  const t = await getT()
  return (
    <div className="flex flex-col items-center justify-center gap-6 px-4 py-16 text-center">
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
    </div>
  )
}
