'use client'

import { ChevronDownIcon } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Parts of the review ("Here's your BizCost"), shared with Settings → Customize BizCost, which lists the
// same sections with the same switches.

/**
 * The names of sections, as chips. `soon`: those not released yet, muted and tagged ("soon"), as
 * their rows are (Customize BizCost, D-200).
 */
export function Chips({
  labels,
  soon,
}: {
  labels: readonly string[]
  soon?: { readonly labels: ReadonlySet<string>; readonly tag: string }
}) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {labels.map((label) => {
        const later = soon?.labels.has(label) === true
        return (
          <li
            key={label}
            data-soon={later || undefined}
            className={cn(
              'rounded-full px-2.5 py-0.5 text-[0.8125rem] leading-6',
              later
                ? 'text-muted-foreground ring-1 ring-foreground/10 ring-inset'
                : 'bg-muted text-foreground',
            )}
          >
            {label}
            {later ? <span className="ms-1.5 text-xs">· {soon?.tag}</span> : null}
          </li>
        )
      })}
    </ul>
  )
}

export function Group({
  title,
  action,
  children,
  bodyId,
}: {
  title: ReactNode
  action?: ReactNode
  children: ReactNode
  bodyId?: string
}) {
  const id = useId()
  return (
    <section
      aria-labelledby={id}
      className="rounded-2xl bg-card p-5 shadow-sm ring-1 ring-foreground/[0.06] sm:p-6"
    >
      <div className="flex min-h-11 items-center justify-between gap-3">
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        {action}
      </div>
      <div id={bodyId}>{children}</div>
    </section>
  )
}

export function ShowHide({
  open,
  controls,
  onToggle,
}: {
  open: boolean
  controls: string
  onToggle: () => void
}) {
  const { t } = useTranslation()
  return (
    <Button
      type="button"
      variant="ghost"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className="-me-2 shrink-0 text-primary hover:text-primary"
    >
      {open ? t('setup.review.hide') : t('setup.review.show')}
      <ChevronDownIcon aria-hidden className={cn('transition-transform', open && 'rotate-180')} />
    </Button>
  )
}
