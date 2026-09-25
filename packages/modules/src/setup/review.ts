import type { I18nKey } from '@bizcost/i18n'
import type { Capabilities, CapabilityKey } from '../capabilities'
import {
  ALWAYS_ENABLED_MODULE_IDS,
  MODULE_IDS,
  MODULES,
  type ModuleAvailability,
  type ModuleId,
  type ModuleManifest,
} from '../manifests'
import { has, type SetupAnswers } from './answers'
import { isSetupItemOn, type SetupItem, type SetupState } from './adjust'
import { isQuestionShown, setupQuestion, shownOptions } from './questions'
import { setupTexts, type Recommendation } from './recommend'
import { normalizeAnswers } from './walk'

// The review screen, "Here's your BizCost" (docs/PRODUCT.md §6.7), as data: which rows go in which
// group, with which text. Keys are base keys: apply the recommended profile's overlays with
// terminologyKey(key, rec.terminologyProfile) from @bizcost/i18n.

const key = (value: string) => value as I18nKey

/** Modules with a description (`modules.<id>.desc`, §6.9): those that can be off after setup. */
const DESCRIBED: ReadonlySet<ModuleId> = new Set<ModuleId>([
  'materials',
  'purchases',
  'customers',
  'payments',
  'orders',
  'quotations',
  'invoices',
  'inventory',
  'usage_waste',
  'employees',
  'attendance',
  'payroll',
  'equipment',
  'vehicles',
  'projects',
  'petty_cash',
  'vat_center',
])

export function moduleNameKey(id: ModuleId): I18nKey {
  return key(`modules.${id}.name`)
}

export function moduleDescriptionKey(id: ModuleId): I18nKey | null {
  return DESCRIBED.has(id) ? key(`modules.${id}.desc`) : null
}

/** The "cost of each job" row: the jobs_and_tasks capability shown like a section. */
export const JOBS_ITEM: SetupItem = { kind: 'capability', key: 'jobs_and_tasks' }
const JOBS_NAME = key('setup.jobs.name')
const JOBS_DESCRIPTION = key('setup.jobs.desc')
/** Jobs & Tasks ships with Projects (Phase 5). */
const JOBS_AVAILABILITY: ModuleAvailability = 'planned'

/** Name of any switch, e.g. for the "Also turned on:" chips. */
export function setupItemNameKey(item: SetupItem): I18nKey {
  if (item.kind === 'module') return moduleNameKey(item.id)
  if (item.key === 'jobs_and_tasks') return JOBS_NAME
  return key(`setup.cap.${item.key}.topic`)
}

export interface SetupReviewRow {
  readonly item: SetupItem
  readonly nameKey: I18nKey
  /** Reason (chosen, basics), or off note / description (more). */
  readonly textKey: I18nKey
  readonly enabled: boolean
  /** Requires VAT while VAT is off: the switch is disabled, with `setup.review.needsVat`. */
  readonly needsVat: boolean
  /** Planned while released items are listed too: show the "Soon" tag. */
  readonly soon: boolean
}

/** Capabilities shown as statements under "About your business". */
export const STATEMENT_KEYS = [
  'has_team',
  'multi_location',
  'keeps_stock',
  'uses_machines',
  'sells_via_pos',
  'vat_registered',
] as const satisfies readonly CapabilityKey[]
export type StatementKey = (typeof STATEMENT_KEYS)[number]

export interface SetupReviewStatement {
  readonly key: StatementKey
  readonly item: SetupItem
  /** Fixed label of the row; also the switch's accessible name. */
  readonly topicKey: I18nKey
  /** The statement for the current value. */
  readonly statementKey: I18nKey
  readonly enabled: boolean
}

export interface SetupReview {
  /** Every listed item is planned: one banner, no per-row tags. */
  readonly banner: boolean
  readonly chosen: readonly SetupReviewRow[]
  readonly basics: readonly SetupReviewRow[]
  readonly about: readonly SetupReviewStatement[]
  readonly more: readonly SetupReviewRow[]
  /** `setup.review.teamNote`: the team is on. */
  readonly teamNote: boolean
  /** `setup.review.vatNotSure`: the answer was "Not sure" and VAT is still off. */
  readonly vatNotSureNote: boolean
}

export interface SetupReviewInput {
  readonly answers: SetupAnswers
  readonly recommendation: Recommendation
  /** The current state (switch values). */
  readonly state: SetupState
  /**
   * The state the groups are built from (default: `state`). Keep the one from the last capability
   * change, so toggling a module keeps its row in place; groups are recomputed when a capability
   * changes.
   */
  readonly layout?: SetupState
}

/**
 * Whether an off module is offered under "More sections you can add" (§6.7): not when it clearly does
 * not fit the answers. Projects (big jobs in stages, with workers and materials) is not offered to food
 * businesses, to businesses that only resell goods, or to someone working alone from home.
 */
function offeredInMore(id: ModuleId, answers: SetupAnswers): boolean {
  if (id !== 'projects') return true
  const what = answers.what_you_do ?? []
  if (has(what, 'food_drinks')) return false
  if (what.length > 0 && what.every((v) => v === 'sell_products')) return false
  return !(answers.workplace === 'home' && answers.team === 'alone')
}

const MANIFESTS: readonly ModuleManifest[] = MODULES
const BY_ID: ReadonlyMap<ModuleId, ModuleManifest> = new Map(MANIFESTS.map((m) => [m.id, m]))
const listed = (id: ModuleId) => !ALWAYS_ENABLED_MODULE_IDS.includes(id)

