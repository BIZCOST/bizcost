import { newId } from '@bizcost/domain'
import {
  isSetupQuestionId,
  NO_ADJUSTMENTS,
  QUESTION_SET_VERSION,
  type SetupAdjustments,
  type SetupAnswers,
  type SetupQuestionId,
} from '@bizcost/modules'

// Smart Setup in progress (docs/PRODUCT.md §6.3), kept in sessionStorage (this tab only) so a reload
// loses nothing: the name, every answer (also answers that became hidden, so going back restores
// them), the review adjustments, the current step and the client-generated business id, kept until
// the business exists so a retried confirm is idempotent. Tied to the signed-in user: another
// account in the same tab starts afresh.

export type SetupStep = 'name' | SetupQuestionId | 'review'

export interface SetupDraft {
  readonly version: number
  readonly userId: string
  readonly businessId: string
  readonly name: string
  /** Raw answers: may hold answers to questions or options that are hidden now. */
  readonly answers: SetupAnswers
  readonly adjustments: SetupAdjustments
  readonly step: SetupStep
}

const KEY = 'bz_setup'

export function newDraft(userId: string): SetupDraft {
  return {
    version: QUESTION_SET_VERSION,
    userId,
    businessId: newId(),
    name: '',
    answers: {},
    adjustments: NO_ADJUSTMENTS,
    step: 'name',
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Keeps only answers to known questions with a well-formed value; normalizeAnswers does the rest. */
function answersOf(value: unknown): SetupAnswers {
  if (!isRecord(value)) return {}
  const kept = Object.entries(value).filter(
    ([id, answer]) =>
      isSetupQuestionId(id) &&
      (typeof answer === 'string' ||
        typeof answer === 'boolean' ||
        (Array.isArray(answer) && answer.every((v) => typeof v === 'string'))),
  )
  return Object.fromEntries(kept) as SetupAnswers
}

function adjustmentsOf(value: unknown): SetupAdjustments {
  if (!isRecord(value) || !Array.isArray(value.modules) || !Array.isArray(value.capabilities)) {
    return NO_ADJUSTMENTS
  }
  const modules = value.modules.filter(
    (m): m is { id: string; enabled: boolean } =>
      isRecord(m) && typeof m.id === 'string' && typeof m.enabled === 'boolean',
  )
  const capabilities = value.capabilities.filter(
    (c): c is { key: string; enabled: boolean } =>
      isRecord(c) && typeof c.key === 'string' && typeof c.enabled === 'boolean',
  )
  return {
    modules: modules.map(({ id, enabled }) => ({ id, enabled })),
    capabilities: capabilities.map(({ key, enabled }) => ({ key, enabled })),
  }
}

function stepOf(value: unknown): SetupStep {
  return value === 'review' || isSetupQuestionId(value) ? value : 'name'
}

/**
 * The stored draft if it belongs to `userId`, is for this question set and has a business id; null
 * otherwise (a new draft starts). Malformed parts fall back to empty values.
 */
export function parseDraft(stored: string | null, userId: string): SetupDraft | null {
  let value: unknown
  try {
    value = JSON.parse(stored ?? 'null')
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  if (value.version !== QUESTION_SET_VERSION || value.userId !== userId) return null
  if (typeof value.businessId !== 'string' || value.businessId === '') return null
  return {
    version: QUESTION_SET_VERSION,
    userId,
    businessId: value.businessId,
    name: typeof value.name === 'string' ? value.name : '',
    answers: answersOf(value.answers),
    adjustments: adjustmentsOf(value.adjustments),
    step: stepOf(value.step),
  }
}

export function readDraft(userId: string): SetupDraft | null {
  try {
    return parseDraft(sessionStorage.getItem(KEY), userId)
  } catch {
    return null
  }
}

export function saveDraft(draft: SetupDraft): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(draft))
  } catch {
    // Storage blocked: the wizard still works, a reload starts again.
  }
}

export function clearDraft(): void {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    // Nothing to clear.
  }
}
