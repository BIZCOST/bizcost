'use client'

import type { ExpensePaysDto, PayableChannelsDto, PayableRunningCostDto } from '@bizcost/contracts'
import { CheckIcon } from 'lucide-react'
import { useId, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { isolate } from '@/components/form/use-message'
import { useBusinessDate, useBusinessMonth } from '@/features/documents/amounts'
import { cn } from '@/lib/utils'
import { DELIVERY, EXTRA, FEES, ORDINARY } from './expense-draft'

// What an expense pays (the owner's decision of 2026-10-01, "1أ"; D-216). In a category that has a
// running cost a bill for its month can pay, one choice: «فاتورة لـ…» / "Bill for …", which takes the
// place of that running cost's regular amount alone (for its month, or its quarter or year), or
// «مصروف إضافي» / "Extra expense", which is added on top. Running costs by name only, never their
// amounts. Asked in the expense editor, and of the one who approves or finalizes an expense entered
// by a member who may not see running costs. Its label shows in the lists and on the expense. Two
// of the same name (a rent changed that month, D-176) say when each counts (D-217; a bill of either
// pays for both that month). While Sales is served (M3 Step 3, Q8), a member who sees costs may also
// say it pays «عمولات تطبيق…» / "App fees of …" (a delivery app's or marketplace's) or "Delivery
// already on my sales and orders": neither counts in the month's costs; in a category without running
// costs the choice then offers "An ordinary expense" too (it counts as itself).

/** One option: a radio card with what it means under it. */
function Option({
  name,
  value,
  checked,
  title,
  hint,
  invalid,
  onChange,
}: {
  name: string
  value: string
  checked: boolean
  title: string
  hint: string
  /** Nothing chosen while it is needed: the cards are marked too. */
  invalid: boolean
  onChange: (value: string) => void
}) {
  const id = useId()
  return (
    <label
      data-pays-option={value}
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-xl border bg-card px-3.5 py-3 transition-colors hover:bg-muted/50',
        'has-checked:border-primary has-checked:bg-accent has-focus-visible:ring-3 has-focus-visible:ring-ring',
        invalid && 'border-destructive/60',
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-hint`}
        className="sr-only"
      />
      <span
        aria-hidden
        className={cn(
          'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2',
          checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
        )}
      >
        {checked ? <CheckIcon className="size-3" /> : null}
      </span>
      <span className="min-w-0">
        <span id={`${id}-title`} className="block font-medium break-words">
          {title}
        </span>
        <span id={`${id}-hint`} className="block text-sm leading-snug text-muted-foreground">
          {hint}
        </span>
      </span>
    </label>
  )
}

type PayableChannel = PayableChannelsDto['items'][number]

/** The channels whose app fees an expense is offered: those that keep part of each sale, and its own. */
export function feeChannels(
  channels: readonly PayableChannel[] | undefined,
  value: string,
): PayableChannel[] {
  return (channels ?? []).filter(
    (channel) =>
      channel.kind === 'delivery_app' ||
      channel.kind === 'marketplace' ||
      value === `${FEES}${channel.id}`,
  )
}

/**
 * «ماذا يدفع هذا المصروف؟»: the bill of one of `options` (the running costs its category can pay
 * that month, by name), or an extra; while Sales is served, a channel's app fees or delivery already
 * on the sales (`channels`: those offered, for a member who sees costs), and, in a category without
 * running costs, an ordinary expense. `value`: a running cost's id, EXTRA, `fees:<id>`, DELIVERY,
 * ORDINARY, or '' (not chosen yet; an ordinary expense where that is offered). `hint`: a line under
 * the question; `error`: what to fix (required to finalize). `columns`: two columns from 640 px
 * (the editor; a dialog keeps one).
 */
export function PaysChoice({
  options,
  channels,
  value,
  onChange,
  hint,
  error,
  columns = false,
  ref,
}: {
  options: readonly PayableRunningCostDto[]
  channels?: readonly PayableChannel[]
  value: string
  onChange: (value: string) => void
  hint?: string
  error?: string
  columns?: boolean
  ref?: Ref<HTMLFieldSetElement>
}) {
  const { t } = useTranslation()
  const monthName = useBusinessMonth()
  const businessDate = useBusinessDate()
  const name = useId()
  const errorId = `${name}-error`
  const hintId = `${name}-hint`
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ')
  // Names offered more than once, however spaced or cased.
  const nameKey = (cost: PayableRunningCostDto) => cost.name.trim().toLocaleLowerCase()
  const counts = new Map<string, number>()
  for (const cost of options) counts.set(nameKey(cost), (counts.get(nameKey(cost)) ?? 0) + 1)
  const billHint = (cost: PayableRunningCostDto) => {
    const { from, to, months } = cost.period
    const what =
      months === 1
        ? t('expenses.pays.hint.month', { month: monthName(from) })
        : t(months === 3 ? 'expenses.pays.hint.quarter' : 'expenses.pays.hint.year', {
            from: monthName(from),
            to: monthName(to),
          })
    if ((counts.get(nameKey(cost)) ?? 0) < 2) return what
    const when = cost.endsOn
      ? t('expenses.pays.when.fromTo', {
          from: businessDate(cost.startsOn),
          to: businessDate(cost.endsOn),
        })
      : t('expenses.pays.when.from', { from: businessDate(cost.startsOn) })
    return `${when} ${what}`
  }
  return (
    <fieldset
      ref={ref}
      data-pays-choice
      aria-describedby={describedBy || undefined}
      className="min-w-0"
    >
      <legend className="mb-2 text-sm font-medium">{t('expenses.pays.question')}</legend>
      {hint ? (
        <p id={hintId} className="-mt-1 mb-2 text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <div className={cn('grid gap-2', columns && 'sm:grid-cols-2')}>
        {options.map((cost) => (
          <Option
            key={cost.id}
            name={name}
            value={cost.id}
            checked={value === cost.id}
            title={t('expenses.pays.bill', { name: isolate(cost.name) })}
            hint={billHint(cost)}
            invalid={Boolean(error)}
            onChange={onChange}
          />
        ))}
        {options.length > 0 ? (
          <Option
            name={name}
            value={EXTRA}
            checked={value === EXTRA}
            title={t('expenses.pays.extra')}
            hint={t('expenses.pays.hint.extra')}
            invalid={Boolean(error)}
            onChange={onChange}
          />
        ) : null}
        {channels ? (
          <>
            {feeChannels(channels, value).map((channel) => (
              <Option
                key={channel.id}
                name={name}
                value={`${FEES}${channel.id}`}
                checked={value === `${FEES}${channel.id}`}
                title={t('expenses.pays.channelFees', { name: isolate(channel.name) })}
                hint={t('expenses.pays.hint.channelFees')}
                invalid={Boolean(error)}
                onChange={onChange}
              />
            ))}
            <Option
              name={name}
              value={DELIVERY}
              checked={value === DELIVERY}
              title={t('expenses.pays.delivery')}
              hint={t('expenses.pays.hint.delivery')}
              invalid={Boolean(error)}
              onChange={onChange}
            />
            {options.length === 0 ? (
              <Option
                name={name}
                value={ORDINARY}
                checked={value === ORDINARY || value === ''}
                title={t('expenses.pays.ordinary')}
                hint={t('expenses.pays.hint.ordinary')}
                invalid={Boolean(error)}
                onChange={onChange}
              />
            ) : null}
          </>
        ) : null}
      </div>
      {error ? (
        <p id={errorId} role="alert" className="mt-1.5 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </fieldset>
  )
}

/**
 * What an expense pays, in a few words: "Bill for DEWA", "Bill for a running cost" (for a member who
 * may not see running costs: no name), "Extra expense"; null when nothing is said.
 */
export function usePaysLabel() {
  const { t } = useTranslation()
  return (pays: ExpensePaysDto | undefined): string | null => {
    if (!pays) return null
    if (pays.kind === 'extra') return t('expenses.pays.extra')
    // M3 Step 3 (Q8): a channel's app fees, delivery already on the sales.
    if (pays.kind === 'channel_fees') {
      return t('expenses.pays.channelFees', { name: isolate(pays.channel?.name ?? '') })
    }
    if (pays.kind === 'delivery') return t('expenses.pays.delivery')
    return pays.runningCost
      ? t('expenses.pays.bill', { name: isolate(pays.runningCost.name) })
      : t('expenses.pays.billUnnamed')
  }
}
