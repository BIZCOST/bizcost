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

/**
 * Planned modules whose build has started (they have nav entries): the only ones the dev-only preview
 * may show (D-125).
 */
export const PREVIEWABLE_MODULE_IDS: readonly ModuleId[] = MODULES.filter(
  (m) => m.availability === 'planned' && m.nav.length > 0,
).map((m) => m.id)

export interface ParsedPreviewModules {
  /** Previewable modules named, in registry order, once each. */
  readonly ids: readonly ModuleId[]
  /** Names that are not a previewable module (unknown, released, or not being built). */
  readonly invalid: readonly string[]
}

/**
 * Reads the dev-only preview list (BIZCOST_PREVIEW_MODULES, e.g. "materials,products"): comma or
 * space separated module ids. The host app reads the variable, and only outside production (D-125).
 */
export function parsePreviewModules(value: string | undefined): ParsedPreviewModules {
  const names = (value ?? '')
    .split(/[\s,]+/)
    .map((name) => name.trim())
    .filter(Boolean)
  const invalid = names.filter(
    (name) => !(PREVIEWABLE_MODULE_IDS as readonly string[]).includes(name),
  )
  const named = new Set(names)
  return { ids: PREVIEWABLE_MODULE_IDS.filter((id) => named.has(id)), invalid }
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
  const ids = new Set(
    preview.filter((id) => (PREVIEWABLE_MODULE_IDS as readonly string[]).includes(id)),
  )
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
