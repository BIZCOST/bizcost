import type { BusinessContextDto, CostStepDto, CostStepId } from '@bizcost/contracts'
import type { SensitivityCategory, TerminologyProfile } from '@bizcost/domain'
import type { I18nKey } from '@bizcost/i18n'
import { costStepIds, type ModuleId } from '@bizcost/modules'
import {
  CalculatorIcon,
  ClockIcon,
  RepeatIcon,
  ShoppingCartIcon,
  SoupIcon,
  TagIcon,
  type LucideIcon,
} from 'lucide-react'
import { can, sectionPath } from '../settings/sections'

// "Let's find the real cost of what you sell" (docs/PRODUCT.md §10, M2 Step 7, D-193): how the
// Dashboard shows each cost step: its icon, its words (what is still missing, from the step's state),
// and where it is done. Which steps a member sees is `costStepIds` of @bizcost/modules, the rules the
// API applies (the page sizes its placeholder with them).

/** The cost steps this member sees in this business (none: no cost checklist). */
export function costStepIdsFor(
  context: Pick<
    BusinessContextDto,
    'modules' | 'permissions' | 'capabilities' | 'visibleCategories'
  >,
): CostStepId[] {
  const on = new Set(context.modules.map((module) => module.id))
  return costStepIds({
    active: (id: ModuleId) => on.has(id),
    can: (key) => can(context, key),
    visible: new Set<SensitivityCategory>(context.visibleCategories),
    capabilities: context.capabilities,
  })
}

const ICONS: Readonly<Record<CostStepId, LucideIcon>> = {
  products: TagIcon,
  recipes: SoupIcon,
  purchases: ShoppingCartIcon,
  running_costs: RepeatIcon,
  owner_time: ClockIcon,
  product_costs: CalculatorIcon,
}

export interface CostStepView {
  readonly id: CostStepId
  readonly done: boolean
  readonly icon: LucideIcon
  readonly titleKey: I18nKey
  /** What is left to do (with `count` for the ones that count), or what was done. */
  readonly bodyKey: I18nKey
  readonly count: number | null
  readonly actionKey: I18nKey
  readonly href: string
}

const base = (id: CostStepId) => `dashboard.costs.steps.${id}`

/**
 * The steps' words that name products, with the words of a business that sells only services
 * (business.context's `sellsOnlyServices`, D-200): `<key>_services`, and `remainingServices` for the
 * counted one.
 */
const SERVICES_WORDING: ReadonlySet<string> = new Set([
  'products.todo',
  'products.action',
  'running_costs.runningCosts',
  'owner_time.both',
  'owner_time.minutes',
  'product_costs.title',
  'product_costs.todo',
  'product_costs.remaining',
  'product_costs.done',
  'product_costs.action',
])

/** A step's key in the business's words: services ones for a business that sells only services. */
function worded(key: I18nKey, servicesOnly: boolean): I18nKey {
  const part = key.replace('dashboard.costs.steps.', '')
  if (!servicesOnly || !SERVICES_WORDING.has(part)) return key
  return `${key}${part.endsWith('.remaining') ? 'Services' : '_services'}` as I18nKey
}

/** A page of the business (`path` below its root). */
function page(businessId: string, path: string): string {
  return `/b/${businessId}/${path}`
}

