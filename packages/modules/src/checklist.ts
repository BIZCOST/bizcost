import type {
  ChecklistItemDto,
  ChecklistItemId,
  CostStepDto,
  CostStepId,
  CostStepPart,
  ProfilePart,
} from '@bizcost/contracts'
import type { SensitivityCategory } from '@bizcost/domain'
import type { CapabilityKey } from './capabilities'
import type { ModuleId } from './manifests'
import type { PermissionKey } from './permissions'

// The getting-started checklist of the Dashboard (docs/PRODUCT.md §10, D-090): steps built from real
// data. A member sees a step only when it applies to the business (its capability is on) and they can
// act on it (they hold the permission its settings section needs to make the change). The first team
// member and the second branch are milestones: a member who joined after one was reached never gets
// that step. The API computes the state (dashboard.checklist); the web uses the same rules to size
// its placeholder.

interface ChecklistRule {
  readonly id: ChecklistItemId
  /** The permission that lets the member do the step. */
  readonly permission: PermissionKey
  /** The capability the step needs, if any. */
  readonly capability: CapabilityKey | null
}

/** The steps in the order shown. */
export const CHECKLIST_RULES: readonly ChecklistRule[] = [
  { id: 'profile', permission: 'settings.business.edit', capability: null },
  { id: 'trn', permission: 'settings.business.edit', capability: 'vat_registered' },
  { id: 'invite', permission: 'settings.members.manage', capability: 'has_team' },
  { id: 'location', permission: 'settings.locations.manage', capability: 'multi_location' },
]

/** The steps this member sees in this business, in order (none: a welcome without a checklist). */
export function checklistItemIds(
  capabilities: Readonly<Record<string, boolean>>,
  can: (key: PermissionKey) => boolean,
): ChecklistItemId[] {
  return CHECKLIST_RULES.filter(
    (rule) =>
      (rule.capability === null || capabilities[rule.capability] === true) && can(rule.permission),
  ).map((rule) => rule.id)
}

/** What the business's data says about the steps (read by the API in one statement). */
export interface ChecklistFacts {
  readonly legalName: string
  readonly legalNameAr: string | null
  readonly hasLogo: boolean
  readonly trn: string | null
  /** Active members, the caller included. */
  readonly activeMembers: number
  /** Invitations waiting for an answer that have not expired. */
  readonly pendingInvitations: number
  /** Branches that are not removed. */
  readonly locations: number
  /** Someone was a member of the business before the caller joined (the team had started). */
  readonly teamBeforeMember: boolean
  /** The business had its second branch (of those not removed) before the caller joined. */
  readonly secondBranchBeforeMember: boolean
}

const ARABIC_LETTER = /(?=\p{Script=Arabic})\p{L}/u

/**
 * The business has its name in Arabic: the Arabic name is filled in, or the name itself is written in
 * Arabic (then a second Arabic name adds nothing).
 */
export function hasArabicName(facts: Pick<ChecklistFacts, 'legalName' | 'legalNameAr'>): boolean {
  return (facts.legalNameAr ?? '').trim() !== '' || ARABIC_LETTER.test(facts.legalName)
}

function missingProfileParts(facts: ChecklistFacts): ProfilePart[] {
  const missing: ProfilePart[] = []
  if (!hasArabicName(facts)) missing.push('arabicName')
  if (!facts.hasLogo) missing.push('logo')
  return missing
}

/**
 * A step's state: the profile is complete with its name in Arabic and a logo; the TRN is saved; the
 * team has started once someone else is an active member or has an invitation waiting; a second
 * branch exists.
 */
export function checklistItem(id: ChecklistItemId, facts: ChecklistFacts): ChecklistItemDto {
  switch (id) {
    case 'profile': {
      const missing = missingProfileParts(facts)
      return { id, done: missing.length === 0, missing }
    }
    case 'trn':
      return { id, done: facts.trn !== null && facts.trn !== '', missing: [] }
    case 'invite':
      return { id, done: facts.activeMembers > 1 || facts.pendingInvitations > 0, missing: [] }
    case 'location':
      return { id, done: facts.locations > 1, missing: [] }
  }
}

/**
 * Whether a step is the member's to see: not when it is a milestone the business reached before they
 * joined (an admin invited into a team never gets "Invite your first team member"; a manager who
 * joined a business with two branches never gets "Add your second branch"). Once the milestone is
 * lost again (the others left, a branch was removed), the step is open and shows to everyone.
 */
