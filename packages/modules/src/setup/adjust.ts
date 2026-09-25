import {
  CAPABILITIES,
  isCapabilityKey,
  STORED_CAPABILITY_KEYS,
  type CapabilityKey,
  type StoredCapabilityKey,
} from '../capabilities'
import {
  ALWAYS_ENABLED_MODULE_IDS,
  MODULE_IDS,
  MODULES,
  type ModuleId,
  type ModuleManifest,
} from '../manifests'
import type { Recommendation } from './recommend'

// Review adjustments (docs/PRODUCT.md §6.7): one pure applyAdjustments(rec, adj) drives the live review
// and the server. `adj` lists the final state of each item the user changed. Capabilities are applied
// first (registry order), then modules (MODULE_IDS order), each with its side effects; vat_registered
// changes only by its own adjustment, never as a side effect (a legal fact, not a preference). A
// capability turned back on also brings back the recommended modules it had turned off.

/** A switch in the review: a module, or a capability (including vat_registered and jobs_and_tasks). */
export type SetupItem =
  | { readonly kind: 'module'; readonly id: ModuleId }
  | { readonly kind: 'capability'; readonly key: CapabilityKey }

/** The setup a business gets: what the rows written at creation hold. */
export interface SetupState {
  readonly capabilities: Readonly<Record<StoredCapabilityKey, boolean>>
  readonly vatRegistered: boolean
  /** Modules that are on, Dashboard and Settings included. */
  readonly modules: ReadonlySet<ModuleId>
}

/** The review changes sent with the answers (the final state of each changed item, at most once). */
export interface SetupAdjustments {
  readonly modules: readonly { readonly id: string; readonly enabled: boolean }[]
  readonly capabilities: readonly { readonly key: string; readonly enabled: boolean }[]
}

export const NO_ADJUSTMENTS: SetupAdjustments = { modules: [], capabilities: [] }

/** Why adjustments were refused (the server answers VALIDATION). */
export type SetupAdjustmentIssue =
  | 'unknown_module'
  | 'always_on_module'
  | 'unknown_capability'
  | 'duplicate'
  /** A module that requires vat_registered while VAT is off: its switch is disabled with a note. */
  | 'needs_vat'
  /** Defensive: the result broke an invariant (never expected). */
  | 'invalid_state'

export type ApplyAdjustmentsResult =
  | { readonly ok: true; readonly state: SetupState }
  | { readonly ok: false; readonly issue: SetupAdjustmentIssue; readonly item: string }

/** The manifests as their interface (the literal tuples of MODULES are too narrow for lookups). */
const MANIFESTS: readonly ModuleManifest[] = MODULES
const BY_ID: ReadonlyMap<ModuleId, ModuleManifest> = new Map(MANIFESTS.map((m) => [m.id, m]))

function manifest(id: ModuleId): ModuleManifest {
  const found = BY_ID.get(id)
  if (!found) throw new Error(`unknown module ${id}`)
  return found
}

function isModuleId(value: unknown): value is ModuleId {
  return (MODULE_IDS as readonly unknown[]).includes(value)
}

const isAlwaysOn = (id: ModuleId) => ALWAYS_ENABLED_MODULE_IDS.includes(id)

/** `id` and every module it needs, transitively. */
function depsClosure(id: ModuleId): ModuleId[] {
  const out = new Set<ModuleId>()
  const visit = (m: ModuleId) => {
    if (out.has(m)) return
    out.add(m)
    for (const dep of manifest(m).deps) visit(dep)
  }
  visit(id)
  return [...out]
}

/** `id` and every module that needs it, transitively. */
function dependentsClosure(id: ModuleId): ModuleId[] {
  const out = new Set<ModuleId>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const m of MANIFESTS) {
      if (!out.has(m.id) && m.deps.some((d) => out.has(d))) {
        out.add(m.id)
        grew = true
      }
    }
  }
  return [...out]
}

/**
 * The part of a recommendation the switches read: the recommended modules a capability brings back
 * when it is turned on again. Customize BizCost passes none (it has no recommendation in reach).
 */
type RecommendedModules = Pick<Recommendation, 'modules'>

/** Modules a capability turns on with it (plus their deps). */
const ANCHORS: Readonly<Partial<Record<CapabilityKey, readonly ModuleId[]>>> = {
  has_team: ['employees'],
  keeps_stock: ['inventory', 'usage_waste'],
  uses_machines: ['equipment'],
  vat_registered: ['vat_center'],
}