/** What the step says while it is open, and where it leads (the first thing still missing). */
function open(
  step: CostStepDto,
  businessId: string,
  food: boolean,
): Pick<CostStepView, 'bodyKey' | 'count' | 'actionKey' | 'href'> {
  const key = base(step.id)
  const counted = step.remaining !== null && step.remaining > 0
  const remaining = (foodKey: boolean) =>
    `${key}.${foodKey && food ? 'remainingFood' : 'remaining'}` as I18nKey
  switch (step.id) {
    case 'products':
      return {
        bodyKey: `${key}.todo` as I18nKey,
        count: null,
        actionKey: `${key}.action` as I18nKey,
        href: page(businessId, 'products/new'),
      }
    case 'recipes':
      return {
        bodyKey: counted ? remaining(true) : (`${key}.todo` as I18nKey),
        count: counted ? step.remaining : null,
        actionKey: `${key}.action` as I18nKey,
        href: page(businessId, 'products'),
      }
    case 'purchases':
      return {
        bodyKey: counted ? remaining(true) : (`${key}.todo` as I18nKey),
        count: counted ? step.remaining : null,
        actionKey: `${key}.action` as I18nKey,
        href: page(businessId, 'purchases/new'),
      }
    case 'running_costs': {
      const entries = step.missing.includes('runningCosts')
      const estimate = step.missing.includes('estimate')
      return {
        bodyKey:
          `${key}.${entries && estimate ? 'both' : entries ? 'runningCosts' : 'estimate'}` as I18nKey,
        count: null,
        actionKey: `${key}.${entries ? 'action' : 'actionEstimate'}` as I18nKey,
        href: entries ? page(businessId, 'running-costs') : sectionPath(businessId, 'costing'),
      }
    }
    case 'owner_time': {
      const rate = step.missing.includes('hourlyRate')
      const minutes = step.missing.includes('minutes')
      return {
        bodyKey: `${key}.${rate && minutes ? 'both' : rate ? 'hourlyRate' : 'minutes'}` as I18nKey,
        count: null,
        actionKey: `${key}.${rate ? 'action' : 'actionMinutes'}` as I18nKey,
        href: rate ? sectionPath(businessId, 'costing') : page(businessId, 'products'),
      }
    }
    case 'product_costs':
      return {
        bodyKey: counted ? remaining(false) : (`${key}.todo` as I18nKey),
        count: counted ? step.remaining : null,
        actionKey: `${key}.action` as I18nKey,
        href: page(businessId, 'product-costs'),
      }
  }
}

/**
 * What a step shows: its keys (in the business's terminology once resolved with its profile; the
 * services words for a business that sells only services, `servicesOnly`), its count and its link.
 */
export function costStepView(
  businessId: string,
  step: CostStepDto,
  profile: TerminologyProfile | null | undefined,
  servicesOnly = false,
): CostStepView {
  const key = base(step.id)
  const shared = { id: step.id, done: step.done, icon: ICONS[step.id] }
  const view: CostStepView = step.done
    ? {
        ...shared,
        titleKey: `${key}.title` as I18nKey,
        bodyKey: `${key}.done` as I18nKey,
        count: null,
        actionKey: `${key}.action` as I18nKey,
        href: page(businessId, step.id === 'product_costs' ? 'product-costs' : 'products'),
      }
    : {
        ...shared,
        titleKey: `${key}.title` as I18nKey,
        ...open(step, businessId, profile === 'food'),
      }
  return {
    ...view,
    titleKey: worded(view.titleKey, servicesOnly),
    bodyKey: worded(view.bodyKey, servicesOnly),
    actionKey: worded(view.actionKey, servicesOnly),
  }
}

/**
 * The words of "Your product costs are ready": what the costs come from. The owner's time counts only
 * without a team (D-119); a business that sells only services reads about its services, whose costs
 * running costs do not reach yet (D-200).
 */
export function costsReadyKeys({
  servicesOnly,
  ownerTime,
}: {
  servicesOnly: boolean
  ownerTime: boolean
}) {
  const kind = servicesOnly ? 'Services' : ''
  return {
    title: servicesOnly ? 'dashboard.costs.ready.title_services' : 'dashboard.costs.ready.title',
    body: `dashboard.costs.ready.body${kind}${ownerTime ? '' : 'WithoutTime'}`,
    action: servicesOnly ? 'dashboard.costs.ready.action_services' : 'dashboard.costs.ready.action',
  } as const
}

/** "n of m done", whether all are done, and the first step still open (the next one). */
export function costProgress(steps: readonly CostStepDto[]): {
  done: number
  total: number
  complete: boolean
  next: CostStepId | null
} {
  const done = steps.filter((step) => step.done).length
  return {
    done,
    total: steps.length,
    complete: steps.length > 0 && done === steps.length,
    next: steps.find((step) => !step.done)?.id ?? null,
  }
}
