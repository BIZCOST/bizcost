'use client'

import type { CostStepDto } from '@bizcost/contracts'
import type { TerminologyProfile } from '@bizcost/domain'
import { CalculatorIcon, CheckIcon, ChevronRightIcon, TrendingUpIcon, XIcon } from 'lucide-react'
import Link from 'next/link'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { useTerminology } from '@/lib/i18n/client'
import { cn } from '@/lib/utils'
import { costProgress, costsReadyKeys, costStepView, type CostStepView } from './cost-steps'

// "Let's find the real cost of what you sell / لنعرف التكلفة الحقيقية لما تبيعه" (docs/PRODUCT.md
// §10, M2 Step 7, D-193): the path from an empty business to its product costs, the steps this member
// can act on, each done or not from the business's real data and saying what is still missing (the
// products without what goes into them, the materials with no price yet…). The first open step is the
// next one: its action is a button on every screen size (under its words on a phone, D-200). Once
// every step is done, "Your product costs are ready" takes its place (the member can hide it, like
// "You're all set"). A business that sells only services reads about its services (D-200).

const CARD = 'overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/[0.06]'

function Step({
  step,
  next,
  profile,
}: {
  step: CostStepView
  next: boolean
  profile: TerminologyProfile | null | undefined
}) {
  const { t } = useTranslation()
  const term = useTerminology()
  const Icon = step.icon
  const title = term(step.titleKey, profile)
  const body =
    step.count === null ? term(step.bodyKey, profile) : t(step.bodyKey, { count: step.count })
  const action = term(step.actionKey, profile)
  return (
    <li
      data-cost-step={step.id}
      data-done={step.done || undefined}
      data-next={next || undefined}
      className={cn(
        'relative flex items-center gap-4 px-5 py-4 sm:px-6',
        next && 'bg-accent/40',
        !step.done && 'transition-colors focus-within:bg-muted/50 hover:bg-muted/50',
      )}
    >
      {step.done ? (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-success/10 text-success">
          <CheckIcon aria-hidden className="size-5" strokeWidth={2.5} />
        </span>
      ) : (
        <span
          className={cn(
            'flex size-10 shrink-0 items-center justify-center self-start rounded-xl sm:self-center',
            next ? 'bg-primary text-primary-foreground' : 'bg-accent text-primary',
          )}
        >
          <Icon aria-hidden className="size-5" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        {next ? (
          <p className="text-xs font-semibold text-primary">{t('dashboard.costs.next')}</p>
        ) : null}
        {step.done ? (
          <p className="font-medium text-muted-foreground">{title}</p>
        ) : (
          // The whole row opens where the step is done; the link's name is the step's title.
          <Link
            href={step.href}
            className="font-semibold outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:rounded-none focus-visible:after:ring-3 focus-visible:after:ring-ring focus-visible:after:ring-inset"
          >
            {title}
          </Link>
        )}
        <p className="mt-0.5 text-sm leading-relaxed text-pretty text-muted-foreground">{body}</p>
        {next ? (
          // The next step's action on a phone: a full-width button under its words (the row's link
          // takes the tap, so it is not a second control).
          <span
            aria-hidden
            data-next-action
            className="mt-3 flex min-h-11 w-full items-center justify-center rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-sm sm:hidden"
          >
            {action}
          </span>
        ) : null}
      </div>
      {step.done ? (
        <span className="shrink-0 rounded-full px-2.5 py-1 text-xs font-medium text-success ring-1 ring-success/30 ring-inset">
          {t('dashboard.checklist.done')}
        </span>
      ) : (
        <>
          <span
            aria-hidden
            className={cn(
              'hidden shrink-0 items-center rounded-lg px-3 py-1.5 text-sm font-medium sm:inline-flex',
              next
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'border bg-background text-primary',
            )}
          >
            {action}
          </span>
          {next ? null : (
            <ChevronRightIcon
              aria-hidden
              className="size-5 shrink-0 text-muted-foreground rtl:rotate-180 sm:hidden"
            />
          )}
        </>
      )}
    </li>
  )
}

export function CostChecklist({
  businessId,
  steps,
  profile,
  servicesOnly = false,
  className,
}: {
  businessId: string
  steps: readonly CostStepDto[]
  profile: TerminologyProfile | null | undefined
  /** The business sells only services (business.context, D-200): its steps speak of services. */
  servicesOnly?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const { done, total, next } = costProgress(steps)
  const percent = total === 0 ? 0 : Math.round((done / total) * 100)
  // With the sales steps (M3 Step 3, while Sales and Reports are served) it is the way to the first
  // real profit (PRODUCT.md §10).
  const profit = steps.some((step) => step.id === 'real_profit')
  return (
    <section aria-labelledby="costs-title" className={cn(CARD, className)} data-cost-checklist>
      <div className="border-b px-5 pt-5 pb-4 sm:px-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="costs-title" className="text-lg font-semibold tracking-tight text-balance">
              {t(profit ? 'dashboard.costs.titleProfit' : 'dashboard.costs.title')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t(
                profit
                  ? 'dashboard.costs.descriptionProfit'
                  : servicesOnly
                    ? 'dashboard.costs.description_services'
                    : 'dashboard.costs.description',
              )}
            </p>
          </div>
          <p className="shrink-0 pt-1 text-sm font-medium text-primary tabular-nums">
            {t('dashboard.checklist.progress', { done, total })}
          </p>
        </div>
        <div
          role="progressbar"
          aria-label={t('dashboard.costs.progressLabel')}
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
      <ol className="divide-y">
        {steps.map((step) => (
          <Step
            key={step.id}
            step={costStepView(businessId, step, profile, servicesOnly)}
            next={step.id === next}
            profile={profile}
          />
        ))}
      </ol>
    </section>
  )
}

/**
 * Every cost step is done: "Your product costs are ready", with the way to them, or, with the sales
 * steps (M3 Step 3), "Your real profit is ready" with the way to Real profit; it can be hidden.
 */
export function CostsReady({
  businessId,
  onHide,
  servicesOnly = false,
  ownerTime,
  profit = false,
}: {
  businessId: string
  onHide: () => void
  servicesOnly?: boolean
  /** The business counts the owner's time (no team, D-119). */
  ownerTime: boolean
  /** "See your real profit" was the last step (M3 Step 3). */
  profit?: boolean
}) {
  const { t } = useTranslation()
  const keys = costsReadyKeys({ servicesOnly, ownerTime, profit })
  const Icon = profit ? TrendingUpIcon : CalculatorIcon
  return (
    <section
      aria-labelledby="costs-ready-title"
      className={cn(CARD, 'flex flex-wrap items-center gap-4 px-5 py-4 sm:flex-nowrap sm:px-6')}
      data-costs-ready={profit ? 'profit' : 'costs'}
    >
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-success/10 text-success">
        <Icon aria-hidden className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 id="costs-ready-title" className="font-semibold">
          {t(keys.title)}
        </h2>
        <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{t(keys.body)}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1 max-sm:w-full max-sm:justify-end">
        <Button asChild variant="outline">
          <Link href={`/b/${businessId}/${keys.path}`}>{t(keys.action)}</Link>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 text-muted-foreground"
          aria-label={t('dashboard.allSet.hide')}
          onClick={onHide}
        >
          <XIcon aria-hidden />
        </Button>
      </div>
    </section>
  )
}