interface Draft {
  caps: Record<StoredCapabilityKey, boolean>
  vat: boolean
  mods: Set<ModuleId>
}

function draftOf(state: SetupState): Draft {
  return { caps: { ...state.capabilities }, vat: state.vatRegistered, mods: new Set(state.modules) }
}

function freeze(d: Draft): SetupState {
  return {
    capabilities: Object.fromEntries(STORED_CAPABILITY_KEYS.map((k) => [k, d.caps[k]])) as Record<
      StoredCapabilityKey,
      boolean
    >,
    vatRegistered: d.vat,
    modules: new Set(MODULE_IDS.filter((id) => d.mods.has(id))),
  }
}

function isStored(key: CapabilityKey): key is StoredCapabilityKey {
  return (STORED_CAPABILITY_KEYS as readonly string[]).includes(key)
}

/** On: its deps turn on, and so do the stored capabilities they require (never vat_registered). */
function moduleOn(d: Draft, id: ModuleId): SetupAdjustmentIssue | null {
  const closure = depsClosure(id)
  const needsVat = closure.some((m) => manifest(m).requiresCapabilities.includes('vat_registered'))
  if (needsVat && !d.vat) return 'needs_vat'
  for (const m of closure) {
    d.mods.add(m)
    for (const cap of manifest(m).requiresCapabilities) if (isStored(cap)) d.caps[cap] = true
  }
  return null
}

/** Off: the modules that depend on it turn off too. */
function moduleOff(d: Draft, id: ModuleId): void {
  for (const m of dependentsClosure(id)) if (!isAlwaysOn(m)) d.mods.delete(m)
}

/** The modules turning `key` off turns off: those that require it, and their dependents. */
function offWith(key: CapabilityKey): ReadonlySet<ModuleId> {
  return new Set(
    MANIFESTS.filter((m) => m.requiresCapabilities.includes(key)).flatMap((m) =>
      dependentsClosure(m.id),
    ),
  )
}

/** Every capability its deps closure requires is on (so turning it on changes no capability). */
function fits(d: Draft, id: ModuleId): boolean {
  return depsClosure(id).every((m) =>
    manifest(m).requiresCapabilities.every((cap) =>
      cap === 'vat_registered' ? d.vat : isStored(cap) && d.caps[cap],
    ),
  )
}

/**
 * On: its anchor modules turn on, and so do the recommended modules that turning it off turns off
 * (switching a capability off and on again gives the recommendation back); off: every module that
 * requires it (and their dependents).
 */
function capabilityTo(
  rec: RecommendedModules,
  d: Draft,
  key: CapabilityKey,
  enabled: boolean,
): SetupAdjustmentIssue | null {
  if (key === 'vat_registered') d.vat = enabled
  else d.caps[key] = enabled
  if (!enabled) {
    for (const m of MANIFESTS) if (m.requiresCapabilities.includes(key)) moduleOff(d, m.id)
    return null
  }
  for (const anchor of ANCHORS[key] ?? []) {
    const issue = moduleOn(d, anchor)
    if (issue) return issue
  }
  const restored = offWith(key)
  for (const { id } of rec.modules) {
    if (restored.has(id) && fits(d, id)) moduleOn(d, id)
  }
  if (key === 'vat_registered' && d.mods.has('orders')) return moduleOn(d, 'invoices')
  return null
}

function apply(
  rec: RecommendedModules,
  d: Draft,
  item: SetupItem,
  enabled: boolean,
): SetupAdjustmentIssue | null {
  if (item.kind === 'capability') return capabilityTo(rec, d, item.key, enabled)
  if (enabled) return moduleOn(d, item.id)
  moduleOff(d, item.id)
  return null
}

/** Invariants 1–3 (§6.10): always-on modules, closed under deps, required capabilities on. */
export function isValidSetupState(state: SetupState): boolean {
  for (const id of ALWAYS_ENABLED_MODULE_IDS) if (!state.modules.has(id)) return false
  for (const id of state.modules) {
    const m = manifest(id)
    if (m.deps.some((dep) => !state.modules.has(dep))) return false
    for (const cap of m.requiresCapabilities) {
      const on =
        cap === 'vat_registered' ? state.vatRegistered : isStored(cap) && state.capabilities[cap]
      if (!on) return false
    }
  }
  return true
}

