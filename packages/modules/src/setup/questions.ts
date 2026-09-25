import type { I18nKey } from '@bizcost/i18n'
import {
  has,
  sellsOrMakes,
  SETUP_QUESTION_IDS,
  type SetupAnswers,
  type SetupQuestionId,
} from './answers'

// Question set v1 as data (docs/PRODUCT.md §6.2): order, skip logic (`showIf`, pure predicates over
// the earlier answers), options and i18n keys. Keys: `setup.q.<id>.title|short|hint` and
// `setup.q.<id>.opt.<optionId>.label|hint`.

export type SetupQuestionType = 'single' | 'multi' | 'yes_no'

export interface SetupOption {
  /** Option id; for yes_no questions 'true' / 'false' (the answer is the boolean). */
  readonly id: string
  /** Choosing it clears the other options; choosing another option clears it (multi only). */
  readonly exclusive: boolean
  readonly labelKey: I18nKey
  readonly hintKey: I18nKey | null
  /** Absent = always shown. Reads only answers to earlier questions. */
  readonly showIf?: (a: SetupAnswers) => boolean
}

export interface SetupQuestion {
  readonly id: SetupQuestionId
  readonly type: SetupQuestionType
  readonly options: readonly SetupOption[]
  /** Absent = always shown. Reads only answers to earlier questions. */
  readonly showIf?: (a: SetupAnswers) => boolean
  /** Questions whose answer decides whether this one is shown (progress counting, §6.3). */
  readonly dependsOn: readonly SetupQuestionId[]
  readonly titleKey: I18nKey
  /** Name in the desktop side list. */
  readonly shortKey: I18nKey
  /** The hint under the title for these answers; null when the question has none. */
  readonly hint: (a: SetupAnswers) => I18nKey | null
}

const key = (value: string) => value as I18nKey

interface OptionSpec {
  hint?: boolean
  exclusive?: boolean
  showIf?: (a: SetupAnswers) => boolean
}

function option(question: SetupQuestionId, id: string, spec: OptionSpec = {}): SetupOption {
  const base = `setup.q.${question}.opt.${id}`
  return {
    id,
    exclusive: spec.exclusive ?? false,
    labelKey: key(`${base}.label`),
    hintKey: spec.hint ? key(`${base}.hint`) : null,
    ...(spec.showIf ? { showIf: spec.showIf } : {}),
  }
}

function yesNo(question: SetupQuestionId): SetupOption[] {
  return [option(question, 'true'), option(question, 'false')]
}

interface QuestionSpec {
  showIf?: (a: SetupAnswers) => boolean
  dependsOn?: readonly SetupQuestionId[]
  /** true = `setup.q.<id>.hint` always; a function picks the key per answers. */
  hint?: true | ((a: SetupAnswers) => I18nKey | null)
}

function question(
  id: SetupQuestionId,
  type: SetupQuestionType,
  options: readonly SetupOption[],
  spec: QuestionSpec = {},
): SetupQuestion {
  const hintKey = key(`setup.q.${id}.hint`)
  const hint =
    spec.hint === true ? () => hintKey : typeof spec.hint === 'function' ? spec.hint : () => null
  return {
    id,
    type,
    options,
    ...(spec.showIf ? { showIf: spec.showIf } : {}),
    dependsOn: spec.dependsOn ?? [],
    titleKey: key(`setup.q.${id}.title`),
    shortKey: key(`setup.q.${id}.short`),
    hint,
  }
}

const what = (a: SetupAnswers) => a.what_you_do ?? []

/** The `materials` option of work_setup: hidden when what the business buys is already included. */
const materialsShown = (a: SetupAnswers) => !sellsOrMakes(a)

