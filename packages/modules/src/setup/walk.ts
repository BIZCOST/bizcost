import type { SetupAnswers, SetupQuestionId } from './answers'
import {
  isQuestionShown,
  isSetupQuestionId,
  SETUP_QUESTIONS,
  shownOptions,
  type SetupQuestion,
} from './questions'

// Walking the question set (docs/PRODUCT.md §6.3): normalizing what the client kept, strict parsing on
// the server, progress ("Question n of m") and navigation.

type MutableAnswers = Record<string, string | boolean | string[]>

/** The answer to `q` if it is well-formed for its type and uses only options shown for `acc`. */
function keptAnswer(
  q: SetupQuestion,
  value: unknown,
  acc: SetupAnswers,
): string | boolean | string[] | undefined {
  const shown = shownOptions(q, acc)
  if (q.type === 'yes_no') return typeof value === 'boolean' ? value : undefined
  if (q.type === 'single') {
    return typeof value === 'string' && shown.some((o) => o.id === value) ? value : undefined
  }
  if (!Array.isArray(value)) return undefined
  const kept = shown.filter((o) => value.includes(o.id))
  // An exclusive option together with another one is not an answer the wizard can produce.
  if (kept.length === 0 || (kept.length > 1 && kept.some((o) => o.exclusive))) return undefined
  return kept.map((o) => o.id)
}

export interface NormalizedAnswers {
  /** Answers to shown questions only, with only shown options; multi answers in option order. */
  readonly answers: SetupAnswers
  /** The questions shown for these answers, in order. */
  readonly shown: readonly SetupQuestionId[]
  /** Shown questions without an answer (a multi answer left empty counts as none), in order. */
  readonly missing: readonly SetupQuestionId[]
  readonly complete: boolean
}

/**
 * Walks the questions in order and drops answers to hidden questions and hidden options (also a hidden
 * single answer, e.g. `kitchen` once food is unticked). The client keeps every answer, so going back
 * restores them; progress, review and submit always use this result.
 */
export function normalizeAnswers(raw: SetupAnswers): NormalizedAnswers {
  const acc: MutableAnswers = {}
  const shown: SetupQuestionId[] = []
  const missing: SetupQuestionId[] = []
  for (const q of SETUP_QUESTIONS) {
    const current = acc as SetupAnswers
    if (!isQuestionShown(q, current)) continue
    shown.push(q.id)
    const value = keptAnswer(q, (raw as Record<string, unknown>)[q.id], current)
    if (value === undefined) missing.push(q.id)
    else acc[q.id] = value
  }
  return { answers: acc as SetupAnswers, shown, missing, complete: missing.length === 0 }
}

/** Why the server refused answers (VALIDATION; nothing is silently fixed). */
export type SetupAnswersIssue =
  | 'not_an_object'
  | 'unknown_question'
  | 'wrong_type'
  | 'unknown_option'
  | 'duplicate_option'
  | 'exclusive_combined'
  | 'hidden_question'
  | 'hidden_option'
  | 'missing_answer'

