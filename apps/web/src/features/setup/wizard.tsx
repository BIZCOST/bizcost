'use client'

import { withoutControlCharacters } from '@bizcost/contracts'
import type { I18nKey } from '@bizcost/i18n'
import {
  NO_ADJUSTMENTS,
  normalizeAnswers,
  setupProgress,
  setupQuestion,
  type SetupAdjustments,
} from '@bizcost/modules'
import { XIcon } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { newDraft, readDraft, saveDraft, type SetupDraft, type SetupStep } from './draft'
import {
  isAnswered,
  nameError,
  resolveStep,
  sideSteps,
  stepAfter,
  stepBefore,
  withChoice,
} from './flow'
import { NameStep, QuestionStep } from './question-step'
import { ReviewStep } from './review-step'
import { SideSteps } from './side-steps'
import { Progress } from './step-parts'

// Smart Setup's wizard (docs/PRODUCT.md §6.3): step 0 the business name, then one question per
// screen with skip logic, then the review. Everything is kept in sessionStorage (draft.ts), so a
// reload or a language switch loses nothing.

export function SetupWizard({ userId }: { userId: string }) {
  const { t } = useTranslation()
  // Read after mount, so the server and the browser render the same first.
  const [draft, setDraft] = useState<SetupDraft>()
  const [error, setError] = useState<I18nKey | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const moved = useRef(false)

  useEffect(() => {
    const stored = readDraft(userId)
    setDraft(
      stored
        ? { ...stored, step: resolveStep(stored.answers, stored.name, stored.step) }
        : newDraft(userId),
    )
  }, [userId])
  useEffect(() => {
    if (draft) saveDraft(draft)
  }, [draft])
  const step = draft?.step
  useEffect(() => {
    // Every step change: back to the top, and the focus on the new heading.
    if (!moved.current) return
    moved.current = false
    window.scrollTo({ top: 0 })
    heading.current?.focus({ preventScroll: true })
  }, [step])

  if (!draft) return null

  const update = (patch: Partial<SetupDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d))
  const go = (next: SetupStep) => {
    setError(null)
    if (next !== draft.step) moved.current = true
    update({ step: next })
  }

  let content
  if (draft.step === 'name') {
    content = (
      <NameStep
        name={draft.name}
        error={error}
        headingRef={heading}
        onName={(typed) => {
          // A pasted tab or line break becomes a space (the API refuses control characters).
          const name = withoutControlCharacters(typed)
          update({ name })
          if (error && !nameError(name)) setError(null)
        }}
        onNext={() => {
          const problem = nameError(draft.name)
          if (problem) {
            setError(problem)
            return
          }
          go(stepAfter(draft.answers, 'name'))
        }}
      />
    )
  } else if (draft.step === 'review') {
    content = (
      <ReviewStep
        draft={draft}
        headingRef={heading}
        onAdjustments={(adjustments: SetupAdjustments) => update({ adjustments })}
        onChangeAnswers={() => go(normalizeAnswers(draft.answers).shown[0] ?? 'name')}
        onIncomplete={() => go(resolveStep(draft.answers, draft.name, 'review'))}
        onNewBusinessId={() => {
          const { businessId } = newDraft(userId)
          update({ businessId })
          return businessId
        }}
      />
    )
  } else {
    const question = setupQuestion(draft.step)
    content = (
      <QuestionStep
        key={question.id}
        question={question}
        answers={draft.answers}
        error={error}
        headingRef={heading}
        onChoose={(optionId, checked) => {
          setError(null)
          // A changed answer resets the review's changes (§6.3).
          update({
            answers: withChoice(draft.answers, question, optionId, checked),
            adjustments: NO_ADJUSTMENTS,
          })
        }}
        onBack={() => go(stepBefore(draft.answers, question.id))}
        onNext={() => {
          if (!isAnswered(draft.answers, question.id)) {
            setError(
              question.type === 'multi'
                ? 'setup.wizard.chooseAtLeastOne'
                : 'setup.wizard.chooseOne',
            )
            return
          }
          go(stepAfter(draft.answers, question.id))
        }}
      />
    )
  }

  const progress =
    draft.step === 'name' || draft.step === 'review'
      ? null
      : setupProgress(draft.answers, draft.step)

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-5 pb-32 sm:px-6 sm:pt-8 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10 lg:pt-10 lg:pb-16">
      <SideSteps steps={sideSteps(draft.answers, draft.name, draft.step)} onOpen={go} />
      <div className="mx-auto w-full max-w-3xl min-w-0 lg:mx-0">
        <div className="mb-3 flex min-h-11 items-center justify-between gap-4 lg:mb-4">
          <p className="text-sm font-semibold text-primary">{t('setup.title')}</p>
          <Button asChild variant="ghost" className="-me-3 text-muted-foreground lg:hidden">
            <Link href="/">
              <XIcon aria-hidden />
              {t('setup.wizard.exit')}
            </Link>
          </Button>
        </div>
        {draft.step === 'name' ? (
          <p className="mb-4 leading-relaxed text-muted-foreground">{t('setup.wizard.intro')}</p>
        ) : null}
        {progress ? <Progress n={progress.n} m={progress.m} /> : null}
        {content}
      </div>
    </div>
  )
}