/** The state recommend() gives, before any adjustment ("Not sure" VAT is off). */
export function recommendedState(rec: Recommendation): SetupState {
  return freeze({
    caps: { ...rec.capabilities },
    vat: rec.vatRegistered === true,
    mods: new Set(rec.modules.map((m) => m.id)),
  })
}

export function applyAdjustments(
  rec: Recommendation,
  adj: SetupAdjustments,
): ApplyAdjustmentsResult {
  const caps = new Map<CapabilityKey, boolean>()
  for (const { key, enabled } of adj.capabilities) {
    if (!isCapabilityKey(key)) return { ok: false, issue: 'unknown_capability', item: key }
    if (caps.has(key)) return { ok: false, issue: 'duplicate', item: key }
    caps.set(key, enabled)
  }
  const mods = new Map<ModuleId, boolean>()
  for (const { id, enabled } of adj.modules) {
    if (!isModuleId(id)) return { ok: false, issue: 'unknown_module', item: id }
    if (isAlwaysOn(id)) return { ok: false, issue: 'always_on_module', item: id }
    if (mods.has(id)) return { ok: false, issue: 'duplicate', item: id }
    mods.set(id, enabled)
  }
  const d = draftOf(recommendedState(rec))
  for (const { key } of CAPABILITIES) {
    const enabled = caps.get(key)
    if (enabled === undefined) continue
    const issue = capabilityTo(rec, d, key, enabled)
    if (issue) return { ok: false, issue, item: key }
  }
  for (const id of MODULE_IDS) {
    const enabled = mods.get(id)
    if (enabled === undefined) continue
    const issue = apply(rec, d, { kind: 'module', id }, enabled)
    if (issue) return { ok: false, issue, item: id }
  }
  const state = freeze(d)
  if (!isValidSetupState(state)) return { ok: false, issue: 'invalid_state', item: '' }
  return { ok: true, state }
}

export function isSetupItemOn(state: SetupState, item: SetupItem): boolean {
  if (item.kind === 'module') return state.modules.has(item.id)
  if (item.key === 'vat_registered') return state.vatRegistered
  return state.capabilities[item.key]
}

/** Every switchable item: capabilities in registry order, then modules (not Dashboard/Settings). */
const ITEMS: readonly SetupItem[] = [
  ...CAPABILITIES.map((c): SetupItem => ({ kind: 'capability', key: c.key })),
  ...MODULE_IDS.filter((id) => !isAlwaysOn(id)).map((id): SetupItem => ({ kind: 'module', id })),
]

function sameState(a: SetupState, b: SetupState): boolean {
  return ITEMS.every((item) => isSetupItemOn(a, item) === isSetupItemOn(b, item))
}

function toAdjustments(entries: ReadonlyMap<SetupItem, boolean>): SetupAdjustments {
  const list = ITEMS.filter((item) => entries.has(item))
  return {
    capabilities: list.flatMap((item) =>
      item.kind === 'capability' ? [{ key: item.key, enabled: entries.get(item)! }] : [],
    ),
    modules: list.flatMap((item) =>
      item.kind === 'module' ? [{ id: item.id, enabled: entries.get(item)! }] : [],
    ),
  }
}

/**
 * Adjustments that make applyAdjustments(rec, ·) give exactly `target` (a valid state): the items
 * that differ from the recommendation, plus any item a side effect would otherwise change (e.g. Usage
 * & Waste kept off while Stock is turned on). Listing every item always works, so this ends.
 */
export function adjustmentsFor(rec: Recommendation, target: SetupState): SetupAdjustments {
  const base = recommendedState(rec)
  const entries = new Map<SetupItem, boolean>()
  for (const item of ITEMS) {
    if (isSetupItemOn(base, item) !== isSetupItemOn(target, item)) {
      entries.set(item, isSetupItemOn(target, item))
    }
  }
  for (let round = 0; round <= ITEMS.length; round++) {
    const result = applyAdjustments(rec, toAdjustments(entries))
    if (result.ok && sameState(result.state, target)) return toAdjustments(entries)
    let added = false
    for (const item of ITEMS) {
      const wanted = isSetupItemOn(target, item)
      const differs = !result.ok || isSetupItemOn(result.state, item) !== wanted
      if (differs && entries.get(item) !== wanted) {
        entries.set(item, wanted)
        added = true
      }
    }
    if (!added) break
  }
  return toAdjustments(new Map(ITEMS.map((item) => [item, isSetupItemOn(target, item)])))
}

