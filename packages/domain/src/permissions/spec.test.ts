// Independent spec test for the permission engine (docs/ROADMAP.md Step 2), written from the
// specification only (docs/ARCHITECTURE.md §Permissions, docs/DATA_MODEL.md §4, PRODUCT.md §8).
// The engine is pure and receives the permission catalog as input, so this file carries its own
// copy of the Step 2 catalog instead of importing @bizcost/modules (domain must not import it).
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  can,
  canAccessLocation,
  newId,
  OWNER_TEMPLATE_KEY,
  PERMISSION_EFFECTS,
  resolveEffective,
  resolveLocationScope,
  SENSITIVITY_CATEGORIES,
  visibleCategories,
} from '../index'

type EngineInput = Parameters<typeof resolveEffective>[0]
type Effective = ReturnType<typeof resolveEffective>

const CATALOG: readonly string[] = [
  'dashboard.home.view',
  'settings.business.view',
  'settings.business.edit',
  'settings.locations.manage',
  'settings.members.view',
  'settings.members.manage',
  'settings.roles.manage',
  'settings.modules.manage',
  'data.cost.view',
  'data.profit_margin.view',
  'data.supplier_price.view',
  'data.payroll.view',
  'data.employee_pii.view',
]

// Keys that are not in the catalog: planned modules, the owner-only ownership transfer (not a
// key), a category that does not exist, and malformed values.
const UNKNOWN_KEYS: readonly string[] = [
  'orders.order.create',
  'settings.ownership.transfer',
  'data.salary.view',
  'not-a-key',
  '',
]

const NON_OWNER_TEMPLATES = [
  null,
  'admin',
  'manager',
  'accountant',
  'sales',
  'supervisor',
  'employee',
] as const

const allow = (key: string) => ({ key, effect: 'allow' as const })
const deny = (key: string) => ({ key, effect: 'deny' as const })

function resolve(input: Partial<EngineInput> = {}): Effective {
  return resolveEffective({
    roleTemplateKey: 'employee',
    rolePermissionKeys: [],
    overrides: [],
    catalog: CATALOG,
    ...input,
  })
}

const sorted = (keys: Iterable<string>): string[] => [...keys].sort()

const isSubset = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  [...a].every((key) => b.has(key))

/** The specification, written out: (role ∪ allow − deny) ∩ catalog, deny wins. */
function reference(input: EngineInput): Set<string> {
  const catalog = new Set(input.catalog)
  const denied = new Set(input.overrides.filter((o) => o.effect === 'deny').map((o) => o.key))
  const granted = [
    ...input.rolePermissionKeys,
    ...input.overrides.filter((o) => o.effect === 'allow').map((o) => o.key),
  ]
  return new Set(granted.filter((key) => catalog.has(key) && !denied.has(key)))
}

// ---------------------------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------------------------

const keyArb = fc.constantFrom(...CATALOG, ...UNKNOWN_KEYS)
const overrideArb = fc.record({ key: keyArb, effect: fc.constantFrom(...PERMISSION_EFFECTS) })
const catalogArb = fc.oneof(fc.constant([...CATALOG]), fc.subarray([...CATALOG]))

const nonOwnerInputArb = fc.record({
  roleTemplateKey: fc.constantFrom(...NON_OWNER_TEMPLATES, 'custom_role'),
  rolePermissionKeys: fc.array(keyArb, { maxLength: 20 }),
  overrides: fc.array(overrideArb, { maxLength: 20 }),
  catalog: catalogArb,
})

const ownerInputArb = fc.record({
  roleTemplateKey: fc.constant(OWNER_TEMPLATE_KEY),
  rolePermissionKeys: fc.array(keyArb, { maxLength: 20 }),
  overrides: fc.array(overrideArb, { maxLength: 20 }),
  catalog: catalogArb,
})

// ---------------------------------------------------------------------------------------------
// resolveEffective / can
// ---------------------------------------------------------------------------------------------

