import type { I18nKey } from '@bizcost/i18n'
import { PERMISSION_CATALOG, PERMISSION_NEEDS, type PermissionKey } from '@bizcost/modules'

// The permissions of a role, in plain words and grouped by area, for the Roles section (docs/PRODUCT.md
// §8: "View Product Cost", not `data.cost.view`). Every key of the catalog gets a label and a hint
// (`settings.permissionLabels.<key>` and `settings.permissionHints.<key>`, dots written as underscores;
// a test checks both languages).
// Modules add their keys when they are released; each gets a group named after its module.

export type PermissionGroupId = 'dashboard' | 'business' | 'team' | 'data' | (string & {})

export interface PermissionGroup {
  readonly id: PermissionGroupId
  readonly keys: readonly PermissionKey[]
}

const TEAM_KEYS: ReadonlySet<string> = new Set([
  'settings.members.view',
  'settings.members.manage',
  'settings.roles.manage',
])

function groupOf(key: PermissionKey): PermissionGroupId {
  if (TEAM_KEYS.has(key)) return 'team'
  const area = key.split('.')[0]!
  return area === 'settings' ? 'business' : area
}

/** The catalog's keys by group: dashboard, business, team, sensitive data, then modules. */
export function permissionGroups(catalog: readonly PermissionKey[] = PERMISSION_CATALOG) {
  const order = ['dashboard', 'business', 'team']
  const groups = new Map<PermissionGroupId, PermissionKey[]>()
  for (const key of catalog) {
    const id = groupOf(key)
    groups.set(id, [...(groups.get(id) ?? []), key])
  }
  const rank = (id: string) => {
    const index = order.indexOf(id)
    if (index >= 0) return index
    return id === 'data' ? Number.MAX_SAFE_INTEGER : order.length
  }
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([id, keys]): PermissionGroup => ({ id, keys }))
}

export function permissionLabelKey(key: PermissionKey): I18nKey {
  return `settings.permissionLabels.${key.replaceAll('.', '_')}` as I18nKey
}

export function permissionHintKey(key: PermissionKey): I18nKey {
  return `settings.permissionHints.${key.replaceAll('.', '_')}` as I18nKey
}

/** The group's title: the built-in areas have their own; a module's group is the module's name. */
export function groupTitleKey(id: PermissionGroupId): I18nKey {
  return (
    ['dashboard', 'business', 'team', 'data'].includes(id)
      ? `settings.roles.groups.${id}`
      : `modules.${id}.name`
  ) as I18nKey
}

/**
 * Groups the Roles section does not show in M1: the sensitive-fields section ships with the first module
 * that has sensitive fields (docs/PRODUCT.md §8, ROADMAP.md M1 out of scope, D-084). A role keeps its
 * hidden keys as they are when it is saved (the editor starts from the role's own keys).
 */
const HIDDEN_GROUPS: ReadonlySet<PermissionGroupId> = new Set(['data'])

/** Keys that only mean something with a capability: hidden (and kept as they are) without it. */
const KEY_CAPABILITY: Readonly<Partial<Record<PermissionKey, string>>> = {
  'settings.locations.manage': 'multi_location',
}

/** The groups and keys the Roles section offers to a business with these capabilities. */
export function visiblePermissionGroups(
  capabilities: Readonly<Record<string, boolean>>,
  catalog: readonly PermissionKey[] = PERMISSION_CATALOG,
): PermissionGroup[] {
  return permissionGroups(catalog)
    .filter((group) => !HIDDEN_GROUPS.has(group.id))
    .map((group) => ({
      id: group.id,
      keys: group.keys.filter((key) => {
        const capability = KEY_CAPABILITY[key]
        return capability === undefined || capabilities[capability] === true
      }),
    }))
    .filter((group) => group.keys.length > 0)
}

/**
 * Switches one permission of a set: on also turns on what it needs; off also turns off what needs it
 * (PERMISSION_NEEDS, which the API enforces too).
 */
export function switchPermission(
  keys: ReadonlySet<string>,
  key: PermissionKey,
  on: boolean,
): Set<string> {
  const next = new Set(keys)
  if (on) {
    next.add(key)
    const needed = PERMISSION_NEEDS[key]
    if (needed) next.add(needed)
  } else {
    next.delete(key)
    for (const [dependent, needed] of Object.entries(PERMISSION_NEEDS)) {
      if (needed === key) next.delete(dependent)
    }
  }
  return next
}