/** One switch flipped from a state: the new state and the other items that changed with it. */
export type ToggleFromStateResult =
  | {
      readonly ok: true
      readonly state: SetupState
      /** Side effects, for "Also turned on:" / "Also turned off:" (the toggled item excluded). */
      readonly turnedOn: readonly SetupItem[]
      readonly turnedOff: readonly SetupItem[]
    }
  | { readonly ok: false; readonly issue: SetupAdjustmentIssue; readonly item: string }

/**
 * Flips one switch of `current` with the review's rules (capabilities: anchors on, requiring modules
 * off; modules: deps on, dependents off; `needs_vat` refused). `rec` names the recommended modules a
 * capability brings back when turned on again (none for Customize BizCost). A valid state stays valid.
 */
export function toggleFromState(
  rec: RecommendedModules,
  current: SetupState,
  item: SetupItem,
  enabled: boolean,
): ToggleFromStateResult {
  const name = item.kind === 'module' ? item.id : item.key
  if (item.kind === 'module' && !isModuleId(item.id)) {
    return { ok: false, issue: 'unknown_module', item: name }
  }
  if (item.kind === 'module' && isAlwaysOn(item.id)) {
    return { ok: false, issue: 'always_on_module', item: name }
  }
  if (item.kind === 'capability' && !isCapabilityKey(item.key)) {
    return { ok: false, issue: 'unknown_capability', item: name }
  }
  const d = draftOf(current)
  const issue = apply(rec, d, item, enabled)
  if (issue) return { ok: false, issue, item: name }
  const state = freeze(d)
  if (isValidSetupState(current) && !isValidSetupState(state)) {
    return { ok: false, issue: 'invalid_state', item: name }
  }
  const changed = (on: boolean) =>
    [
      ...ITEMS.filter((i) => i.kind === 'module'),
      ...ITEMS.filter((i) => i.kind === 'capability'),
    ].filter(
      (i) =>
        !sameItem(i, item) && isSetupItemOn(current, i) !== on && isSetupItemOn(state, i) === on,
    )
  return { ok: true, state, turnedOn: changed(true), turnedOff: changed(false) }
}

export type ToggleSetupItemResult =
  | {
      readonly ok: true
      readonly adjustments: SetupAdjustments
      readonly state: SetupState
      /** Side effects, for "Also turned on:" / "Also turned off:" (the toggled item excluded). */
      readonly turnedOn: readonly SetupItem[]
      readonly turnedOff: readonly SetupItem[]
    }
  | { readonly ok: false; readonly issue: SetupAdjustmentIssue; readonly item: string }

/**
 * The live review: the user flips one switch. Returns the new adjustments (to keep and submit), the
 * new state and the other items that changed with it. `needs_vat` means the switch stays off.
 */
export function toggleSetupItem(
  rec: Recommendation,
  adj: SetupAdjustments,
  item: SetupItem,
  enabled: boolean,
): ToggleSetupItemResult {
  const current = applyAdjustments(rec, adj)
  if (!current.ok) return current
  const result = toggleFromState(rec, current.state, item, enabled)
  if (!result.ok) return result
  return { ...result, adjustments: adjustmentsFor(rec, result.state) }
}

function sameItem(a: SetupItem, b: SetupItem): boolean {
  if (a.kind === 'module') return b.kind === 'module' && a.id === b.id
  return b.kind === 'capability' && a.key === b.key
}

/**
 * The business_modules rows for a state (D-059): an optional module that is on gets enabled = true, a
 * core module that is off gets enabled = false, and nothing else gets a row.
 */
export interface SetupModuleRow {
  readonly moduleKey: ModuleId
  readonly enabled: boolean
}

export function setupModuleRows(state: SetupState): SetupModuleRow[] {
  return MANIFESTS.filter((m) => !isAlwaysOn(m.id)).flatMap((m): SetupModuleRow[] => {
    const on = state.modules.has(m.id)
    if (m.kind === 'optional' && on) return [{ moduleKey: m.id, enabled: true }]
    if (m.kind === 'core' && !on) return [{ moduleKey: m.id, enabled: false }]
    return []
  })
}
