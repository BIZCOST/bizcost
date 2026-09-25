'use client'

import { CheckIcon, XIcon } from 'lucide-react'
import Link from 'next/link'
import { useTranslation } from 'react-i18next'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import type { SetupStep } from './draft'
import type { SideStep } from './flow'

/**
 * Desktop (≥1024px): the steps beside the question — Name, the counted questions, Review. Answered
 * steps can be reopened.
 */
export function SideSteps({
  steps,
  onOpen,
}: {
  steps: readonly SideStep[]
  onOpen: (step: SetupStep) => void
}) {
  const { t } = useTranslation()
  return (
    <nav aria-label={t('setup.title')} className="hidden lg:block">
      <div className="sticky top-24 rounded-2xl bg-card p-3 shadow-sm ring-1 ring-foreground/[0.06]">
        <p className="px-3 pt-2 pb-3 text-sm font-semibold">{t('setup.title')}</p>
        <ol className="space-y-0.5">
          {steps.map((s) => {
            const content = (
              <>
                <span
                  aria-hidden
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
                    s.current
                      ? 'border-primary bg-card'
                      : s.done
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input/50 bg-card',
                  )}
                >
                  {s.current ? (
                    <span className="size-2 rounded-full bg-primary" />
                  ) : s.done ? (
                    <CheckIcon className="size-3.5" strokeWidth={3} />
                  ) : null}
                </span>
                <span className="min-w-0 truncate">{t(s.labelKey)}</span>
                {s.done && !s.current ? (
                  <span className="sr-only">{t('setup.wizard.answered')}</span>
                ) : null}
              </>
            )
            const row = 'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-start text-sm'
            return (
              <li key={s.step}>
                {s.canOpen ? (
                  <button
                    type="button"
                    onClick={() => onOpen(s.step)}
                    className={cn(
                      row,
                      'text-foreground hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none',
                    )}
                  >
                    {content}
                  </button>
                ) : (
                  <div
                    aria-current={s.current ? 'step' : undefined}
                    className={cn(
                      row,
                      s.current
                        ? 'bg-accent font-medium text-accent-foreground'
                        : 'text-muted-foreground',
                    )}
                  >
                    {content}
                  </div>
                )}
              </li>
            )
          })}
        </ol>
        <Separator className="my-3" />
        <Link
          href="/"
          className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <XIcon aria-hidden className="size-4" />
          {t('setup.wizard.exit')}
        </Link>
      </div>
    </nav>
  )
}
