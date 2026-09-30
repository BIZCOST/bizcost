import type { EnabledModuleDto, NavEntryDto, QuickActionDto } from '@bizcost/contracts'
import {
  ALWAYS_ENABLED_MODULE_IDS,
  MODULES,
  type ModuleId,
  type ModuleManifest,
  type NavEntry,
  type QuickAction,
} from './manifests'

// Lookups and visibility rules over the manifests. A module is shown only when it is released, enabled
// for the business and the member may use at least one of its nav entries (docs/ARCHITECTURE.md
// §Modules). `can` is the member's permission check, e.g. (key) => can(effective, key) from domain.

type Can = (permissionKey: string) => boolean

const BY_ID: ReadonlyMap<string, ModuleManifest> = new Map(MODULES.map((m) => [m.id, m]))

export function moduleById(id: string): ModuleManifest | undefined {
  return BY_ID.get(id)
}

const RELEASED: readonly ModuleManifest[] = MODULES.filter((m) => m.availability === 'released')

export function releasedModules(): readonly ModuleManifest[] {
  return RELEASED
}

export function isModuleReleased(manifest: ModuleManifest): boolean {
  return manifest.availability === 'released'
}

/** Planned modules whose build has started (they have nav entries), in registry order. */
function previewableIds(manifests: readonly ModuleManifest[]): readonly ModuleId[] {
  return manifests.filter((m) => m.availability === 'planned' && m.nav.length > 0).map((m) => m.id)
}

/**
 * Planned modules whose build has started (they have nav entries): the only ones the dev-only preview
 * may show (D-125). None since the Costing Core was released (M2 Step 7); the switch stays for the
 * modules built next.
 */
export const PREVIEWABLE_MODULE_IDS: readonly ModuleId[] = previewableIds(MODULES)

export interface ParsedPreviewModules {
  /** Previewable modules named, in registry order, once each. */
  readonly ids: readonly ModuleId[]
  /**
   * Released modules named, in registry order: there is nothing to preview any more (an environment
   * written before their release, e.g. the Costing Core's in M2 Step 7), so they are ignored.
   */
  readonly released: readonly ModuleId[]
  /** Names that are neither a previewable nor a released module (unknown, or not being built). */
  readonly invalid: readonly string[]
}

/**
 * Reads the dev-only preview list (BIZCOST_PREVIEW_MODULES, e.g. "materials,products"): comma or
 * space separated module ids. The host app reads the variable, and only outside production (D-125).
 * A module released since the list was written is ignored, so a local server keeps starting.
 */
export function parsePreviewModules(
  value: string | undefined,
  manifests: readonly ModuleManifest[] = MODULES,
): ParsedPreviewModules {
  const names = (value ?? '')
    .split(/[\s,]+/)
    .map((name) => name.trim())
    .filter(Boolean)
  const named = new Set(names)
  const previewable = previewableIds(manifests)
  const released = manifests.filter((m) => isModuleReleased(m) && named.has(m.id)).map((m) => m.id)
  const known = new Set<string>([...previewable, ...released])
  return {
    ids: previewable.filter((id) => named.has(id)),
    released,
    invalid: names.filter((name) => !known.has(name)),
  }
}

/**
 * The registry with the `preview` modules counted as released: the dev-only preview switch (D-125).
 * Only planned modules whose build has started change; everything else is as released code has it,
 * so the business must still have the module on and the member its permission. The API applies it
 * only when NODE_ENV is development or test (never in production builds).
 */
export function withPreviewModules(
  preview: readonly string[],
  manifests: readonly ModuleManifest[] = MODULES,
): readonly ModuleManifest[] {
  const previewable: readonly string[] = previewableIds(manifests)
  const ids = new Set(preview.filter((id) => previewable.includes(id)))
  if (ids.size === 0) return manifests
  return manifests.map((m) =>
    ids.has(m.id) && m.availability === 'planned' ? { ...m, availability: 'released' } : m,
  )
}

/** A business_modules row: the business switched a module on or off. */
export interface ModuleState {
  readonly key: string
  readonly enabled: boolean
}

/**
 * The modules a business has on (D-055, D-059): a core module is on unless its row switches it off,
 * an optional module is on only through an enabled row, and Dashboard and Settings are always on
 * (their rows are ignored). Rows for unknown modules are ignored. Availability is not checked here:
 * a planned module can be on and still stays hidden until it is released.
 */