describe('resolveEffective: owner', () => {
  it('uses the owner template key "owner"', () => {
    expect(OWNER_TEMPLATE_KEY).toBe('owner')
  })

  it('gives the owner template every permission implicitly, with no role_permissions rows', () => {
    const owner = resolve({ roleTemplateKey: OWNER_TEMPLATE_KEY })
    expect(owner.all).toBe(true)
    for (const key of CATALOG) expect(can(owner, key)).toBe(true)
  })

  it('ignores deny overrides for the owner: the owner can never be locked out', () => {
    const owner = resolve({
      roleTemplateKey: OWNER_TEMPLATE_KEY,
      overrides: CATALOG.map(deny),
    })
    expect(owner.all).toBe(true)
    for (const key of CATALOG) expect(can(owner, key)).toBe(true)
  })

  it('ignores allow overrides and role rows for the owner (still all)', () => {
    const owner = resolve({
      roleTemplateKey: OWNER_TEMPLATE_KEY,
      rolePermissionKeys: ['dashboard.home.view'],
      overrides: [allow('settings.roles.manage'), deny('dashboard.home.view')],
    })
    expect(owner.all).toBe(true)
    for (const key of CATALOG) expect(can(owner, key)).toBe(true)
  })

  it('property: the owner always has every catalog permission, whatever the overrides', () => {
    fc.assert(
      fc.property(ownerInputArb, (input) => {
        const owner = resolveEffective(input)
        expect(owner.all).toBe(true)
        for (const key of input.catalog) expect(can(owner, key)).toBe(true)
      }),
    )
  })
})

