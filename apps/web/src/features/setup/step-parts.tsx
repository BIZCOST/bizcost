'use client'

import { ArrowLeftIcon, ArrowRightIcon } from 'lucide-react'
import type { ReactNode, Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Building blocks shared by the Smart Setup steps.

/**
 * The white card a step's content sits in. On phones the content sits on the page itself, so the
 * option cards get the full width.
 */
export function StepCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={cn(
        'sm:rounded-2xl sm:bg-card sm:p-8 sm:shadow-sm sm:ring-1 sm:ring-foreground/[0.06]',
        className,
      )}
    >
      {children}
    </section>
  )
}

/**
 * The step's heading. It takes the focus on every step change (docs/PRODUCT.md §6.3), so screen
 * readers read the new question first.
 */
export function StepHeading({
  id,
  headingRef,
  describedBy,
  children,
}: {
  id?: string
  headingRef: Ref<HTMLHeadingElement>
  /** E.g. PROGRESS_ID, so "Question n of m" is read with the question when it takes the focus. */
  describedBy?: string
  children: ReactNode
}) {
  return (
    <h1
      id={id}
      ref={headingRef}
      tabIndex={-1}
      aria-describedby={describedBy}
      className="text-xl leading-snug font-semibold tracking-tight outline-none sm:text-2xl"
    >
      {children}
    </h1>
  )
}

/**
 * The step's buttons: a bar fixed to the bottom of the screen on phones and tablets (always within
 * reach of the thumb), under the card on desktop.
 */
export function ActionBar({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur supports-backdrop-filter:bg-card/85 sm:px-6 lg:static lg:mt-6 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none">
      {/* Wraps on very narrow phones rather than cutting a button off. */}
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-3 lg:max-w-none">
        {children}
      </div>
    </div>
  )
}

export function BackButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()
  return (
    <Button type="button" variant="outline" size="lg" onClick={onClick} className="px-4">
      <ArrowLeftIcon aria-hidden className="rtl:rotate-180" />
      {t('setup.wizard.back')}
    </Button>
  )
}

export function NextButton() {
  const { t } = useTranslation()
  return (
    <Button type="submit" size="lg" className="flex-1 sm:ms-auto sm:min-w-40 sm:flex-none">
      {t('setup.wizard.next')}
      <ArrowRightIcon aria-hidden className="rtl:rotate-180" />
    </Button>
  )
}

/** The id of the progress text; the question heading is described by it. */
export const PROGRESS_ID = 'setup-progress'

/**
 * "Question n of m" and a bar (the text is what screen readers get, with the question: the heading's
 * description).
 */
export function Progress({ n, m }: { n: number; m: number }) {
  const { t } = useTranslation()
  return (
    <div className="mb-4">
      <p id={PROGRESS_ID} className="text-sm font-medium text-muted-foreground tabular-nums">
        {t('setup.wizard.progress', { n, m })}
      </p>
      <div aria-hidden className="mt-2 h-1.5 overflow-hidden rounded-full bg-foreground/[0.07]">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300"
          style={{ width: `${m > 0 ? Math.round((n / m) * 100) : 0}%` }}
        />
      </div>
    </div>
  )
}
