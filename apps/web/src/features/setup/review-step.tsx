'use client'

import { apiErrorCode, apiErrorKey, useTRPC } from '@bizcost/app-core'
import { terminologyKey, type I18nKey } from '@bizcost/i18n'
import {
  applyAdjustments,
  buildSetupReview,
  isSetupItemOn,
  normalizeAnswers,
  NO_ADJUSTMENTS,
  QUESTION_SET_VERSION,
  recommend,
  recommendedState,
  setupItemNameKey,
  STATEMENT_KEYS,
  toggleSetupItem,
  type SetupAdjustments,
  type SetupItem,
  type SetupReviewRow,
  type SetupReviewStatement,
  type SetupState,
} from '@bizcost/modules'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { InfoIcon, ShieldCheckIcon, SparklesIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useId, useMemo, useState, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { FormAlert } from '@/components/form/form-alert'
import { isolate } from '@/components/form/use-message'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useLocale } from '@/lib/i18n/client'
import { cn } from '@/lib/utils'
import { clearDraft, type SetupDraft } from './draft'
import { nameError } from './flow'
import { JOBS_ICON, moduleIcon, STATEMENT_ICONS } from './icons'
import { Chips, Group, ShowHide } from './review-parts'
import { ActionBar, StepHeading } from './step-parts'

// "Here's your BizCost" (docs/PRODUCT.md §6.7): what the answers turn on, each with its reason and a
// switch; the business's capabilities as plain statements the user can flip; then Confirm. The data
// comes from @bizcost/modules (recommend, toggleSetupItem, buildSetupReview), the same rules the
// server applies again on Confirm.

function itemId(item: SetupItem): string {
  return item.kind === 'module' ? item.id : `capability:${item.key}`
}

/** The last switch flipped and what changed with it ("Also turned on:" / "Also turned off:"). */
interface Effect {
  readonly id: string
  readonly turnedOn: readonly SetupItem[]
  readonly turnedOff: readonly SetupItem[]
}