export type ParseSetupAnswersResult =
  | { readonly ok: true; readonly answers: SetupAnswers }
  | { readonly ok: false; readonly issue: SetupAnswersIssue; readonly question?: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

/**
 * Strict server-side check of submitted answers: VALIDATION for an unknown question or option, a value
 * of the wrong type, a duplicate or an exclusive option combined with another, an answer to a hidden
 * question or a hidden option, or a shown question without an answer. Returns the canonical answers
 * (multi answers in option order).
 */
export function parseSetupAnswers(raw: unknown): ParseSetupAnswersResult {
  if (!isPlainObject(raw)) return { ok: false, issue: 'not_an_object' }
  for (const id of Object.keys(raw)) {
    if (!isSetupQuestionId(id)) return { ok: false, issue: 'unknown_question', question: id }
  }
  const acc: MutableAnswers = {}
  for (const q of SETUP_QUESTIONS) {
    const current = acc as SetupAnswers
    const present = Object.hasOwn(raw, q.id)
    const value = raw[q.id]
    const fail = (issue: SetupAnswersIssue) => ({ ok: false as const, issue, question: q.id })
    if (!isQuestionShown(q, current)) {
      if (present) return fail('hidden_question')
      continue
    }
    if (!present || value === undefined || value === null) return fail('missing_answer')
    const all = new Set(q.options.map((o) => o.id))
    const shown = new Set(shownOptions(q, current).map((o) => o.id))
    if (q.type === 'yes_no') {
      if (typeof value !== 'boolean') return fail('wrong_type')
      acc[q.id] = value
    } else if (q.type === 'single') {
      if (typeof value !== 'string') return fail('wrong_type')
      if (!all.has(value)) return fail('unknown_option')
      if (!shown.has(value)) return fail('hidden_option')
      acc[q.id] = value
    } else {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        return fail('wrong_type')
      }
      const ids = value as string[]
      if (ids.length === 0) return fail('missing_answer')
      if (new Set(ids).size !== ids.length) return fail('duplicate_option')
      if (ids.some((id) => !all.has(id))) return fail('unknown_option')
      if (ids.some((id) => !shown.has(id))) return fail('hidden_option')
      const chosen = q.options.filter((o) => ids.includes(o.id))
      if (chosen.length > 1 && chosen.some((o) => o.exclusive)) return fail('exclusive_combined')
      acc[q.id] = chosen.map((o) => o.id)
    }
  }
  return { ok: true, answers: acc as SetupAnswers }
}

export interface SetupProgress {
  /** The questions counted in "Question n of m", in order (the desktop side list). */
  readonly counted: readonly SetupQuestionId[]
  /** Position of the current question among `counted` (1-based); 0 when it is not counted. */
  readonly n: number
  readonly m: number
}

/**
 * Progress (§6.3): walking the questions in order, a question is counted when it is shown, or when a
 * question it depends on is counted and still unanswered (a hidden dependency counts as settled). So
 * `m` never goes up as the user answers in order, and it settles once `workplace` and `team` are
 * answered. The name step is never counted.
 */
export function setupProgress(raw: SetupAnswers, current: SetupQuestionId | null): SetupProgress {
  const { answers } = normalizeAnswers(raw)
  const counted = new Set<SetupQuestionId>()
  for (const q of SETUP_QUESTIONS) {
    const open = q.dependsOn.some((d) => counted.has(d) && answers[d] === undefined)
    if (isQuestionShown(q, answers) || open) counted.add(q.id)
  }
  const list = [...counted]
  return { counted: list, n: current === null ? 0 : list.indexOf(current) + 1, m: list.length }
}

/** The shown question after `current` (null: the first one), or null when the review comes next. */
export function nextQuestionId(
  raw: SetupAnswers,
  current: SetupQuestionId | null,
): SetupQuestionId | null {
  const { shown } = normalizeAnswers(raw)
  if (current === null) return shown[0] ?? null
  const order = SETUP_QUESTIONS.map((q) => q.id)
  const from = order.indexOf(current)
  return shown.find((id) => order.indexOf(id) > from) ?? null
}

/** The shown question before `current`, or null when the name step comes before it. */
export function previousQuestionId(
  raw: SetupAnswers,
  current: SetupQuestionId,
): SetupQuestionId | null {
  const { shown } = normalizeAnswers(raw)
  const order = SETUP_QUESTIONS.map((q) => q.id)
  const from = order.indexOf(current)
  return shown.findLast((id) => order.indexOf(id) < from) ?? null
}

/**
 * A multi answer after ticking or unticking one option: an exclusive option clears the others, any
 * other option clears the exclusive ones. The result is in option order.
 */
export function toggleMultiOption(
  q: SetupQuestion,
  selected: readonly string[],
  optionId: string,
  checked: boolean,
): string[] {
  const target = q.options.find((o) => o.id === optionId)
  if (!target) return q.options.filter((o) => selected.includes(o.id)).map((o) => o.id)
  const next = q.options.filter((o) => {
    if (o.id === optionId) return checked
    if (!selected.includes(o.id)) return false
    return !checked || (!target.exclusive && !o.exclusive)
  })
  return next.map((o) => o.id)
}