function reachedBeforeMember(item: ChecklistItemDto, facts: ChecklistFacts): boolean {
  if (!item.done) return false
  if (item.id === 'invite') return facts.teamBeforeMember
  if (item.id === 'location') return facts.secondBranchBeforeMember
  return false
}

/** The member's steps (`checklistItemIds`) with their state, without those reached before they joined. */
export function checklistItems(
  ids: readonly ChecklistItemId[],
  facts: ChecklistFacts,
): ChecklistItemDto[] {
  return ids
    .map((id) => checklistItem(id, facts))
    .filter((item) => !reachedBeforeMember(item, facts))
}

// ---------------------------------------------------------------------------------------------------
// "Let's find the real cost of what you sell" (PRODUCT.md §10, M2 Step 7)
// ---------------------------------------------------------------------------------------------------

interface CostStepRule {
  readonly id: CostStepId
  /** The modules the step works in: each must be active (released and on). */
  readonly modules: readonly ModuleId[]
  /** Every key the member needs to do the step and read its state. */
  readonly permissions: readonly PermissionKey[]
  /** Categories the member must see: the step is about amounts they could not read otherwise. */
  readonly categories: readonly SensitivityCategory[]
  /** Only for a business without a team (the owner's own time, D-119). */
  readonly withoutTeam: boolean
}

/** The cost steps in the order shown (PRODUCT.md §10). */
export const COST_STEP_RULES: readonly CostStepRule[] = [
  {
    id: 'products',
    modules: ['products'],
    permissions: ['products.items.manage'],
    categories: [],
    withoutTeam: false,
  },
  {
    id: 'recipes',
    modules: ['products', 'materials'],
    permissions: ['products.items.view', 'materials.items.view', 'products.recipes.manage'],
    categories: [],
    withoutTeam: false,
  },
  {
    // Which materials still need a price depends on what goes into the products (D-150).
    id: 'purchases',
    modules: ['purchases', 'materials', 'products'],
    permissions: [
      'purchases.documents.manage',
      'purchases.documents.post',
      'products.recipes.view',
      'materials.items.view',
    ],
    categories: [],
    withoutTeam: false,
  },
  {
    id: 'running_costs',
    modules: ['running_costs'],
    permissions: ['running_costs.items.manage'],
    categories: [],
    withoutTeam: false,
  },
  {
    // The hourly rate (Settings → How costs are worked out) and the minutes on each product.
    id: 'owner_time',
    modules: ['cost_engine', 'products'],
    permissions: [
      'cost_engine.product_costs.view',
      'cost_engine.settings.manage',
      'running_costs.items.view',
      'purchases.documents.view',
      'products.items.manage',
    ],
    categories: ['cost'],
    withoutTeam: true,
  },
  {
    id: 'product_costs',
    modules: ['cost_engine', 'products'],
    permissions: [
      'products.items.view',
      'materials.items.view',
      'products.recipes.view',
      'cost_engine.product_costs.view',
    ],
    categories: ['cost'],
    withoutTeam: false,
  },
]

/** What decides which cost steps a member sees. */
export interface CostStepAccess {
  /** The module is released and on for the business (with the server's registry). */
  readonly active: (id: ModuleId) => boolean
  readonly can: (key: PermissionKey) => boolean
  readonly visible: ReadonlySet<SensitivityCategory>
  readonly capabilities: Readonly<Record<string, boolean>>
}

/** The cost steps this member sees in this business, in order (none: no cost checklist). */
export function costStepIds(access: CostStepAccess): CostStepId[] {
  return COST_STEP_RULES.filter(
    (rule) =>
      rule.modules.every(access.active) &&
      rule.permissions.every(access.can) &&
      rule.categories.every((c) => access.visible.has(c)) &&
      (!rule.withoutTeam || access.capabilities.has_team !== true),
  ).map((rule) => rule.id)
}