describe('resolveEffective: other roles', () => {
  it('never sets all=true for a non-owner template, even when it holds every key', () => {
    for (const template of NON_OWNER_TEMPLATES) {
      const effective = resolve({ roleTemplateKey: template, rolePermissionKeys: [...CATALOG] })
      expect(effective.all).toBe(false)
      expect(sorted(effective.keys)).toEqual(sorted(CATALOG))
    }
  })

  it('treats a custom role (template key null) like any other non-owner role', () => {
    const custom = resolve({
      roleTemplateKey: null,
      rolePermissionKeys: ['dashboard.home.view', 'settings.members.view'],
    })
    expect(custom.all).toBe(false)
    expect(sorted(custom.keys)).toEqual(['dashboard.home.view', 'settings.members.view'])
  })

  it('grants exactly the role permission keys when there are no overrides', () => {
    const effective = resolve({
      rolePermissionKeys: ['dashboard.home.view', 'settings.business.view'],
    })
    expect(sorted(effective.keys)).toEqual(['dashboard.home.view', 'settings.business.view'])
  })

  it('grants nothing for an empty role with no overrides', () => {
    const effective = resolve()
    expect(effective.all).toBe(false)
    expect(effective.keys.size).toBe(0)
    for (const key of CATALOG) expect(can(effective, key)).toBe(false)
  })

  it('adds a key through an allow override', () => {
    const effective = resolve({
      rolePermissionKeys: ['dashboard.home.view'],
      overrides: [allow('data.cost.view')],
    })
    expect(sorted(effective.keys)).toEqual(['dashboard.home.view', 'data.cost.view'])
  })

  it('removes a role key through a deny override', () => {
    const effective = resolve({
      rolePermissionKeys: ['dashboard.home.view', 'data.cost.view'],
      overrides: [deny('data.cost.view')],
    })
    expect(sorted(effective.keys)).toEqual(['dashboard.home.view'])
    expect(can(effective, 'data.cost.view')).toBe(false)
  })

  it('lets deny win over allow for the same key, in either order', () => {
    const denyFirst = resolve({
      rolePermissionKeys: ['data.cost.view'],
      overrides: [deny('data.cost.view'), allow('data.cost.view')],
    })
    const allowFirst = resolve({
      rolePermissionKeys: ['data.cost.view'],
      overrides: [allow('data.cost.view'), deny('data.cost.view')],
    })
    expect(can(denyFirst, 'data.cost.view')).toBe(false)
    expect(can(allowFirst, 'data.cost.view')).toBe(false)

    const overridesOnly = resolve({
      overrides: [allow('data.payroll.view'), deny('data.payroll.view')],
    })
    expect(can(overridesOnly, 'data.payroll.view')).toBe(false)
  })

  it('ignores a deny override for a key the role does not hold', () => {
    const effective = resolve({
      rolePermissionKeys: ['dashboard.home.view'],
      overrides: [deny('settings.roles.manage')],
    })
    expect(sorted(effective.keys)).toEqual(['dashboard.home.view'])
  })

  it('drops role keys that are not in the catalog', () => {
    const effective = resolve({
      rolePermissionKeys: ['dashboard.home.view', ...UNKNOWN_KEYS],
    })
    expect(sorted(effective.keys)).toEqual(['dashboard.home.view'])
    for (const key of UNKNOWN_KEYS) expect(can(effective, key)).toBe(false)
  })

  it('drops allow overrides for keys that are not in the catalog', () => {
    const effective = resolve({ overrides: UNKNOWN_KEYS.map(allow) })
    expect(effective.keys.size).toBe(0)
    for (const key of UNKNOWN_KEYS) expect(can(effective, key)).toBe(false)
  })

  it('accepts deny overrides for unknown keys without effect', () => {
    const effective = resolve({
      rolePermissionKeys: ['dashboard.home.view'],
      overrides: UNKNOWN_KEYS.map(deny),
    })
    expect(sorted(effective.keys)).toEqual(['dashboard.home.view'])
  })

  it('checks against the catalog it is given (a key removed from the catalog is dropped)', () => {
    const effective = resolve({
      rolePermissionKeys: ['dashboard.home.view', 'data.cost.view'],
      catalog: ['dashboard.home.view'],
    })
    expect(sorted(effective.keys)).toEqual(['dashboard.home.view'])
    expect(resolve({ rolePermissionKeys: [...CATALOG], catalog: [] }).keys.size).toBe(0)
  })

  it('collapses duplicate keys and overrides', () => {
    const effective = resolve({
      rolePermissionKeys: ['dashboard.home.view', 'dashboard.home.view'],
      overrides: [allow('data.cost.view'), allow('data.cost.view')],
    })
    expect(sorted(effective.keys)).toEqual(['dashboard.home.view', 'data.cost.view'])
  })

  it('does not mutate its inputs', () => {
    const input: EngineInput = {
      roleTemplateKey: 'manager',
      rolePermissionKeys: ['dashboard.home.view', 'data.cost.view', 'bogus.key.view'],
      overrides: [deny('data.cost.view'), allow('settings.members.view')],
      catalog: [...CATALOG],
    }
    const snapshot = {
      ...input,
      rolePermissionKeys: [...input.rolePermissionKeys],
      overrides: input.overrides.map((o) => ({ ...o })),
      catalog: [...input.catalog],
    }
    resolveEffective(input)
    expect(input).toEqual(snapshot)
  })
})

describe('can', () => {
  it('is true exactly for the effective keys of a non-owner', () => {
    const effective = resolve({ rolePermissionKeys: ['dashboard.home.view'] })
    expect(can(effective, 'dashboard.home.view')).toBe(true)
    expect(can(effective, 'settings.business.view')).toBe(false)
    expect(can(effective, 'orders.order.create')).toBe(false)
    expect(can(effective, '')).toBe(false)
  })

  it('agrees with the resolved key set for every catalog key', () => {
    fc.assert(
      fc.property(nonOwnerInputArb, (input) => {
        const effective = resolveEffective(input)
        for (const key of [...CATALOG, ...UNKNOWN_KEYS]) {
          expect(can(effective, key)).toBe(effective.keys.has(key))
        }
      }),
    )
  })
})

