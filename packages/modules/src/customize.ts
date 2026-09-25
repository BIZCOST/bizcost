import { STORED_CAPABILITY_KEYS, type Capabilities, type StoredCapabilityKey } from './capabilities'
import { ALWAYS_ENABLED_MODULE_IDS, MODULE_IDS, type ModuleId } from './manifests'
import {
  toggleFromState,
  type SetupItem,
  type SetupState,
  type ToggleFromStateResult,
} from './setup/adjust'

// Customize BizCost (docs/PRODUCT.md §5, ROADMAP.md Step 6): an existing business switches modules and
// capabilities with the same dependency rules as the Smart Setup review (setup/adjust.ts), from its
// saved state instead of a recommendation. The web previews a switch with toggleBusinessItem() and the
// server applies the same function to the state it reads, plus the rules that need data (a team that
// still has members, more than one location). Disabling hides; it never deletes data.

/** What a business has on: its resolved modules and capabilities (business.context / access). */
export interface BusinessSwitches {
  /** Modules that are on (resolveEnabledModules); Dashboard and Settings are added when missing. */
  readonly enabledModules: Iterable<string>
  readonly capabilities: Capabilities
}

/** The business's switches as a SetupState, the shape the review rules work on. */
export function businessStateOf({ enabledModules, capabilities }: BusinessSwitches): SetupState {
  const on = new Set<string>(enabledModules)
  for (const id of ALWAYS_ENABLED_MODULE_IDS) on.add(id)
  return {
    capabilities: Object.fromEntries(
      STORED_CAPABILITY_KEYS.map((key) => [key, capabilities[key]]),
    ) as Record<StoredCapabilityKey, boolean>,
    vatRegistered: capabilities.vat_registered,
    modules: new Set(MODULE_IDS.filter((id) => on.has(id))),
  }
}

const NO_RECOMMENDATION = { modules: [] } as const

/**
 * Flips one switch of a business (a module, or a capability including vat_registered, which the
 * business profile switches). Turning a capability on turns on its anchor modules (Team → Employees,
 * Stock → Stock and Usage & Waste, Machine time → Equipment, VAT → VAT Center and Invoices when Orders
 * is on); turning it off turns off the modules that require it. A module turned on brings its deps
 * and the capabilities they require; turned off, the modules that depend on it go too. A module that
 * needs VAT while VAT is off is refused (`needs_vat`), and so are Dashboard and Settings.
 */
export function toggleBusinessItem(
  state: SetupState,
  item: SetupItem,
  enabled: boolean,
): ToggleFromStateResult {
  return toggleFromState(NO_RECOMMENDATION, state, item, enabled)
}

/** The modules of a state that differ from another one (for writing business_modules rows). */
export function changedModules(
  before: SetupState,
  after: SetupState,
): { readonly id: ModuleId; readonly enabled: boolean }[] {
  return MODULE_IDS.filter((id) => before.modules.has(id) !== after.modules.has(id)).map((id) => ({
    id,
    enabled: after.modules.has(id),
  }))
}

/** The stored capabilities of a state that differ from another one. */
export function changedCapabilities(
  before: SetupState,
  after: SetupState,
): { readonly key: StoredCapabilityKey; readonly enabled: boolean }[] {
  return STORED_CAPABILITY_KEYS.filter(
    (key) => before.capabilities[key] !== after.capabilities[key],
  ).map((key) => ({ key, enabled: after.capabilities[key] }))
}
