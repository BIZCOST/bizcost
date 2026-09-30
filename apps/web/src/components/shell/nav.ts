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
  /**
   * Its claim to a place in the phone's tab bar when not every item fits (1 first; null: a place only
   * when the claims leave one). From the manifest's nav entry (D-189).
   */
  readonly tab: number | null
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

/**
 * The business's wording of a label (its terminology overlay, e.g. `common.nav.materials_food` for a
 * food business): given a label key, the key to show. use-nav-wording.ts gives the page's.
 */
export type NavWording = (labelKey: I18nKey) => I18nKey

const asIs: NavWording = (labelKey) => labelKey

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
 * Labels are in the business's wording when `wording` is given.
 */
export function shellNav(
  modules: readonly EnabledModuleDto[],
  businessId: string,
  pathname: string,
  wording: NavWording = asIs,
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
    labelKey: wording(commonKey(entry.labelKey)),
    href: businessHref(businessId, entry.path),
    icon: entry.icon,
    group: entry.group,
    tab: entry.tab,
    active: entry === active,
  }))
}

/**
 * The "+" actions of every module the member may use, in manifest order (business.context lists only
 * those whose key the member holds: a new product, purchase or expense, D-189), in the business's
 * wording when `wording` is given ("New service or work item" for a projects business).
 */
export function shellQuickActions(
  modules: readonly EnabledModuleDto[],
  businessId: string,
  wording: NavWording = asIs,
): ShellQuickAction[] {
  return modules.flatMap((module) =>
    module.quickActions.map((action) => ({
      id: action.id,
      labelKey: wording(commonKey(action.labelKey)),
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
 * the most a member can have, a page two modules share (Amounts owed, D-166) once. Not the business's
 * own (not known yet), and not a fixed number.
 */
export function navSlots(
  manifests: readonly {
    readonly nav: readonly { readonly group: NavGroup; readonly path: string }[]
  }[],
): NavSlots {
  const byPath = new Map<string, NavGroup>()
  for (const manifest of manifests) {
    for (const entry of manifest.nav) {
      if (!byPath.has(entry.path)) byPath.set(entry.path, entry.group)
    }
  }
  const groups = [...byPath.values()]
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
 * The phone's tab bar (D-189): every item when they fit; else the items with the strongest claims
 * (`tab`, 1 first; places the claims leave go to the first items without one) and a "More" tab with
 * the rest. The tabs keep the nav's order, and there is no "+" without actions. With the Costing Core
 * an owner gets Home | Products | + | Product costs | More and an employee Home | Products | + |
 * Expenses | More (docs/PRODUCT.md §9's idea "Home | Sales | + | Costs | More").
 */
export function bottomTabs(
  items: readonly ShellNavItem[],
  quickActions: readonly ShellQuickAction[],
): BottomTabs {
  const quickAdd = quickActions.length > 0
  const slots = TAB_SLOTS - (quickAdd ? 1 : 0)
  if (items.length <= slots) return { tabs: items, more: [], quickAdd }
  // One place goes to "More".
  const places = slots - 1
  const claimed = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.tab !== null)
    .sort((a, b) => (a.item.tab ?? 0) - (b.item.tab ?? 0) || a.index - b.index)
    .slice(0, places)
    .map(({ item }) => item)
  const unclaimed = items.filter((item) => item.tab === null)
  const chosen = new Set([...claimed, ...unclaimed.slice(0, places - claimed.length)])
  return {
    tabs: items.filter((item) => chosen.has(item)),
    more: items.filter((item) => !chosen.has(item)),
    quickAdd,
  }
}

/**
 * A module's id, or the ids of the modules that share a page (Amounts owed: Purchases and Expenses,
 * D-166; the registry lists its entry once, through the first of them the member may use it by).
 */
export type ModuleIds = string | readonly string[]

function idsOf(moduleIds: ModuleIds): readonly string[] {
  return typeof moduleIds === 'string' ? [moduleIds] : moduleIds
}

/**
 * Another section of the shell than module `moduleId` (the first in the nav's order: a `main` one
 * before Settings), or none: where a module's "turned off" or "not open to you" state leads, and
 * where the business root sends a member who may not use the Dashboard. For a shared page, another
 * section than all of its modules'.
 */
export function wayBack(
  items: readonly ShellNavItem[],
  moduleId: ModuleIds,
): ShellNavItem | undefined {
  const ids = idsOf(moduleId)
  return items.find((item) => !ids.includes(item.moduleId))
}

/** What a module's page shows the member: the page, "not open to you", or "turned off". */
export type ModuleAccess = 'open' | 'forbidden' | 'off'

/**
 * For a module's page (its nav entry `entryId`): `off` when the module is not released and on for the
 * business (business.context lists only those), `forbidden` when the member may not use the entry,
 * else `open`. The API refuses the same (MODULE_DISABLED, FORBIDDEN); this picks the page's state.
 * A page several modules share is open through any of them, and off only when none of them is on.
 */
export function moduleAccess(
  modules: readonly EnabledModuleDto[],
  moduleId: ModuleIds,
  entryId: string,
): ModuleAccess {
  const ids = idsOf(moduleId)
  const on = modules.filter((m) => ids.includes(m.id))
  if (on.length === 0) return 'off'
  return on.some((module) => module.nav.some((entry) => entry.id === entryId))
    ? 'open'
    : 'forbidden'
}
