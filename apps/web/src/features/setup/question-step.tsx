'use client'

import type { I18nKey } from '@bizcost/i18n'
import {
  normalizeAnswers,
  shownOptions,
  type SetupAnswers,
  type SetupOption,
  type SetupQuestion,
} from '@bizcost/modules'
import { CheckIcon } from 'lucide-react'
import { useId, type FormEvent, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { chosenOptions } from './flow'
import { optionIcon } from './icons'
import { ActionBar, BackButton, NextButton, PROGRESS_ID, StepCard, StepHeading } from './step-parts'

// Step 0 (the business name) and one question per screen (docs/PRODUCT.md §6.2–§6.3): big option
// cards with their hints; single and yes/no questions are radio groups, multi questions a group of
// checkboxes. Nothing moves on by itself: the user presses Next.

/** Shown above the options, so it is in view on a phone without scrolling. */
function StepError({ id, children }: { id: string; children: string }) {
  return (
    <p id={id} role="alert" className="mt-3 text-sm font-medium text-destructive">
      {children}
    </p>
  )
}

export function NameStep({
  name,
  error,
  headingRef,
  onName,
  onNext,
}: {
  name: string
  error: I18nKey | null
  headingRef: Ref<HTMLHeadingElement>
  onName: (name: string) => void
  onNext: () => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const errorId = `${id}-error`
  return (
    <form
      noValidate
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        onNext()
      }}
    >
      <StepCard>
        <StepHeading id={`${id}-title`} headingRef={headingRef}>
          {t('setup.name.title')}
        </StepHeading>
        <p id={`${id}-hint`} className="mt-2 leading-relaxed text-muted-foreground">
          {t('setup.name.hint')}
        </p>
        <Input
          value={name}
          onChange={(event) => onName(event.target.value)}
          aria-labelledby={`${id}-title`}
          aria-describedby={error ? `${errorId} ${id}-hint` : `${id}-hint`}
          aria-invalid={Boolean(error)}
          placeholder={t('setup.name.placeholder')}
          autoComplete="organization"
          dir="auto"
          className="mt-6 h-12 text-base sm:max-w-md md:text-base lg:pointer-fine:h-11"
        />
        {error ? <StepError id={errorId}>{t(error)}</StepError> : null}
      </StepCard>
      <ActionBar>
        <NextButton />
      </ActionBar>
    </form>
  )
}

function Indicator({ multi }: { multi: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'mt-0.5 flex size-5.5 shrink-0 items-center justify-center border-2 border-input bg-card text-primary-foreground transition-colors group-has-checked:border-primary group-has-checked:bg-primary',
        multi ? 'rounded-md' : 'rounded-full',
      )}
    >
      {multi ? (
        <CheckIcon className="size-3.5 opacity-0 group-has-checked:opacity-100" strokeWidth={3} />
      ) : (
        <span className="size-2 rounded-full bg-card opacity-0 group-has-checked:opacity-100" />
      )}
    </span>
  )
}

function OptionCard({
  question,
  option,
  checked,
  describedBy,
  onChange,
}: {
  question: SetupQuestion
  option: SetupOption
  checked: boolean
  describedBy: string | undefined
  onChange: (checked: boolean) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const multi = question.type === 'multi'
  const Icon = optionIcon(question.id, option.id)
  const exclusiveId = multi && option.exclusive ? `${id}-exclusive` : undefined
  const description = [option.hintKey ? `${id}-hint` : undefined, exclusiveId, describedBy]
    .filter(Boolean)
    .join(' ')
  return (
    <label
      data-option={option.id}
      className={cn(
        'group flex min-h-16 cursor-pointer gap-3 rounded-xl border bg-card p-3.5 shadow-xs transition-colors hover:border-primary/40 hover:bg-accent/40 has-checked:border-primary has-checked:bg-accent has-focus-visible:ring-3 has-focus-visible:ring-ring sm:gap-3.5 sm:p-4',
        // Without a hint the label is one short line: center it with the icon and the box.
        option.hintKey ? 'items-start' : 'items-center',
        multi && option.exclusive && 'md:col-span-2',
      )}
    >
      <input
        type={multi ? 'checkbox' : 'radio'}
        name={question.id}
        value={option.id}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        aria-labelledby={`${id}-label`}
        aria-describedby={description || undefined}
        className="sr-only"
      />
      {Icon ? (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:text-primary group-has-checked:bg-primary group-has-checked:text-primary-foreground">
          <Icon aria-hidden className="size-5" />
        </span>
      ) : null}
      <span className="min-w-0 flex-1 self-center">
        <span id={`${id}-label`} className="block leading-snug font-medium">
          {t(option.labelKey)}
        </span>
        {option.hintKey ? (
          <span
            id={`${id}-hint`}
            className="mt-1 block text-sm leading-relaxed text-muted-foreground"
          >
            {t(option.hintKey)}
          </span>
        ) : null}
        {exclusiveId ? (
          <span id={exclusiveId} className="sr-only">
            {t('setup.wizard.exclusive')}
          </span>
        ) : null}
      </span>
      <Indicator multi={multi} />
    </label>
  )
}

export function QuestionStep({
  question,
  answers,
  error,
  headingRef,
  onChoose,
  onBack,
  onNext,
}: {
  question: SetupQuestion
  /** Raw answers (hidden ones kept). */
  answers: SetupAnswers
  error: I18nKey | null
  headingRef: Ref<HTMLHeadingElement>
  onChoose: (optionId: string, checked: boolean) => void
  onBack: () => void
  onNext: () => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const normalized = normalizeAnswers(answers).answers
  const options = shownOptions(question, normalized)
  const chosen = chosenOptions(answers, question)
  const hint = question.hint(normalized)
  const multi = question.type === 'multi'
  const errorId = `${id}-error`
  const describedBy = [hint ? `${id}-hint` : undefined, error ? errorId : undefined]
    .filter(Boolean)
    .join(' ')
  return (
    <form
      noValidate
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        onNext()
      }}
    >
      <StepCard>
        <StepHeading id={`${id}-title`} headingRef={headingRef} describedBy={PROGRESS_ID}>
          {t(question.titleKey)}
        </StepHeading>
        {hint ? (
          <p id={`${id}-hint`} className="mt-2 leading-relaxed text-muted-foreground">
            {t(hint)}
          </p>
        ) : null}
        {error ? <StepError id={errorId}>{t(error)}</StepError> : null}
        <div
          role={multi ? 'group' : 'radiogroup'}
          aria-labelledby={`${id}-title`}
          aria-describedby={describedBy || undefined}
          aria-required={multi ? undefined : true}
          aria-invalid={error ? true : undefined}
          className="mt-5 grid gap-3 sm:mt-6 md:grid-cols-2"
        >
          {options.map((option) => (
            <OptionCard
              key={option.id}
              question={question}
              option={option}
              checked={chosen.includes(option.id)}
              describedBy={error && multi ? errorId : undefined}
              onChange={(checked) => onChoose(option.id, checked)}
            />
          ))}
        </div>
      </StepCard>
      <ActionBar>
        <BackButton onClick={onBack} />
        <NextButton />
      </ActionBar>
    </form>
  )
}
