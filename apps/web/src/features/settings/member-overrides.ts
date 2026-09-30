import type { UpdateMemberPermissionsInput } from '@bizcost/contracts'
import type { PermissionKey, SensitiveDataSwitch } from '@bizcost/modules'

// A member's own permissions (M2 Step 7, D-191) as member.updatePermissions takes them: only how what
// they may do differs from their role, saved whole.

/** The member's own changes: how `wanted` differs from their role's keys, by key. */
export function overridesFor(
  wanted: ReadonlySet<string>,
  roleKeys: readonly string[],
): UpdateMemberPermissionsInput['overrides'] {
  const role = new Set(roleKeys)
  const allow = [...wanted].filter((key) => !role.has(key))
  const deny = roleKeys.filter((key) => !wanted.has(key))
  return [
    ...allow.map((key) => ({ key, effect: 'allow' as const })),
    ...deny.map((key) => ({ key, effect: 'deny' as const })),
  ].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** How many switches differ from the role, as the page shows them (a sensitive switch counts once). */
export function changeCount(
  keys: ReadonlySet<string>,
  roleKeys: ReadonlySet<string>,
  sensitive: readonly SensitiveDataSwitch[],
): number {
  const grouped = new Set<string>(sensitive.flatMap((s) => s.keys))
  let count = 0
  for (const key of new Set([...keys, ...roleKeys])) {
    if (!grouped.has(key) && keys.has(key) !== roleKeys.has(key)) count++
  }
  for (const item of sensitive) {
    const now = item.keys.every((key) => keys.has(key))
    const before = item.keys.every((key) => roleKeys.has(key))
    if (now !== before) count++
  }
  return count
}

/** A switch of the page that differs from the member's role. */
export interface ChangedSwitch {
  /** The permission key, or `sensitive:<id>` for a sensitive-data switch (the row's key). */
  readonly switchKey: string
  readonly permission: PermissionKey | null
  readonly sensitive: SensitiveDataSwitch | null
  readonly change: 'added' | 'removed'
}

/**
 * The switches the page shows that differ from the role, in the page's order (the sensitive-data
 * section first, then the groups): named under "N changes from their role", each leading to its
 * switch (D-200).
 */
export function changedSwitches(
  keys: ReadonlySet<string>,
  roleKeys: ReadonlySet<string>,
  sensitive: readonly SensitiveDataSwitch[],
  groups: readonly { readonly keys: readonly PermissionKey[] }[],
): ChangedSwitch[] {
  const out: ChangedSwitch[] = []
  for (const item of sensitive) {
    const now = item.keys.every((key) => keys.has(key))
    const before = item.keys.every((key) => roleKeys.has(key))
    if (now !== before) {
      out.push({
        switchKey: `sensitive:${item.id}`,
        permission: null,
        sensitive: item,
        change: now ? 'added' : 'removed',
      })
    }
  }
  for (const group of groups) {
    for (const key of group.keys) {
      if (keys.has(key) !== roleKeys.has(key)) {
        out.push({
          switchKey: key,
          permission: key,
          sensitive: null,
          change: keys.has(key) ? 'added' : 'removed',
        })
      }
    }
  }
  return out
}
