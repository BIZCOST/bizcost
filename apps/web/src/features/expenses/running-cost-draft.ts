import {
  DOCUMENT_NOTES_MAX_LENGTH,
  hasVisibleCharacter,
  RUNNING_COST_NAME_MAX_LENGTH,
  type CreateRunningCostInput,
  type RunningCostDto,
} from '@bizcost/contracts'
import {
  monthlyAmount,
  type CostAmount,
  type CurrencyCode,
  type RunningCostFrequency,
} from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { formName } from '../catalog/material-draft'
import { readAmount, type FieldError } from '../catalog/numbers'

// The running-cost form (M2 Step 5; D-116, D-169): "What do you pay to run your business?" A name in
// any language, one of the shared categories, the regular amount and how often it is paid (monthly by
// default), from when it counts and, once it stops, until when; the amount per month follows as it is
// typed (monthlyAmount of @bizcost/domain, as the API works it out). Checked as the API checks it.

export interface RunningCostDraft {
  readonly name: string
  /** '' until chosen. */
  readonly categoryId: string
  readonly amount: string
  readonly frequency: RunningCostFrequency
  readonly startsOn: string
  /** '' while it is still paid. */
  readonly endsOn: string
  readonly notes: string
}

export interface RunningCostErrors {
  name?: FieldError
  category?: FieldError
  amount?: FieldError
  startsOn?: FieldError
  endsOn?: FieldError
  notes?: FieldError
}

/** runningCost.create's fields (without the id); runningCost.update adds the id and the version. */
export type RunningCostFields = Omit<CreateRunningCostInput, 'id'>

/** Problems that only say something is missing: shown once the person tries to save. */
export const RUNNING_COST_MISSING: ReadonlySet<I18nKey> = new Set<I18nKey>([
  'catalog.form.nameRequired',
  'catalog.numbers.required',
  'expenses.editor.errors.category',
])

/**
 * The form's first state: a new running cost, paid monthly from today (a quick pick names it after
 * its category), or a saved one as it is stored.
 */
export function runningCostDraft(
  cost: RunningCostDto | undefined,
  defaults: { today: string; name?: string; categoryId?: string },
): RunningCostDraft {
  if (!cost) {
    return {
      name: defaults.name ?? '',
      categoryId: defaults.categoryId ?? '',
      amount: '',
      frequency: 'monthly',
      startsOn: defaults.today,
      endsOn: '',
      notes: '',
    }
  }
  return {
    name: cost.name,
    categoryId: cost.categoryId,
    amount: cost.amount ?? '',
    frequency: cost.frequency,
    startsOn: cost.startsOn,
    endsOn: cost.endsOn ?? '',
    notes: cost.notes ?? '',
  }
}

const BUSINESS_DAY = /^\d{4}-\d{2}-\d{2}$/

export function checkRunningCost(
  draft: RunningCostDraft,
  context: {
    readonly currency: CurrencyCode
    /** The categories it may name (active ones, and the one it already has), once read. */
    readonly categories?: ReadonlySet<string>
  },
): { errors: RunningCostErrors; fields: RunningCostFields | null; monthly: CostAmount | null } {
  const errors: RunningCostErrors = {}
  const name = formName(draft.name)
  if (!hasVisibleCharacter(name)) errors.name = { key: 'catalog.form.nameRequired' }
  else if (name.length > RUNNING_COST_NAME_MAX_LENGTH) {
    errors.name = {
      key: 'catalog.form.nameTooLong',
      values: { count: RUNNING_COST_NAME_MAX_LENGTH },
    }
  }
  if (!draft.categoryId) errors.category = { key: 'expenses.editor.errors.category' }
  else if (context.categories && !context.categories.has(draft.categoryId)) {
    errors.category = { key: 'expenses.editor.errors.categoryGone' }
  }
  const amount = readAmount(draft.amount, { positive: true, currency: context.currency })
  if (!amount.ok) errors.amount = amount.error
  if (!BUSINESS_DAY.test(draft.startsOn)) {
    errors.startsOn = { key: 'purchasing.editor.errors.date' }
  }
  const endsOn = draft.endsOn.trim()
  if (endsOn !== '' && !BUSINESS_DAY.test(endsOn)) {
    errors.endsOn = { key: 'purchasing.editor.errors.date' }
  } else if (endsOn !== '' && BUSINESS_DAY.test(draft.startsOn) && endsOn < draft.startsOn) {
    errors.endsOn = { key: 'expenses.running.sheet.endsBeforeStart' }
  }
  const notes = draft.notes.trim()
  if (notes.length > DOCUMENT_NOTES_MAX_LENGTH) {
    errors.notes = { key: 'purchasing.tooLong', values: { count: DOCUMENT_NOTES_MAX_LENGTH } }
  }
  const monthly = amount.ok ? monthlyAmount(amount.value, draft.frequency) : null
  return {
    errors,
    monthly,
    fields:
      Object.keys(errors).length === 0 && amount.ok
        ? {
            name,
            categoryId: draft.categoryId,
            amount: amount.value,
            frequency: draft.frequency,
            startsOn: draft.startsOn,
            endsOn: endsOn || null,
            notes: notes || null,
          }
        : null,
  }
}
