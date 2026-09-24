// Capability registry (docs/PRODUCT.md §5): business-level flags that hide fields, sections and
// pickers inside screens. They are not security gates. `stored` ones live in business_capabilities;
// `derived` ones are read from a businesses column and never stored (D-052: vat_registered).

export type CapabilityStorage = 'stored' | 'derived'

export interface CapabilityDefinition {
  readonly key: string
  readonly source: CapabilityStorage
  /** Value of a stored capability when the business has no row for it. */
  readonly default: boolean
}

export const CAPABILITIES = [
  { key: 'has_team', source: 'stored', default: false },
  { key: 'multi_location', source: 'stored', default: false },
  { key: 'keeps_stock', source: 'stored', default: false },
  { key: 'uses_machines', source: 'stored', default: false },
  { key: 'sells_via_pos', source: 'stored', default: false },
  { key: 'jobs_and_tasks', source: 'stored', default: false },
  { key: 'vat_registered', source: 'derived', default: false },
] as const satisfies readonly CapabilityDefinition[]

type Capability = (typeof CAPABILITIES)[number]
export type CapabilityKey = Capability['key']
export type StoredCapabilityKey = Extract<Capability, { source: 'stored' }>['key']
export type DerivedCapabilityKey = Extract<Capability, { source: 'derived' }>['key']

export const CAPABILITY_KEYS: readonly CapabilityKey[] = CAPABILITIES.map((c) => c.key)

export const STORED_CAPABILITY_KEYS = CAPABILITIES.filter(
  (c): c is Extract<Capability, { source: 'stored' }> => c.source === 'stored',
).map((c) => c.key)

export const DERIVED_CAPABILITY_KEYS = CAPABILITIES.filter(
  (c): c is Extract<Capability, { source: 'derived' }> => c.source === 'derived',
).map((c) => c.key)

export function isCapabilityKey(value: unknown): value is CapabilityKey {
  return (CAPABILITY_KEYS as readonly unknown[]).includes(value)
}

export function isStoredCapabilityKey(value: unknown): value is StoredCapabilityKey {
  return (STORED_CAPABILITY_KEYS as readonly unknown[]).includes(value)
}

export type Capabilities = Readonly<Record<CapabilityKey, boolean>>

export interface ResolveCapabilitiesInput {
  /** `business_capabilities` rows. Unknown keys and keys of derived capabilities are ignored. */
  readonly stored: readonly { readonly key: string; readonly enabled: boolean }[]
  /** Values of derived capabilities, read from their businesses columns. */
  readonly derived: Readonly<Record<DerivedCapabilityKey, boolean>>
}

/** Every capability of the registry with its value for one business (defaults fill the gaps). */
export function resolveCapabilities(input: ResolveCapabilitiesInput): Capabilities {
  const stored = new Map<string, boolean>()
  for (const row of input.stored) {
    if (isStoredCapabilityKey(row.key)) stored.set(row.key, row.enabled)
  }
  const result = {} as Record<CapabilityKey, boolean>
  for (const capability of CAPABILITIES) {
    result[capability.key] =
      capability.source === 'derived'
        ? input.derived[capability.key]
        : (stored.get(capability.key) ?? capability.default)
  }
  return result
}