describe('resolveEffective: properties (non-owner)', () => {
  it('matches the specification: (role ∪ allow − deny) ∩ catalog', () => {
    fc.assert(
      fc.property(nonOwnerInputArb, (input) => {
        const effective = resolveEffective(input)
        expect(effective.all).toBe(false)
        expect(sorted(effective.keys)).toEqual(sorted(reference(input)))
      }),
    )
  })

  it('never grants a key outside the catalog', () => {
    fc.assert(
      fc.property(nonOwnerInputArb, (input) => {
        const effective = resolveEffective(input)
        for (const key of effective.keys) expect(input.catalog).toContain(key)
        for (const key of UNKNOWN_KEYS) expect(can(effective, key)).toBe(false)
      }),
    )
  })

  it('adding a deny never grants anything and always removes that key', () => {
    fc.assert(
      fc.property(nonOwnerInputArb, keyArb, fc.boolean(), (input, key, first) => {
        const before = resolveEffective(input)
        const overrides = first ? [deny(key), ...input.overrides] : [...input.overrides, deny(key)]
        const after = resolveEffective({ ...input, overrides })
        expect(isSubset(after.keys, before.keys)).toBe(true)
        expect(can(after, key)).toBe(false)
      }),
    )
  })

  it('adding an allow never removes anything', () => {
    fc.assert(
      fc.property(nonOwnerInputArb, keyArb, fc.boolean(), (input, key, first) => {
        const before = resolveEffective(input)
        const overrides = first
          ? [allow(key), ...input.overrides]
          : [...input.overrides, allow(key)]
        const after = resolveEffective({ ...input, overrides })
        expect(isSubset(before.keys, after.keys)).toBe(true)
        const denied = input.overrides.some((o) => o.key === key && o.effect === 'deny')
        expect(can(after, key)).toBe(input.catalog.includes(key) && !denied)
      }),
    )
  })

  it('adding a role key never removes anything', () => {
    fc.assert(
      fc.property(nonOwnerInputArb, keyArb, (input, key) => {
        const before = resolveEffective(input)
        const after = resolveEffective({
          ...input,
          rolePermissionKeys: [...input.rolePermissionKeys, key],
        })
        expect(isSubset(before.keys, after.keys)).toBe(true)
      }),
    )
  })

  it('does not depend on the order of overrides or role keys', () => {
    fc.assert(
      fc.property(nonOwnerInputArb, (input) => {
        const forward = resolveEffective(input)
        const reversed = resolveEffective({
          ...input,
          rolePermissionKeys: [...input.rolePermissionKeys].reverse(),
          overrides: [...input.overrides].reverse(),
        })
        expect(sorted(reversed.keys)).toEqual(sorted(forward.keys))
      }),
    )
  })
})

// ---------------------------------------------------------------------------------------------
// Location scope
// ---------------------------------------------------------------------------------------------

describe('resolveLocationScope / canAccessLocation', () => {
  it('treats an empty member location set as ALL locations', () => {
    const scope = resolveLocationScope([])
    expect(scope.all).toBe(true)
    expect(canAccessLocation(scope, newId())).toBe(true)
  })

  it('limits a member with locations to exactly those locations', () => {
    const [a, b, other] = [newId(), newId(), newId()]
    const scope = resolveLocationScope([a, b])
    expect(scope.all).toBe(false)
    if (!scope.all) expect(sorted(scope.ids)).toEqual(sorted([a, b]))
    expect(canAccessLocation(scope, a)).toBe(true)
    expect(canAccessLocation(scope, b)).toBe(true)
    expect(canAccessLocation(scope, other)).toBe(false)
  })

  it('collapses duplicate location ids', () => {
    const a = newId()
    const scope = resolveLocationScope([a, a])
    expect(scope.all).toBe(false)
    if (!scope.all) expect(scope.ids.size).toBe(1)
    expect(canAccessLocation(scope, a)).toBe(true)
  })

  it('property: access = set empty OR id in set', () => {
    fc.assert(
      fc.property(fc.array(fc.uuid(), { maxLength: 6 }), fc.uuid(), (ids, probe) => {
        const scope = resolveLocationScope(ids)
        expect(scope.all).toBe(ids.length === 0)
        for (const id of ids) expect(canAccessLocation(scope, id)).toBe(true)
        expect(canAccessLocation(scope, probe)).toBe(ids.length === 0 || ids.includes(probe))
      }),
    )
  })
})

// ---------------------------------------------------------------------------------------------
// Sensitivity categories
// ---------------------------------------------------------------------------------------------

