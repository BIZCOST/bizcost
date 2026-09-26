import type { EnabledModuleDto, NavGroup } from '@bizcost/contracts'
import type { I18nKey } from '@bizcost/i18n'

// The business shell's navigation, derived only from business.context's `modules` (D-089): the
// released modules the business has on, with the entries this member may use. Nothing here names a
// module, so a module that is released later shows in the sidebar, the rail and the tabs without any
// change to the shell (nav.test.ts shows it with a module released in the test).

export interface ShellNavItem {
  readonly id: string
  readonly moduleId: string
  /** The manifest's labelKey, a `nav.*` key of common, as a full key (`common.nav.*`). */
  readonly labelKey: I18nKey
  readonly href: string
  /** A lucide icon name (nav-icons.ts maps it). */
  readonly icon: string
  readonly group: NavGroup
  readonly active: boolean
}

export interface ShellQuickAction {
  readonly id: string
  readonly labelKey: I18nKey
  readonly href: string
  readonly icon: string
}

/** Manifests name their labels as common keys without the namespace (`nav.settings`). */
function commonKey(labelKey: string): I18nKey {
  return `common.${labelKey}` as I18nKey
}

/** A business page: `path` is relative to the business root ('' is the root, the Dashboard). */
export function businessHref(businessId: string, path: string): string {
  return path === '' ? `/b/${businessId}` : `/b/${businessId}/${path}`
}

/** The path of `pathname` below the business root ('' at the root), or null outside it. */
export function businessSubpath(pathname: string, businessId: string): string | null {
  const root = `/b/${businessId}`
  const path = pathname.replace(/[?#].*$/, '').replace(/\/+$/, '')
  if (path === root) return ''
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null
}

/** Whether an entry's path holds `subpath`: the same page, or a page inside it ('' only itself). */
function holds(entryPath: string, subpath: string): boolean {
  if (entryPath === '') return subpath === ''
  return subpath === entryPath || subpath.startsWith(`${entryPath}/`)
}

/**
 * The shell's items: the `main` entries in manifest order, then the `system` ones (Settings). The
 * entry whose path holds the current page is active (the longest, so a module's own pages win).
 */
export function shellNav(
  modules: readonly EnabledModuleDto[],
  businessId: string,
  pathname: string,
): ShellNavItem[] {
  const entries = modules.flatMap((module) =>
    module.nav.map((entry) => ({ ...entry, moduleId: module.id })),
  )
  const ordered = [
    ...entries.filter((entry) => entry.group === 'main'),
    ...entries.filter((entry) => entry.group === 'system'),
  ]
  const subpath = businessSubpath(pathname, businessId)
  const active =
    subpath === null
      ? undefined
      : ordered
          .filter((entry) => holds(entry.path, subpath))
          .sort((a, b) => b.path.length - a.path.length)[0]
  return ordered.map((entry) => ({
    id: entry.id,
    moduleId: entry.moduleId,
    labelKey: commonKey(entry.labelKey),
    href: businessHref(businessId, entry.path),
    icon: entry.icon,
    group: entry.group,
    active: entry === active,
  }))
}

/** The "+" actions of every module the member may use, in manifest order. */
export function shellQuickActions(
  modules: readonly EnabledModuleDto[],
  businessId: string,
): ShellQuickAction[] {
  return modules.flatMap((module) =>
    module.quickActions.map((action) => ({
      id: action.id,
      labelKey: commonKey(action.labelKey),
      href: businessHref(businessId, action.path),
      icon: action.icon,
    })),
  )
}

/** How many sections of each group the shell's placeholder shows while a business loads. */
export interface NavSlots {
  readonly main: number
  readonly system: number
}

/**
 * The placeholder's sections: the released modules' entries (`releasedModules()` of the registry),
 * the most a member can have. Not the business's own (not known yet), and not a fixed number.
 */
export function navSlots(
  manifests: readonly { readonly nav: readonly { readonly group: NavGroup }[] }[],
): NavSlots {
  const groups = manifests.flatMap((manifest) => manifest.nav.map((entry) => entry.group))
  return {
    main: groups.filter((group) => group === 'main').length,
    system: groups.filter((group) => group === 'system').length,
  }
}

/** Places in the phone's tab bar ("+" takes one when a module has actions). */
export const TAB_SLOTS = 5

export interface BottomTabs {
  /** The tabs, in order ("+" goes in the middle of them, when shown). */
  readonly tabs: readonly ShellNavItem[]
  /** The items under "More" (empty: no "More" tab). */
  readonly more: readonly ShellNavItem[]
  /** Whether the "+" tab shows: only when a module the member may use has "+" actions. */
  readonly quickAdd: boolean
}

/**
 * The phone's tab bar: every item when they fit, else the first ones and a "More" tab with the rest
 * (docs/PRODUCT.md §9: Home | Sales | + | Costs | More). No "+" without actions.
 */
export function bottomTabs(
  items: readonly ShellNavItem[],
  quickActions: readonly ShellQuickAction[],
): BottomTabs {
  const quickAdd = quickActions.length > 0
  const slots = TAB_SLOTS - (quickAdd ? 1 : 0)
  if (items.length <= slots) return { tabs: items, more: [], quickAdd }
  return { tabs: items.slice(0, slots - 1), more: items.slice(slots - 1), quickAdd }
}

/**
 * Another section of the shell than module `moduleId` (the first in the nav's order: a `main` one
 * before Settings), or none: where a module's "turned off" or "not open to you" state leads, and
 * where the business root sends a member who may not use the Dashboard.
 */
export function wayBack(
  items: readonly ShellNavItem[],
  moduleId: string,
): ShellNavItem | undefined {
  return items.find((item) => item.moduleId !== moduleId)
}

/** What a module's page shows the member: the page, "not open to you", or "turned off". */
export type ModuleAccess = 'open' | 'forbidden' | 'off'

/**
 * For a module's page (its nav entry `entryId`): `off` when the module is not released and on for the
 * business (business.context lists only those), `forbidden` when the member may not use the entry,
 * else `open`. The API refuses the same (MODULE_DISABLED, FORBIDDEN); this picks the page's state.
 */
export function moduleAccess(
  modules: readonly EnabledModuleDto[],
  moduleId: string,
  entryId: string,
): ModuleAccess {
  const module = modules.find((m) => m.id === moduleId)
  if (!module) return 'off'
  return module.nav.some((entry) => entry.id === entryId) ? 'open' : 'forbidden'
}
