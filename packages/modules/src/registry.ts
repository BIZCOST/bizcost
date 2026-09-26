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

/** The wire shape of a nav entry (without its permission key). */
function toNavDto({ id, labelKey, path, icon, group }: NavEntry): NavEntryDto {
  return { id, labelKey, path, icon, group }
}

/** The wire shape of a "+" action (without its permission key). */
function toActionDto({ id, labelKey, path, icon }: QuickAction): QuickActionDto {
  return { id, labelKey, path, icon }
}

/**
 * The released and enabled modules of a business, each with the nav entries and "+" actions this
 * member may use (the `modules` part of business.context), in manifest order. `manifests` is the
 * registry; tests pass their own (e.g. a module released later) to show the shell follows the data.
 */
export function buildModuleNav(
  enabledKeys: ReadonlySet<string>,
  can: Can,
  manifests: readonly ModuleManifest[] = MODULES,
): readonly EnabledModuleDto[] {
  return manifests
    .filter((m) => isModuleActive(m, enabledKeys))
    .map((m) => ({
      id: m.id,
      nav: visibleNav(m, can).map(toNavDto),
      quickActions: visibleQuickActions(m, can).map(toActionDto),
    }))
}