/** What the business's data says about the cost steps (read by the API; D-116, D-117, D-119, D-186). */
export interface CostFacts {
  /** Products and services that are not archived. */
  readonly items: number
  /** Of those, products made here: not services, not bought ready to sell (D-117). */
  readonly madeProducts: number
  /** Of those, the ones without what goes into them (no recipe line). */
  readonly madeWithoutRecipe: number
  /** Materials the items use (their recipes' lines, or what they are bought as, D-117). */
  readonly usedMaterials: number
  /** Of those, the ones never bought: "no price yet" (D-147). */
  readonly unpricedMaterials: number
  /** A running cost was entered (removed ones aside, D-186). */
  readonly runningCostsEntered: boolean
  /**
   * Running costs are entered but cannot reach products: 3 months of purchases do not count yet and
   * there is no estimate of monthly purchases (D-116, D-186).
   */
  readonly estimateNeeded: boolean
  /** Whether the member may set the estimate (Settings → How costs are worked out). */
  readonly canSetEstimate: boolean
  readonly hourlyRateSet: boolean
  /** Items with the owner's minutes (D-119). */
  readonly itemsWithMinutes: number
  /**
   * Items whose cost for one unit sold is incomplete (the Product costs page's count, D-186), without
   * the services that wait only for what they cannot carry yet (awaitsServiceShare, D-200).
   */
  readonly incompleteCosts: number
  /**
   * The business sells only services: every item in use is a service, or with none yet it was set up
   * as a services business (D-200).
   */
  readonly sellsOnlyServices: boolean
  /** The Materials module is on (a service may use materials only then). */
  readonly materialsOn: boolean
}

/**
 * Whether a cost step applies to the business's data (until something is added, every step does):
 * "what you use to make it" is not asked of a business whose items are all services or bought ready
 * to sell (D-117; a service's materials are optional, D-186), nor "purchase prices" of one whose
 * items are all services that use no materials. Running costs reach an item through its materials
 * (D-116), so they are not asked of a business that sells only services using none (nor, before any is
 * added, of a services business without Materials) until the owner decides how services carry them
 * (D-200).
 */
function costStepApplies(id: CostStepId, facts: CostFacts): boolean {
  if (id === 'running_costs' && facts.sellsOnlyServices) {
    return facts.items === 0 ? facts.materialsOn : facts.usedMaterials > 0
  }
  if (facts.items === 0) return true
  if (id === 'recipes') return facts.madeProducts > 0
  if (id === 'purchases') return facts.madeProducts > 0 || facts.usedMaterials > 0
  return true
}

/**
 * A cost step's state. Each is done once nothing it covers leaves a cost incomplete: an item added;
 * every product made here has what goes into it; every material the items use has a price; running
 * costs entered (with the estimate once it is needed and the member may set it); the hourly rate and
 * the minutes of at least one item; every cost complete.
 */
export function costStep(id: CostStepId, facts: CostFacts): CostStepDto {
  switch (id) {
    case 'products':
      return { id, done: facts.items > 0, missing: [], remaining: null }
    case 'recipes':
      return {
        id,
        done: facts.madeProducts > 0 && facts.madeWithoutRecipe === 0,
        missing: [],
        remaining: facts.madeProducts > 0 ? facts.madeWithoutRecipe : null,
      }
    case 'purchases':
      return {
        id,
        done: facts.usedMaterials > 0 && facts.unpricedMaterials === 0,
        missing: [],
        remaining: facts.usedMaterials > 0 ? facts.unpricedMaterials : null,
      }
    case 'running_costs': {
      const missing: CostStepPart[] = []
      if (!facts.runningCostsEntered) missing.push('runningCosts')
      if (facts.estimateNeeded && facts.canSetEstimate) missing.push('estimate')
      return { id, done: missing.length === 0, missing, remaining: null }
    }
    case 'owner_time': {
      const missing: CostStepPart[] = []
      if (!facts.hourlyRateSet) missing.push('hourlyRate')
      if (facts.itemsWithMinutes === 0) missing.push('minutes')
      return { id, done: missing.length === 0, missing, remaining: null }
    }
    case 'product_costs':
      return {
        id,
        done: facts.items > 0 && facts.incompleteCosts === 0,
        missing: [],
        remaining: facts.items > 0 ? facts.incompleteCosts : null,
      }
  }
}

/** The member's cost steps (`costStepIds`) that apply to the business, with their state. */
export function costSteps(ids: readonly CostStepId[], facts: CostFacts): CostStepDto[] {
  return ids.filter((id) => costStepApplies(id, facts)).map((id) => costStep(id, facts))
}