export function resolveEnabledModules(rows: readonly ModuleState[]): ReadonlySet<ModuleId> {
  const stored = new Map(rows.map((row) => [row.key, row.enabled]))
  return new Set(
    MODULES.filter(
      (m) => ALWAYS_ENABLED_MODULE_IDS.includes(m.id) || (stored.get(m.id) ?? m.kind === 'core'),
    ).map((m) => m.id),
  )
}

/** On for the business. `enabledKeys` is the business's set from resolveEnabledModules(). */
export function isModuleEnabled(
  manifest: ModuleManifest,
  enabledKeys: ReadonlySet<string>,
): boolean {
  return ALWAYS_ENABLED_MODULE_IDS.includes(manifest.id) || enabledKeys.has(manifest.id)
}

/** Released and enabled: the module's API may be called (requireModule). */
export function isModuleActive(
  manifest: ModuleManifest,
  enabledKeys: ReadonlySet<string>,
): boolean {
  return isModuleReleased(manifest) && isModuleEnabled(manifest, enabledKeys)
}

function permitted<T extends { readonly permission?: string }>(entries: readonly T[], can: Can) {
  return entries.filter((e) => e.permission === undefined || can(e.permission))
}

/** The nav entries of a module the member may use by their keys (payees: buildModuleNav, D-181). */
export function visibleNav(manifest: ModuleManifest, can: Can): readonly NavEntry[] {
  return permitted(manifest.nav, can)
}

export function visibleQuickActions(manifest: ModuleManifest, can: Can): readonly QuickAction[] {
  return permitted(manifest.quickActions, can)
}

/** Shown in the nav, tabs and "+": released, enabled and permitted. */
export function isModuleVisible(
  manifest: ModuleManifest,
  enabledKeys: ReadonlySet<string>,
  can: Can,
): boolean {
  return isModuleActive(manifest, enabledKeys) && visibleNav(manifest, can).length > 0
}

/** The wire shape of a nav entry (without its permission key or who else it is for). */
function toNavDto({ id, labelKey, path, icon, group, tab }: NavEntry): NavEntryDto {
  return { id, labelKey, path, icon, group, tab: tab ?? null }
}

/** The wire shape of a "+" action (without its permission key). */
function toActionDto({ id, labelKey, path, icon }: QuickAction): QuickActionDto {
  return { id, labelKey, path, icon }
}

/**
 * The released and enabled modules of a business, each with the nav entries and "+" actions this
 * member may use (the `modules` part of business.context), in manifest order. `manifests` is the
 * registry; tests pass their own (e.g. a module released later) to show the shell follows the data.
 * A page that several modules share ("Amounts owed": purchases and expenses, D-166) is listed once,
 * by the first of them the member may use it through. `payeeIn` holds the modules in which the
 * business owes (or paid back) the member for something they paid from their own money: their
 * entries for payees show too (D-181). Such a page, reached only as a payee, comes after every entry
 * the member reaches by their keys, under the last module that shares it: it is seldom opened, and
 * must not push a section they work in (an employee's Expenses) into the phone's "More" (D-184).
 */
export function buildModuleNav(
  enabledKeys: ReadonlySet<string>,
  can: Can,
  manifests: readonly ModuleManifest[] = MODULES,
  payeeIn: ReadonlySet<string> = new Set(),
): readonly EnabledModuleDto[] {
  const active = manifests.filter((m) => isModuleActive(m, enabledKeys))
  // First what the member reaches by their keys: a shared page once, by its first module.
  const listed = new Set<string>()
  const byKeys = active.map((m) =>
    visibleNav(m, can).filter((entry) => {
      if (listed.has(entry.path)) return false
      listed.add(entry.path)
      return true
    }),
  )
  // Then the pages for payees not reached by keys, where the member is owed through one of the
  // modules that share it: each under the last active module that has it.
  const lastOf = new Map<string, { entry: NavEntry; at: number }>()
  const owed = new Set<string>()
  active.forEach((m, at) => {
    for (const entry of m.nav) {
      if (entry.payees !== true || listed.has(entry.path)) continue
      lastOf.set(entry.path, { entry, at })
      if (payeeIn.has(m.id)) owed.add(entry.path)
    }
  })
  const payeeOnly = active.map((): NavEntry[] => [])
  for (const [path, { entry, at }] of lastOf) if (owed.has(path)) payeeOnly[at]?.push(entry)
  return active.map((m, at) => ({
    id: m.id,
    nav: [...(byKeys[at] ?? []), ...(payeeOnly[at] ?? [])].map(toNavDto),
    quickActions: visibleQuickActions(m, can).map(toActionDto),
  }))
}
