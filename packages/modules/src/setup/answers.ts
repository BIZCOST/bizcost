// Smart Setup answers, question set v1 (docs/PRODUCT.md §6.1). The question set is versioned data:
// a change to questions, options or rules that changes what an answer means bumps the version, and
// the server refuses answers to another version.

export const QUESTION_SET_VERSION = 1

export const WHAT_YOU_DO_OPTIONS = [
  'sell_products',
  'make_products',
  'food_drinks',
  'services',
  'projects',
  'other',
] as const
export type WhatYouDo = (typeof WHAT_YOU_DO_OPTIONS)[number]

export const HOW_YOU_MAKE_OPTIONS = ['catalog', 'custom_jobs', 'batches'] as const
export type HowYouMake = (typeof HOW_YOU_MAKE_OPTIONS)[number]

export const WORKPLACE_OPTIONS = [
  'home',
  'shop',
  'office',
  'workshop',
  'factory',
  'kitchen',
  'customer_sites',
] as const
export type Workplace = (typeof WORKPLACE_OPTIONS)[number]

export const TEAM_OPTIONS = ['alone', 'team'] as const
export type TeamAnswer = (typeof TEAM_OPTIONS)[number]

export const TEAM_TRACKING_OPTIONS = ['hours', 'salaries', 'staff_cash', 'cost_only'] as const
export type TeamTracking = (typeof TEAM_TRACKING_OPTIONS)[number]

export const WORK_SETUP_OPTIONS = ['materials', 'stock', 'machines', 'vehicles', 'none'] as const
export type WorkSetup = (typeof WORK_SETUP_OPTIONS)[number]

export const SALES_CHANNEL_OPTIONS = [
  'walk_in',
  'messages',
  'online',
  'quotes',
  'invoice_later',
] as const
export type SalesChannel = (typeof SALES_CHANNEL_OPTIONS)[number]

export const VAT_OPTIONS = ['yes', 'no', 'not_sure'] as const
export type VatAnswer = (typeof VAT_OPTIONS)[number]

/**
 * Answers by question id. single = option id, yes_no = boolean, multi = a set of option ids (order
 * never matters; normalized answers list them in option order).
 */
export interface SetupAnswers {
  readonly what_you_do?: readonly WhatYouDo[]
  readonly how_you_make?: readonly HowYouMake[]
  readonly workplace?: Workplace
  readonly branches?: boolean
  readonly team?: TeamAnswer
  readonly team_tracking?: readonly TeamTracking[]
  readonly work_setup?: readonly WorkSetup[]
  readonly sales_channels?: readonly SalesChannel[]
  readonly pos?: boolean
  readonly vat?: VatAnswer
}

/** The questions in their fixed order. */
export const SETUP_QUESTION_IDS = [
  'what_you_do',
  'how_you_make',
  'workplace',
  'branches',
  'team',
  'team_tracking',
  'work_setup',
  'sales_channels',
  'pos',
  'vat',
] as const satisfies readonly (keyof SetupAnswers)[]
export type SetupQuestionId = (typeof SETUP_QUESTION_IDS)[number]

/** False when `xs` is undefined (PRODUCT.md §6.1 `has`). */
export function has<T>(xs: readonly T[] | undefined, value: T): boolean {
  return xs?.includes(value) ?? false
}

/** Selling or making goods (PRODUCT.md §6.1 `SELLS_MAKES`). */
export const SELLS_MAKES = ['sell_products', 'make_products', 'food_drinks'] as const

export function sellsOrMakes(a: SetupAnswers): boolean {
  return SELLS_MAKES.some((v) => has(a.what_you_do, v))
}