export function ReviewStep({
  draft,
  headingRef,
  onAdjustments,
  onChangeAnswers,
  onIncomplete,
  onNewBusinessId,
}: {
  draft: SetupDraft
  headingRef: Ref<HTMLHeadingElement>
  onAdjustments: (adjustments: SetupAdjustments) => void
  onChangeAnswers: () => void
  /** Confirm found a question unanswered (or no name): go there. */
  onIncomplete: () => void
  /** Starts a new business id for the next Confirm; returns it. */
  onNewBusinessId: () => string
}) {
  const { t } = useTranslation()
  const { locale } = useLocale()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const router = useRouter()
  const create = useMutation(trpc.business.createFromSetup.mutationOptions())

  const normalized = useMemo(() => normalizeAnswers(draft.answers), [draft.answers])
  const rec = useMemo(() => recommend(normalized.answers), [normalized.answers])
  // Stored adjustments that no longer apply (never expected) are dropped.
  const applied = applyAdjustments(rec, draft.adjustments)
  const adjustments = applied.ok ? draft.adjustments : NO_ADJUSTMENTS
  const state = applied.ok ? applied.state : recommendedState(rec)

  // Groups are rebuilt when a capability changes; otherwise a flipped row keeps its place.
  const [layout, setLayout] = useState<SetupState | null>(null)
  const [effect, setEffect] = useState<Effect | null>(null)
  const [blocked, setBlocked] = useState<string | null>(null)
  const [basicsOpen, setBasicsOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<I18nKey | null>(null)
  /** An earlier Confirm created the business with other answers (its reply was lost). */
  const [created, setCreated] = useState<{ businessId: string; name: string } | null>(null)
  const ids = useId()

  const review = buildSetupReview({
    answers: normalized.answers,
    recommendation: rec,
    state,
    ...(layout ? { layout } : {}),
  })
  const profile = rec.terminologyProfile
  const tt = (key: I18nKey) => t(terminologyKey(key, profile))
  const nameOf = (item: SetupItem) => tt(setupItemNameKey(item))

  function toggle(item: SetupItem, on: boolean) {
    const result = toggleSetupItem(rec, adjustments, item, on)
    if (!result.ok) {
      setEffect(null)
      setBlocked(result.issue === 'needs_vat' ? itemId(item) : null)
      return
    }
    setBlocked(null)
    const groupsChange = STATEMENT_KEYS.some((key) => {
      const cap: SetupItem = { kind: 'capability', key }
      return isSetupItemOn(state, cap) !== isSetupItemOn(result.state, cap)
    })
    setLayout(groupsChange ? null : (layout ?? state))
    setEffect({ id: itemId(item), turnedOn: result.turnedOn, turnedOff: result.turnedOff })
    setSubmitError(null)
    setCreated(null)
    onAdjustments(result.adjustments)
  }

  function effectsOf(item: SetupItem) {
    const id = itemId(item)
    const current = effect?.id === id ? effect : null
    return (
      <div aria-live="polite" className="empty:hidden">
        {current && current.turnedOn.length > 0 ? (
          <div className="mt-2.5 space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">{t('setup.review.alsoOn')}</p>
            <Chips labels={current.turnedOn.map(nameOf)} />
          </div>
        ) : null}
        {current && current.turnedOff.length > 0 ? (
          <div className="mt-2.5 space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">{t('setup.review.alsoOff')}</p>
            <Chips labels={current.turnedOff.map(nameOf)} />
          </div>
        ) : null}
        {blocked === id ? (
          <p className="mt-2 text-sm font-medium text-warning">{t('setup.review.needsVat')}</p>
        ) : null}
      </div>
    )
  }

  // Rows are rendered by plain functions, not components defined here: a new component type on each
  // render would remount the row and drop the focus from the switch just flipped.
  function moduleRow(row: SetupReviewRow) {
    const id = `${ids}-${itemId(row.item)}`
    const Icon = row.item.kind === 'module' ? moduleIcon(row.item.id) : JOBS_ICON
    return (
      <li
        key={itemId(row.item)}
        className="flex gap-3.5 py-4 first:pt-2 last:pb-1"
        data-item={itemId(row.item)}
      >
        <span
          className={cn(
            'mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl transition-colors',
            row.enabled ? 'bg-accent text-primary' : 'bg-muted text-muted-foreground',
          )}
        >
          <Icon aria-hidden className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p id={`${id}-name`} className="leading-snug font-medium">
              {tt(row.nameKey)}
            </p>
            {row.soon ? (
              <span className="rounded-full bg-accent px-2 py-px text-xs font-medium text-accent-foreground">
                {t('setup.review.soon')}
              </span>
            ) : null}
          </div>
          <p id={`${id}-text`} className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {tt(row.textKey)}
          </p>
          {row.needsVat ? (
            <p className="mt-1.5 text-sm font-medium text-warning">{t('setup.review.needsVat')}</p>
          ) : null}
          {effectsOf(row.item)}
        </div>
        <Switch
          checked={row.enabled}
          disabled={row.needsVat || submitting}
          onCheckedChange={(on) => toggle(row.item, on)}
          aria-labelledby={`${id}-name`}
          aria-describedby={`${id}-text`}
          className="mt-2.5"
        />
      </li>
    )
  }

  function statementRow(statement: SetupReviewStatement) {
    const id = `${ids}-${statement.key}`
    const Icon = STATEMENT_ICONS[statement.key]
    return (
      <li key={statement.key} className="flex items-start gap-3.5 py-3.5 first:pt-2 last:pb-1">
        <span
          className={cn(
            'mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl transition-colors',
            statement.enabled ? 'bg-accent text-primary' : 'bg-muted text-muted-foreground',
          )}
        >
          <Icon aria-hidden className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p id={`${id}-topic`} className="text-sm text-muted-foreground">
            {t(statement.topicKey)}
          </p>
          <p id={`${id}-statement`} className="leading-snug font-medium">
            {t(statement.statementKey)}
          </p>
          {effectsOf(statement.item)}
        </div>
        <Switch
          checked={statement.enabled}
          disabled={submitting}
          onCheckedChange={(on) => toggle(statement.item, on)}
          aria-labelledby={`${id}-topic`}
          aria-describedby={`${id}-statement`}
          className="mt-3"
        />
      </li>
    )
  }

  const rows = (list: readonly SetupReviewRow[]) => (
    <ul className="divide-y">{list.map(moduleRow)}</ul>
  )

  async function finish(businessId: string) {
    clearDraft()
    // The header's business list and the ready screen read `me`.
    await queryClient.invalidateQueries({ queryKey: trpc.me.queryKey() })
    router.replace(`/setup?done=${businessId}`)
  }

  async function confirm(businessId = draft.businessId) {
    if (!normalized.complete || nameError(draft.name)) {
      onIncomplete()
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    setCreated(null)
    try {
      await create.mutateAsync({
        businessId,
        legalName: draft.name.trim(),
        locale,
        questionSetVersion: QUESTION_SET_VERSION,
        answers: normalized.answers as Record<string, string | boolean | string[]>,
        adjustments: {
          modules: [...adjustments.modules],
          capabilities: [...adjustments.capabilities],
        },
      })
      await finish(businessId)
    } catch (error) {
      const code = apiErrorCode(error)
      if (code === 'conflict') {
        // The same setup again would have been accepted (idempotent), so a CONFLICT for a business
        // of this user means an earlier Confirm created it with other answers or another name before
        // its reply was lost (or another tab with a copy of this draft did). Say so, and never report
        // the setup just refused as done.
        const me = await queryClient
          .fetchQuery({ ...trpc.me.queryOptions(), staleTime: 0 })
          .catch(() => null)
        const earlier = me?.memberships.find(
          (m) => m.businessId === businessId && m.status === 'active',
        )
        if (earlier) {
          setCreated({ businessId, name: earlier.legalName })
          setSubmitting(false)
          return
        }
        // The id belongs to a business this user cannot see: the next Confirm uses a new one.
        onNewBusinessId()
      }
      setSubmitError(code === 'rate_limited' ? 'setup.review.rateLimited' : apiErrorKey(error))
      setSubmitting(false)
    }
  }

  const basicsId = `${ids}-basics`
  const moreId = `${ids}-more`

  return (
    <div>
      <header className="mb-5">
        <StepHeading headingRef={headingRef}>{t('setup.review.title')}</StepHeading>
        <p className="mt-2 leading-relaxed text-muted-foreground">{t('setup.review.subtitle')}</p>
      </header>

      <div className="space-y-4">
        {review.banner ? (
          <FormAlert tone="info" className="rounded-xl bg-card px-4 py-3">
            {t('setup.review.banner')}
          </FormAlert>
        ) : null}

        {review.chosen.length > 0 ? (
          <Group
            title={
              <span className="flex items-center gap-2">
                <SparklesIcon aria-hidden className="size-4 text-primary" />
                {t('setup.review.groups.chosen')}
              </span>
            }
          >
            {rows(review.chosen)}
          </Group>
        ) : null}

        {review.basics.length > 0 ? (
          <Group
            title={t('setup.review.groups.basics')}
            bodyId={basicsId}
            action={
              <ShowHide
                open={basicsOpen}
                controls={basicsId}
                onToggle={() => setBasicsOpen((open) => !open)}
              />
            }
          >
            {basicsOpen ? (
              rows(review.basics)
            ) : (
              <div className="pt-2">
                <Chips labels={review.basics.filter((r) => r.enabled).map((r) => tt(r.nameKey))} />
              </div>
            )}
          </Group>
        ) : null}

        <Group title={t('setup.review.groups.about')}>
          <ul className="divide-y">{review.about.map(statementRow)}</ul>
          {review.teamNote || review.vatNotSureNote ? (
            <div className="mt-4 space-y-2.5">
              {review.teamNote ? (
                <p className="flex items-start gap-2.5 rounded-xl bg-muted/60 px-3.5 py-3 text-sm leading-relaxed">
                  <ShieldCheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
                  {t('setup.review.teamNote')}
                </p>
              ) : null}
              {review.vatNotSureNote ? (
                <p className="flex items-start gap-2.5 rounded-xl bg-muted/60 px-3.5 py-3 text-sm leading-relaxed">
                  <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
                  {t('setup.review.vatNotSure')}
                </p>
              ) : null}
            </div>
          ) : null}
        </Group>

        {review.more.length > 0 ? (
          <Group
            title={
              <span className="flex items-center gap-2">
                {t('setup.review.groups.more')}
                <span className="rounded-full bg-muted px-2 text-xs leading-5 font-medium text-muted-foreground tabular-nums">
                  {review.more.length}
                </span>
              </span>
            }
            bodyId={moreId}
            action={
              <ShowHide
                open={moreOpen}
                controls={moreId}
                onToggle={() => setMoreOpen((open) => !open)}
              />
            }
          >
            {moreOpen ? rows(review.more) : null}
          </Group>
        ) : null}

        {submitError ? <FormAlert tone="error">{t(submitError)}</FormAlert> : null}
        {created ? (
          <div className="space-y-3">
            <FormAlert tone="error">
              {t('setup.review.alreadyCreated', { businessName: isolate(created.name) })}
            </FormAlert>
            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  clearDraft()
                  router.push(`/b/${created.businessId}`)
                }}
              >
                {t('setup.review.openCreated')}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={submitting}
                onClick={() => void confirm(onNewBusinessId())}
              >
                {t('setup.review.createAnother')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <ActionBar>
        <Button
          type="button"
          variant="outline"
          size="lg"
          onClick={onChangeAnswers}
          disabled={submitting}
          className="grow px-3 max-sm:text-sm sm:grow-0 sm:px-4"
        >
          {t('setup.review.change')}
        </Button>
        <Button
          type="button"
          size="lg"
          onClick={() => void confirm()}
          disabled={submitting}
          className="grow px-3 max-sm:text-sm sm:ms-auto sm:min-w-48 sm:grow-0 sm:px-5"
        >
          {submitting ? t('setup.review.confirming') : t('setup.review.confirm')}
        </Button>
      </ActionBar>
    </div>
  )
}
