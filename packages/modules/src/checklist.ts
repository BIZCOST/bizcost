import type { ChecklistItemDto, ChecklistItemId, ProfilePart } from '@bizcost/contracts'
import type { CapabilityKey } from './capabilities'
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
