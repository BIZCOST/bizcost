import { BUSINESS_NAME_MAX_LENGTH } from '@bizcost/contracts'
import type { I18nKey } from '@bizcost/i18n'
import {
  nextQuestionId,
  normalizeAnswers,
  previousQuestionId,
  setupProgress,
  SETUP_QUESTION_IDS,
  setupQuestion,
  shownOptions,
  toggleMultiOption,
  type SetupAnswers,
  type SetupQuestion,
  type SetupQuestionId,
} from '@bizcost/modules'
import type { SetupStep } from './draft'

// Moving through Smart Setup (docs/PRODUCT.md §6.3). Progress, review and submit always read the
// normalized answers; the raw answers keep hidden ones so going back restores them.

/** Why the business name is refused: 1–100 characters after trimming (step 0). */
export function nameError(name: string): I18nKey | null {
  const trimmed = name.trim()
  if (trimmed.length === 0) return 'setup.name.required'
  if (trimmed.length > BUSINESS_NAME_MAX_LENGTH) return 'setup.name.tooLong'
  return null
}

/** The option ids chosen for `q` among the options shown for these answers. */
export function chosenOptions(raw: SetupAnswers, q: SetupQuestion): string[] {
  const value = (raw as Record<string, unknown>)[q.id]
  const shown = shownOptions(q, normalizeAnswers(raw).answers)
  if (q.type === 'yes_no') {
    return typeof value === 'boolean' ? [String(value)] : []
  }
  const ids = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  return shown.filter((o) => ids.includes(o.id)).map((o) => o.id)
}

/** The raw answers after choosing (or, in a multi question, ticking/unticking) one option. */
export function withChoice(
  raw: SetupAnswers,
  q: SetupQuestion,
  optionId: string,
  checked = true,
): SetupAnswers {
  const current = (raw as Record<string, unknown>)[q.id]
  let value: string | boolean | string[]
  if (q.type === 'yes_no') value = optionId === 'true'
  else if (q.type === 'single') value = optionId
  else {
    const selected = Array.isArray(current) ? (current as string[]) : []
    value = toggleMultiOption(q, selected, optionId, checked)
  }
  return { ...raw, [q.id]: value } as SetupAnswers
}

/** Whether the question has a usable answer (a multi answer needs at least one shown option). */
export function isAnswered(raw: SetupAnswers, id: SetupQuestionId): boolean {
  return normalizeAnswers(raw).answers[id] !== undefined
}

const ORDER: readonly SetupQuestionId[] = SETUP_QUESTION_IDS

/**
 * The step after `current` once it is answered. A shown question a changed answer left unanswered
 * comes first when it is before `current` (reached from the side list); otherwise Next walks on to
 * the next shown question, so unanswered ones later on are reached in order and nothing is skipped
 * (options a change made visible, like "in my shop", are seen again). After the last: the review.
 * Confirm goes to the first unanswered question (resolveStep). PRODUCT.md §6.3, D-078.
 */
export function stepAfter(raw: SetupAnswers, current: SetupStep): SetupStep {
  if (current === 'review') return 'review'
  const { missing } = normalizeAnswers(raw)
  if (current !== 'name') {
    const earlier = missing.find((id) => ORDER.indexOf(id) < ORDER.indexOf(current))
    if (earlier) return earlier
  }
  return nextQuestionId(raw, current === 'name' ? null : current) ?? missing[0] ?? 'review'
}

export function stepBefore(raw: SetupAnswers, current: SetupStep): SetupStep {
  if (current === 'name') return 'name'
  if (current === 'review') return normalizeAnswers(raw).shown.at(-1) ?? 'name'
  return previousQuestionId(raw, current) ?? 'name'
}

/** A stored step checked against the answers: never a hidden question or an incomplete review. */
export function resolveStep(raw: SetupAnswers, name: string, step: SetupStep): SetupStep {
  if (step === 'name' || nameError(name)) return 'name'
  const { shown, missing } = normalizeAnswers(raw)
  if (step === 'review') return missing[0] ?? 'review'
  if (shown.includes(step)) return step
  return missing[0] ?? 'review'
}

export interface SideStep {
  readonly step: SetupStep
  readonly labelKey: I18nKey
  readonly done: boolean
  readonly current: boolean
  /**
   * Answered steps, the first unanswered question and a complete review can be opened from the
   * side list.
   */
  readonly canOpen: boolean
}

/** The desktop side list: Name, the counted questions (§6.3 progress), Review. */
export function sideSteps(raw: SetupAnswers, name: string, current: SetupStep): SideStep[] {
  const { answers, complete, missing } = normalizeAnswers(raw)
  const nameDone = nameError(name) === null
  const { counted } = setupProgress(raw, null)
  const questions = counted.map((id): SideStep => {
    const done = answers[id] !== undefined
    return {
      step: id,
      labelKey: setupQuestion(id).shortKey,
      done,
      current: current === id,
      canOpen: nameDone && (done || id === missing[0]) && current !== id,
    }
  })
  return [
    {
      step: 'name',
      labelKey: 'setup.wizard.sideName',
      done: nameDone,
      current: current === 'name',
      canOpen: current !== 'name',
    },
    ...questions,
    {
      step: 'review',
      labelKey: 'setup.wizard.sideReview',
      done: false,
      current: current === 'review',
      canOpen: nameDone && complete && current !== 'review',
    },
  ]
}
