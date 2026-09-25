'use client'

import { ArrowRightIcon, CheckIcon } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { LogoMark } from '@/components/brand/logo'
import { isolate } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'

/** "Your BizCost is ready" (docs/PRODUCT.md §6.8), then on to the business. */
export function ReadyStep({ businessId, name }: { businessId: string; name: string }) {
  const { t } = useTranslation()
  const heading = useRef<HTMLHeadingElement>(null)
  // The page changed under the user's last click (Confirm): say where they are now.
  useEffect(() => heading.current?.focus(), [])
  return (
    <div className="mx-auto w-full max-w-xl px-4 py-10 sm:px-6 sm:py-16 lg:py-24">
      <section className="relative overflow-hidden rounded-3xl bg-card px-6 py-10 text-center shadow-sm ring-1 ring-foreground/[0.06] sm:px-12 sm:py-14">
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-28 bg-linear-to-b from-accent to-transparent"
        />
        <span className="relative mx-auto mb-7 flex size-20 items-center justify-center rounded-3xl bg-card shadow-md ring-1 ring-foreground/[0.06]">
          <LogoMark className="size-11" />
          <span className="absolute -end-2 -top-2 flex size-8 items-center justify-center rounded-full bg-success text-success-foreground shadow-sm ring-4 ring-card">
            <CheckIcon aria-hidden className="size-4.5" strokeWidth={3} />
          </span>
        </span>
        <h1
          ref={heading}
          tabIndex={-1}
          className="relative text-2xl font-semibold tracking-tight outline-none sm:text-3xl"
        >
          {t('setup.ready.title')}
        </h1>
        <p className="relative mx-auto mt-3 max-w-sm leading-relaxed text-muted-foreground">
          {t('setup.ready.body', { businessName: isolate(name) })}
        </p>
        <Button asChild size="lg" className="relative mt-8 w-full sm:w-auto sm:min-w-48">
          <Link href={`/b/${businessId}`}>
            {t('setup.ready.go')}
            <ArrowRightIcon aria-hidden className="rtl:rotate-180" />
          </Link>
        </Button>
      </section>
    </div>
  )
}