export const SETUP_QUESTIONS: readonly SetupQuestion[] = [
  question(
    'what_you_do',
    'multi',
    [
      option('what_you_do', 'sell_products', { hint: true }),
      option('what_you_do', 'make_products', { hint: true }),
      option('what_you_do', 'food_drinks', { hint: true }),
      option('what_you_do', 'services', { hint: true }),
      option('what_you_do', 'projects', { hint: true }),
      option('what_you_do', 'other'),
    ],
    { hint: true },
  ),
  question(
    'how_you_make',
    'multi',
    [
      option('how_you_make', 'catalog', { hint: true }),
      option('how_you_make', 'custom_jobs', { hint: true }),
      option('how_you_make', 'batches', { hint: true }),
    ],
    {
      // Food is made to order through Orders, never as jobs (§6.2, conflict 2).
      showIf: (a) => has(a.what_you_do, 'make_products') && !has(a.what_you_do, 'food_drinks'),
      dependsOn: ['what_you_do'],
      hint: true,
    },
  ),
  question('workplace', 'single', [
    option('workplace', 'home'),
    option('workplace', 'shop'),
    option('workplace', 'office'),
    option('workplace', 'workshop'),
    option('workplace', 'factory'),
    option('workplace', 'kitchen', {
      hint: true,
      showIf: (a) => has(a.what_you_do, 'food_drinks'),
    }),
    option('workplace', 'customer_sites', { hint: true }),
  ]),
  question('branches', 'yes_no', yesNo('branches'), {
    showIf: (a) => a.workplace !== undefined && a.workplace !== 'home',
    dependsOn: ['workplace'],
    hint: true,
  }),
  question('team', 'single', [
    option('team', 'alone', { hint: true }),
    option('team', 'team', { hint: true }),
  ]),
  question(
    'team_tracking',
    'multi',
    [
      option('team_tracking', 'hours', { hint: true }),
      option('team_tracking', 'salaries'),
      option('team_tracking', 'staff_cash', { hint: true }),
      option('team_tracking', 'cost_only', { exclusive: true }),
    ],
    { showIf: (a) => a.team === 'team', dependsOn: ['team'], hint: true },
  ),
  question(
    'work_setup',
    'multi',
    [
      option('work_setup', 'materials', { hint: true, showIf: materialsShown }),
      // Services-only businesses never see stock (§6, "Changes from the earlier pool").
      option('work_setup', 'stock', {
        hint: true,
        showIf: (a) => what(a).some((v) => v !== 'services'),
      }),
      option('work_setup', 'machines', { hint: true }),
      option('work_setup', 'vehicles', { hint: true }),
      option('work_setup', 'none', { exclusive: true }),
    ],
    {
      hint: (a) =>
        materialsShown(a)
          ? key('setup.q.work_setup.hint')
          : key('setup.q.work_setup.hint_included'),
    },
  ),
  question(
    'sales_channels',
    'multi',
    [
      option('sales_channels', 'walk_in', { showIf: (a) => a.workplace === 'shop' }),
      option('sales_channels', 'messages', { hint: true }),
      option('sales_channels', 'online', { hint: true }),
      option('sales_channels', 'quotes', { hint: true }),
      option('sales_channels', 'invoice_later', { hint: true }),
    ],
    {
      // A projects-only business sells through Quotations, Invoices and Projects.
      showIf: (a) => !(what(a).length === 1 && what(a)[0] === 'projects'),
      dependsOn: ['what_you_do'],
      hint: true,
    },
  ),
  question('pos', 'yes_no', yesNo('pos'), {
    showIf: (a) => a.workplace === 'shop',
    dependsOn: ['workplace'],
    hint: true,
  }),
  question(
    'vat',
    'single',
    [option('vat', 'yes', { hint: true }), option('vat', 'no'), option('vat', 'not_sure')],
    { hint: true },
  ),
]

const BY_ID: ReadonlyMap<SetupQuestionId, SetupQuestion> = new Map(
  SETUP_QUESTIONS.map((q) => [q.id, q]),
)

export function setupQuestion(id: SetupQuestionId): SetupQuestion {
  const found = BY_ID.get(id)
  if (!found) throw new Error(`unknown setup question ${id}`)
  return found
}

export function isSetupQuestionId(value: unknown): value is SetupQuestionId {
  return (SETUP_QUESTION_IDS as readonly unknown[]).includes(value)
}

/** Whether the question is shown for these answers (answers to earlier questions decide). */
export function isQuestionShown(q: SetupQuestion, a: SetupAnswers): boolean {
  return q.showIf ? q.showIf(a) : true
}

/** The options of the question shown for these answers, in their fixed order. */
export function shownOptions(q: SetupQuestion, a: SetupAnswers): readonly SetupOption[] {
  return q.options.filter((o) => (o.showIf ? o.showIf(a) : true))
}
