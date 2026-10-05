import type { I18nKey } from '@bizcost/i18n'
import {
  offeredSensitiveDataSwitches,
  PERMISSION_CATALOG,
  PERMISSION_NEEDS,
  SENSITIVE_DATA_SWITCHES,
  type PermissionKey,
  type SensitiveDataSwitch,
} from '@bizcost/modules'

// The permissions of a role, in plain words and grouped by area, for the Roles section (docs/PRODUCT.md
// §8: "View Product Cost", not `data.cost.view`). Every key of the catalog gets a label and a hint
// (`settings.permissionLabels.<key>` and `settings.permissionHints.<key>`, dots written as underscores;
// a test checks both languages).
// Modules add their keys when they are released; each gets a group named after its module. The
// sensitive data (`data.*`) is offered as switches of its own section, one per kind of data: costs,
// supplier prices and margins are one switch, since each can be worked out from the others (D-190).

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
 * Groups the Roles section does not show as one switch per key: the sensitive data has its own section
 * (`offeredSensitiveSwitches`, M2 Step 7, D-084, D-190). A role keeps the keys no switch offers as they
 * are when it is saved (the editor starts from the role's own keys).
 */
const HIDDEN_GROUPS: ReadonlySet<PermissionGroupId> = new Set(['data'])

/** Keys that only mean something with a capability: hidden (and kept as they are) without it. */
const KEY_CAPABILITY: Readonly<Partial<Record<PermissionKey, string>>> = {
  'settings.locations.manage': 'multi_location',
  // Approval of expenses applies only with a team (D-164).
  'expenses.approval.manage': 'has_team',
}

/**
 * Settings keys that only mean something with one of these modules on: hidden (and kept as they are)
 * without any. Closing the books: purchases, expenses and sales obey the date (D-176, D-201, D-236).
 */
const KEY_MODULES: Readonly<Partial<Record<PermissionKey, readonly string[]>>> = {
  'settings.books.close': ['purchases', 'expenses', 'sales'],
}

/** Groups that belong to Dashboard and Settings, which every business has. */
const BUILT_IN_GROUPS: ReadonlySet<PermissionGroupId> = new Set(['dashboard', 'business', 'team'])

/**
 * The groups and keys the Roles section offers to a business with these capabilities. A module's group
 * shows only while the module is released and on for the business (`modules`: the ids of
 * business.context.modules), so a module still being built (D-124) offers nothing; its keys stay on
 * the role as they are when it is saved.
 */
export function visiblePermissionGroups(
  capabilities: Readonly<Record<string, boolean>>,
  modules: readonly string[],
  catalog: readonly PermissionKey[] = PERMISSION_CATALOG,
): PermissionGroup[] {
  const active = new Set(modules)
  return permissionGroups(catalog)
    .filter((group) => !HIDDEN_GROUPS.has(group.id))
    .filter((group) => BUILT_IN_GROUPS.has(group.id) || active.has(group.id))
    .map((group) => ({
      id: group.id,
      keys: group.keys.filter((key) => {
        const capability = KEY_CAPABILITY[key]
        const modulesNeeded = KEY_MODULES[key]
        return (
          (capability === undefined || capabilities[capability] === true) &&
          (modulesNeeded === undefined || modulesNeeded.some((id) => active.has(id)))
        )
      }),
    }))
    .filter((group) => group.keys.length > 0)
}

/**
 * Switches one permission of a set: on also turns on what it needs, and what that needs; off also
 * turns off what needs it, and what needs that (PERMISSION_NEEDS, which the API enforces too).
 */
export function switchPermission(
  keys: ReadonlySet<string>,
  key: PermissionKey,
  on: boolean,
): Set<string> {
  const next = new Set(keys)
  const pending: PermissionKey[] = [key]
  const seen = new Set<string>()
  while (pending.length > 0) {
    const current = pending.pop()!
    if (seen.has(current)) continue
    seen.add(current)
    if (on) {
      next.add(current)
      pending.push(...(PERMISSION_NEEDS[current] ?? []))
    } else {
      next.delete(current)
      for (const [dependent, needed] of Object.entries(PERMISSION_NEEDS)) {
        if (needed?.includes(current)) pending.push(dependent as PermissionKey)
      }
    }
  }
  return next
}

// ---------------------------------------------------------------------------------------------------
// The sensitive-data section (M2 Step 7, D-190): "See costs, supplier prices and margins" as one
// switch, and later payroll and employees' personal data with the modules that show them.
// ---------------------------------------------------------------------------------------------------

/**
 * The sensitive-data switches for a business with these modules on (the ids of business.context's
 * modules): a switch shows while a module on shows its data (costs: any Costing Core module).
 */
export function offeredSensitiveSwitches(
  modules: readonly string[],
): readonly SensitiveDataSwitch[] {
  return offeredSensitiveDataSwitches(modules)
}

/** Whether a sensitive-data switch is on: every key it grants is in the set. */
export function isSwitchOn(keys: ReadonlySet<string>, sensitive: SensitiveDataSwitch): boolean {
  return sensitive.keys.every((key) => keys.has(key))
}

/** Switches a sensitive-data switch: all its keys together, with what they need or what needs them. */
export function switchSensitive(
  keys: ReadonlySet<string>,
  sensitive: SensitiveDataSwitch,
  on: boolean,
): Set<string> {
  let next = new Set(keys)
  for (const key of sensitive.keys) next = switchPermission(next, key, on)
  return next
}

export function sensitiveLabelKey(sensitive: SensitiveDataSwitch): I18nKey {
  return `settings.sensitive.${sensitive.id}.label` as I18nKey
}

export function sensitiveHintKey(sensitive: SensitiveDataSwitch): I18nKey {
  return `settings.sensitive.${sensitive.id}.hint` as I18nKey
}

/**
 * The labels of a set of permissions, in catalog order, the way the editors switch them: the keys of a
 * sensitive-data switch as the switch's one label (only when all of them are there; "See costs,
 * supplier prices and margins"), every other key as its own.
 */
export function permissionLabelKeys(keys: Iterable<string>): I18nKey[] {
  const set = new Set(keys)
  const out: I18nKey[] = []
  const seen = new Set<string>()
  for (const key of PERMISSION_CATALOG) {
    if (!set.has(key)) continue
    const sensitive = SENSITIVE_DATA_SWITCHES.find((s) =>
      (s.keys as readonly string[]).includes(key),
    )
    if (!sensitive) {
      out.push(permissionLabelKey(key))
      continue
    }
    if (seen.has(sensitive.id)) continue
    seen.add(sensitive.id)
    if (isSwitchOn(set, sensitive) && sensitive.keys.length > 1)
      out.push(sensitiveLabelKey(sensitive))
    else for (const k of sensitive.keys) if (set.has(k)) out.push(permissionLabelKey(k))
  }
  return out
}
