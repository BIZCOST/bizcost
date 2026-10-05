import { OWNER_TEMPLATE_KEY } from '@bizcost/domain'
import type { BusinessAccess } from '../access'

// Rules shared by the team settings (members, invitations, roles). A member who may manage the team
// or the roles is not necessarily an Admin (an owner can give those permissions to any role), so no
// one may hand out, take away or edit access beyond their own: that would let a manager make
// themselves an Admin.

/** The caller holds the Owner role (every permission, and the only one who can transfer ownership). */
export function isOwner(access: BusinessAccess): boolean {
  return access.roleTemplateKey === OWNER_TEMPLATE_KEY
}

/**
 * Whether the caller may grant (or take away) every one of `keys`: an owner always; anyone else only
 * permissions they hold themselves.
 */
export function canGrant(access: BusinessAccess, keys: Iterable<string>): boolean {
  if (access.effective.all) return true
  for (const key of keys) if (!access.effective.keys.has(key)) return false
  return true
}

/**
 * Whether the caller's own branches cover `ids` (an empty set: every branch, which only a member who
 * works in every branch covers). "No access beyond your own" (D-084) for branches (Q12, D-231): a
 * caller limited to some branches changes, removes or widens only members limited within them, and
 * edits only a role whose members all are (D-236).
 */
export function coversBranches(access: BusinessAccess, ids: readonly string[]): boolean {
  const scope = access.locationScope
  if (scope.all) return true
  return ids.length > 0 && ids.every((id) => scope.ids.has(id.toLowerCase()))
}

/**
 * The branches a member invited by the caller works in: a caller limited to some branches invites
 * into those only (D-236); empty (every branch) for anyone else.
 */
export function invitedBranches(access: BusinessAccess): string[] {
  const scope = access.locationScope
  return scope.all ? [] : [...scope.ids].sort()
}