describe('SENSITIVITY_CATEGORIES', () => {
  it('lists exactly the five categories', () => {
    expect(sorted(SENSITIVITY_CATEGORIES)).toEqual(
      sorted(['cost', 'profit_margin', 'supplier_price', 'payroll', 'employee_pii']),
    )
  })
})

describe('visibleCategories', () => {
  const visibleFor = (rolePermissionKeys: string[], overrides: EngineInput['overrides'] = []) =>
    sorted(visibleCategories(resolve({ rolePermissionKeys, overrides })))

  it('shows every category to the owner', () => {
    const owner = resolve({ roleTemplateKey: OWNER_TEMPLATE_KEY, overrides: CATALOG.map(deny) })
    expect(sorted(visibleCategories(owner))).toEqual(sorted(SENSITIVITY_CATEGORIES))
  })

  it('shows nothing without data.* permissions', () => {
    expect(visibleFor([])).toEqual([])
    expect(visibleFor(['dashboard.home.view', 'settings.business.view'])).toEqual([])
  })

  it('maps each independent category to data.<category>.view', () => {
    expect(visibleFor(['data.cost.view'])).toEqual(['cost'])
    expect(visibleFor(['data.supplier_price.view'])).toEqual(['supplier_price'])
    expect(visibleFor(['data.payroll.view'])).toEqual(['payroll'])
    expect(visibleFor(['data.employee_pii.view'])).toEqual(['employee_pii'])
  })

  it('hides profit_margin when cost is hidden (price + margin would reveal cost)', () => {
    expect(visibleFor(['data.profit_margin.view'])).toEqual([])
    expect(visibleFor(['data.profit_margin.view', 'data.supplier_price.view'])).toEqual([
      'supplier_price',
    ])
  })

  it('shows profit_margin when cost is visible too', () => {
    expect(visibleFor(['data.cost.view', 'data.profit_margin.view'])).toEqual(
      sorted(['cost', 'profit_margin']),
    )
  })

  it('hides profit_margin when cost is removed by a deny override', () => {
    expect(
      visibleFor(['data.cost.view', 'data.profit_margin.view'], [deny('data.cost.view')]),
    ).toEqual([])
  })

  it('matches the manager and accountant templates', () => {
    const manager = [
      'dashboard.home.view',
      'settings.business.view',
      'settings.members.view',
      'settings.locations.manage',
      'data.cost.view',
      'data.profit_margin.view',
      'data.supplier_price.view',
    ]
    expect(visibleFor(manager)).toEqual(sorted(['cost', 'profit_margin', 'supplier_price']))

    const accountant = [
      'dashboard.home.view',
      'settings.business.view',
      'data.cost.view',
      'data.profit_margin.view',
      'data.supplier_price.view',
      'data.payroll.view',
    ]
    expect(visibleFor(accountant)).toEqual(
      sorted(['cost', 'profit_margin', 'supplier_price', 'payroll']),
    )

    expect(visibleFor(['dashboard.home.view'])).toEqual([])
  })

  it('does not reveal a category whose data key is missing from the catalog', () => {
    const effective = resolve({
      rolePermissionKeys: ['data.cost.view'],
      catalog: ['dashboard.home.view'],
    })
    expect(visibleCategories(effective).size).toBe(0)
  })

  it('property: follows data.<category>.view, and profit_margin requires cost', () => {
    fc.assert(
      fc.property(nonOwnerInputArb, (input) => {
        const effective = resolveEffective(input)
        const visible: ReadonlySet<string> = visibleCategories(effective)
        for (const category of visible) expect(SENSITIVITY_CATEGORIES).toContain(category)
        for (const category of SENSITIVITY_CATEGORIES) {
          const granted = can(effective, `data.${category}.view`)
          const expected =
            category === 'profit_margin' ? granted && can(effective, 'data.cost.view') : granted
          expect(visible.has(category)).toBe(expected)
        }
        if (visible.has('profit_margin')) expect(visible.has('cost')).toBe(true)
      }),
    )
  })
})