function capabilityOn(state: SetupState, key: CapabilityKey): boolean {
  return isSetupItemOn(state, { kind: 'capability', key })
}

export function buildSetupReview(input: SetupReviewInput): SetupReview {
  const { recommendation: rec, state } = input
  const layout = input.layout ?? state
  const answers = normalizeAnswers(input.answers).answers
  // Read with the current switches, so a reason never contradicts a statement the user flipped.
  const { reasons, offNotes: notes } = setupTexts(answers, rec, state)
  const manifestOf = (id: ModuleId) => BY_ID.get(id)!

  const onText = (id: ModuleId) =>
    reasons.get(id) ?? moduleDescriptionKey(id) ?? key(`setup.reason.${id}.default`)
  const offText = (id: ModuleId) =>
    notes.get(id) ??
    moduleDescriptionKey(id) ??
    reasons.get(id) ??
    key(`setup.reason.${id}.default`)

  type Draft = Omit<SetupReviewRow, 'soon'> & { readonly availability: ModuleAvailability }
  const moduleRow = (id: ModuleId, textKey: I18nKey): Draft => ({
    item: { kind: 'module', id },
    nameKey: moduleNameKey(id),
    textKey,
    enabled: state.modules.has(id),
    needsVat:
      manifestOf(id).requiresCapabilities.includes('vat_registered') && !state.vatRegistered,
    availability: manifestOf(id).availability,
  })
  const jobsRow = (textKey: I18nKey): Draft => ({
    item: JOBS_ITEM,
    nameKey: JOBS_NAME,
    textKey,
    enabled: state.capabilities.jobs_and_tasks,
    needsVat: false,
    availability: JOBS_AVAILABILITY,
  })

  const chosen: Draft[] = []
  if (layout.capabilities.jobs_and_tasks) chosen.push(jobsRow(rec.jobsReason ?? JOBS_DESCRIPTION))
  const basics: Draft[] = []
  const more: Draft[] = []
  for (const id of MODULE_IDS.filter(listed)) {
    const m = manifestOf(id)
    if (layout.modules.has(id)) {
      ;(m.kind === 'optional' ? chosen : basics).push(moduleRow(id, onText(id)))
    } else if (
      m.requiresCapabilities.every((cap) => capabilityOn(layout, cap)) &&
      offeredInMore(id, answers)
    ) {
      more.push(moduleRow(id, offText(id)))
    }
  }
  const what = answers.what_you_do
  const jobsOffered =
    isQuestionShown(setupQuestion('how_you_make'), answers) ||
    (has(what, 'services') && !has(what, 'food_drinks') && !has(what, 'projects'))
  if (!layout.capabilities.jobs_and_tasks && jobsOffered) more.push(jobsRow(JOBS_DESCRIPTION))

  const rows = [...chosen, ...basics, ...more]
  const allPlanned = rows.every((r) => r.availability === 'planned')
  const finish = (list: Draft[]): SetupReviewRow[] =>
    list.map(({ availability, ...row }) => ({
      ...row,
      soon: !allPlanned && availability === 'planned',
    }))

  const stockOffered = shownOptions(setupQuestion('work_setup'), answers).some(
    (o) => o.id === 'stock',
  )
  const statementShown: Record<StatementKey, boolean> = {
    has_team: true,
    multi_location: isQuestionShown(setupQuestion('branches'), answers),
    keeps_stock: stockOffered,
    uses_machines: true,
    sells_via_pos: isQuestionShown(setupQuestion('pos'), answers),
    vat_registered: true,
  }
  const recOn = (k: StatementKey) =>
    k === 'vat_registered' ? rec.vatRegistered === true : rec.capabilities[k]
  const about = STATEMENT_KEYS.filter(
    (k) => statementShown[k] || recOn(k) || capabilityOn(state, k),
  ).map((k): SetupReviewStatement => {
    const enabled = capabilityOn(state, k)
    return {
      key: k,
      item: { kind: 'capability', key: k },
      topicKey: key(`setup.cap.${k}.topic`),
      statementKey: key(`setup.cap.${k}.${enabled ? 'on' : 'off'}`),
      enabled,
    }
  })

  return {
    banner: rows.length > 0 && allPlanned,
    chosen: finish(chosen),
    basics: finish(basics),
    about,
    more: finish(more),
    teamNote: state.capabilities.has_team,
    vatNotSureNote: answers.vat === 'not_sure' && !state.vatRegistered,
  }
}

/**
 * The statements of the business home's welcome card (§6.8), from the saved capabilities: team and
 * VAT always; branches, stock, machine time, POS and cost per job only when on (a home business was
 * never asked about branches). Apply the business's terminology profile to
 * `setup.cap.jobs_and_tasks.on`.
 */
export function businessSummaryKeys(capabilities: Capabilities): I18nKey[] {
  const always: readonly CapabilityKey[] = ['has_team', 'vat_registered']
  return (
    [
      'has_team',
      'multi_location',
      'keeps_stock',
      'uses_machines',
      'sells_via_pos',
      'jobs_and_tasks',
      'vat_registered',
    ] as const
  ).flatMap((k) => {
    const on = capabilities[k]
    if (!on && !always.includes(k)) return []
    return [key(`setup.cap.${k}.${on ? 'on' : 'off'}`)]
  })
}
