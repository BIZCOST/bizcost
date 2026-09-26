'use client'

import type { ChecklistItemDto } from '@bizcost/contracts'
import { CheckIcon, ChevronRightIcon, PartyPopperIcon, XIcon } from 'lucide-react'
import Link from 'next/link'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { progressOf, stepView, type ChecklistStepView } from './checklist-steps'

// The Dashboard's getting-started checklist (docs/PRODUCT.md §10, D-090): the steps this member can
// act on, done or not from the business's real data, with "n of m done". Each open step links to the
// settings section where it is done.

const CARD = 'overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]'

function Step({ step }: { step: ChecklistStepView }) {
  const { t } = useTranslation()
  const Icon = step.icon
  return (
    <li
      data-step={step.id}
      data-done={step.done || undefined}
      className={cn(
        'relative flex items-center gap-4 px-5 py-4 sm:px-6',
        !step.done && 'transition-colors focus-within:bg-muted/50 hover:bg-muted/50',
      )}
    >
      {/* A done step is quiet (a light disc), so the open steps keep the eye. */}
      {step.done ? (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-success/10 text-success">
          <CheckIcon aria-hidden className="size-5" strokeWidth={2.5} />
        </span>
      ) : (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-primary">
          <Icon aria-hidden className="size-5" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        {step.done ? (
          <p className="font-medium text-muted-foreground">{t(step.titleKey)}</p>
        ) : (
          // The whole row opens the section; the link's name is the step's title.
          <Link
            href={step.href}
            className="font-semibold outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:rounded-none focus-visible:after:ring-3 focus-visible:after:ring-ring focus-visible:after:ring-inset"
          >
            {t(step.titleKey)}
          </Link>
        )}
        <p className="mt-0.5 text-sm leading-relaxed text-pretty text-muted-foreground">
          {t(step.bodyKey)}
        </p>
      </div>
      {step.done ? (
        // On the card's white: 5:1 for the small text (a tinted background would bring it under 4.5:1).
        <span className="shrink-0 rounded-full px-2.5 py-1 text-xs font-medium text-success ring-1 ring-success/30 ring-inset">
          {t('dashboard.checklist.done')}
        </span>
      ) : (
        <>
          <span
            aria-hidden
            className="hidden shrink-0 items-center rounded-lg border bg-background px-3 py-1.5 text-sm font-medium text-primary sm:inline-flex"
          >
            {t(step.actionKey)}
          </span>
          <ChevronRightIcon
            aria-hidden
            className="size-5 shrink-0 text-muted-foreground rtl:rotate-180 sm:hidden"
          />
        </>
      )}
    </li>
  )
}

function Header({ done, total }: { done: number; total: number }) {
  const { t } = useTranslation()
  const percent = total === 0 ? 0 : Math.round((done / total) * 100)
  return (
    <div className="border-b px-5 pt-5 pb-4 sm:px-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id="checklist-title" className="text-lg font-semibold tracking-tight">
            {t('dashboard.checklist.title')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('dashboard.checklist.description')}
          </p>
        </div>
        <p className="shrink-0 pt-1 text-sm font-medium text-primary tabular-nums">
          {t('dashboard.checklist.progress', { done, total })}
        </p>
      </div>
      <div
        role="progressbar"
        aria-label={t('dashboard.checklist.progressLabel')}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={t('dashboard.checklist.progress', { done, total })}
        className="mt-4 h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

/**
 * The checklist while its state loads (the Dashboard's loading state on a client navigation): the same
 * frame, one row per step the member will see, each as tall as a real step (a title and two or three
 * lines on phones, one or two beside the action from 640px), so the page does not move when it
 * arrives.
 */
export function ChecklistSkeleton({ steps, className }: { steps: number; className?: string }) {
  const { t } = useTranslation()
  return (
    <section aria-labelledby="checklist-title" aria-busy className={cn(CARD, className)}>
      <div className="border-b px-5 pt-5 pb-4 sm:px-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="checklist-title" className="text-lg font-semibold tracking-tight">
              {t('dashboard.checklist.title')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('dashboard.checklist.description')}
            </p>
          </div>
          <Skeleton className="mt-1.5 h-4 w-20 shrink-0" />
        </div>
        <Skeleton className="mt-4 h-2 w-full rounded-full" />
      </div>
      <p role="status" className="sr-only">
        {t('status.loading')}
      </p>
      <ul className="divide-y">
        {Array.from({ length: steps }, (_, index) => (
          <li
            key={index}
            className="flex min-h-[7.5rem] items-center gap-4 px-5 py-4 sm:min-h-[5.25rem] sm:px-6"
          >
            <Skeleton className="size-10 shrink-0 rounded-xl" />
            <div className="flex-1 space-y-2.5">
              <Skeleton className="h-4 w-48 max-w-full" />
              <Skeleton className="h-3.5 w-full max-w-sm" />
              <Skeleton className="h-3.5 w-2/3 sm:hidden" />
            </div>
            <Skeleton className="hidden h-8 w-28 shrink-0 rounded-lg sm:block" />
          </li>
        ))}
      </ul>
    </section>
  )
}

export function Checklist({
  businessId,
  items,
  className,
}: {
  businessId: string
  items: readonly ChecklistItemDto[]
  className?: string
}) {
  const { done, total } = progressOf(items)
  return (
    <section aria-labelledby="checklist-title" className={cn(CARD, className)}>
      <Header done={done} total={total} />
      <ul className="divide-y">
        {items.map((item) => (
          <Step key={item.id} step={stepView(businessId, item)} />
        ))}
      </ul>
    </section>
  )
}

/**
 * Every step is done: a compact card in the checklist's place, which the member can hide (the page
 * then moves the focus on, since the button goes away).
 */
export function AllSet({ onHide }: { onHide: () => void }) {
  const { t } = useTranslation()
  return (
    <section
      aria-labelledby="all-set-title"
      className={cn(CARD, 'flex items-center gap-4 px-5 py-4 sm:px-6')}
    >
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-success/10 text-success">
        <PartyPopperIcon aria-hidden className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 id="all-set-title" className="font-semibold">
          {t('dashboard.allSet.title')}
        </h2>
        <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
          {t('dashboard.allSet.body')}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="shrink-0 text-muted-foreground"
        aria-label={t('dashboard.allSet.hide')}
        onClick={onHide}
      >
        <XIcon aria-hidden />
      </Button>
    </section>
  )
}
