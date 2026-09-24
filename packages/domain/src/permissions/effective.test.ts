import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { OWNER_TEMPLATE_KEY, type PermissionEffect } from '../tenancy/keys'
import { can, resolveEffective, type PermissionOverride } from './effective'

const CATALOG = [
  'dashboard.home.view',
  'settings.business.view',
  'settings.business.edit',
  'settings.members.manage',
  'data.cost.view',
  'data.profit_margin.view',
]

const sorted = (keys: ReadonlySet<string>) => [...keys].sort()

describe('resolveEffective: owner template', () => {
  it('grants everything, and the keys are the whole catalog', () => {
    const effective = resolveEffective({
      roleTemplateKey: OWNER_TEMPLATE_KEY,
      rolePermissionKeys: [],
      overrides: [],
      catalog: CATALOG,
    })
    expect(effective.all).toBe(true)
    expect(sorted(effective.keys)).toEqual([...CATALOG].sort())
  })

  it('ignores deny overrides, so an owner can never be locked out', () => {
    const effective = resolveEffective({
      roleTemplateKey: OWNER_TEMPLATE_KEY,
      rolePermissionKeys: [],
      overrides: CATALOG.map((key) => ({ key, effect: 'deny' as const })),
      catalog: CATALOG,
    })
    expect(effective.all).toBe(true)
    for (const key of CATALOG) expect(can(effective, key)).toBe(true)
  })

  it('holds keys added to the catalog later (implicit, no rows)', () => {
    const effective = resolveEffective({
      roleTemplateKey: OWNER_TEMPLATE_KEY,
      rolePermissionKeys: [],
      overrides: [],
      catalog: [],
    })
    expect(can(effective, 'orders.order.create')).toBe(true)
  })
})

describe('resolveEffective: other roles', () => {
  it('grants the role keys', () => {
    const effective = resolveEffective({
      roleTemplateKey: 'employee',
      rolePermissionKeys: ['dashboard.home.view'],
      overrides: [],
      catalog: CATALOG,
    })
    expect(effective.all).toBe(false)
    expect(sorted(effective.keys)).toEqual(['dashboard.home.view'])
    expect(can(effective, 'dashboard.home.view')).toBe(true)
    expect(can(effective, 'settings.business.view')).toBe(false)
  })

  it('treats a custom role (no template) like any other role', () => {
    const effective = resolveEffective({
      roleTemplateKey: null,
      rolePermissionKeys: ['settings.business.view'],
      overrides: [],
      catalog: CATALOG,
    })
    expect(effective.all).toBe(false)
    expect(sorted(effective.keys)).toEqual(['settings.business.view'])
  })

  it('adds allow overrides', () => {
    const effective = resolveEffective({
      roleTemplateKey: 'employee',
      rolePermissionKeys: ['dashboard.home.view'],
      overrides: [{ key: 'data.cost.view', effect: 'allow' }],
      catalog: CATALOG,
    })
    expect(sorted(effective.keys)).toEqual(['dashboard.home.view', 'data.cost.view'])
  })

  it('removes deny overrides from the role keys', () => {
    const effective = resolveEffective({
      roleTemplateKey: 'admin',
      rolePermissionKeys: CATALOG,
      overrides: [{ key: 'settings.members.manage', effect: 'deny' }],
      catalog: CATALOG,
    })
    expect(can(effective, 'settings.members.manage')).toBe(false)
    expect(effective.keys.size).toBe(CATALOG.length - 1)
  })

  it('lets deny win over an allow override for the same key, in any order', () => {
    const allowThenDeny: PermissionOverride[] = [
      { key: 'data.cost.view', effect: 'allow' },
      { key: 'data.cost.view', effect: 'deny' },
    ]
    for (const overrides of [allowThenDeny, [...allowThenDeny].reverse()]) {
      const effective = resolveEffective({
        roleTemplateKey: null,
        rolePermissionKeys: [],
        overrides,
        catalog: CATALOG,
      })
      expect(can(effective, 'data.cost.view')).toBe(false)
    }
  })

  it('drops keys outside the catalog, from the role and from allow overrides', () => {
    const effective = resolveEffective({
      roleTemplateKey: 'employee',
      rolePermissionKeys: ['dashboard.home.view', 'retired.thing.view'],
      overrides: [{ key: 'unknown.thing.edit', effect: 'allow' }],
      catalog: CATALOG,
    })
    expect(sorted(effective.keys)).toEqual(['dashboard.home.view'])
    expect(can(effective, 'retired.thing.view')).toBe(false)
    expect(can(effective, 'unknown.thing.edit')).toBe(false)
  })

  it('ignores an unknown override effect (never grants)', () => {
    const effective = resolveEffective({
      roleTemplateKey: null,
      rolePermissionKeys: [],
      overrides: [{ key: 'data.cost.view', effect: 'grant' as PermissionEffect }],
      catalog: CATALOG,
    })
    expect(effective.keys.size).toBe(0)
  })

  it("does not treat a template key that merely resembles 'owner' as the owner", () => {
    for (const roleTemplateKey of ['Owner', 'OWNER', ' owner', 'owner ', 'owners']) {
      const effective = resolveEffective({
        roleTemplateKey,
        rolePermissionKeys: [],
        overrides: [],
        catalog: CATALOG,
      })
      expect(effective.all).toBe(false)
      expect(can(effective, 'dashboard.home.view')).toBe(false)
    }
  })

  it('does not mutate its inputs', () => {
    const input = {
      roleTemplateKey: 'admin',
      rolePermissionKeys: Object.freeze([...CATALOG]),
      overrides: Object.freeze([Object.freeze({ key: 'data.cost.view', effect: 'deny' as const })]),
      catalog: Object.freeze([...CATALOG]),
    }
    expect(() => resolveEffective(input)).not.toThrow()
  })
})

// Property tests: keys drawn from a small pool so role keys, overrides and the catalog overlap often.
const POOL = ['a.b.c', 'a.b.d', 'a.x.view', 'm.r.edit', 'data.cost.view', 'z.z.z', 'q.q.q', 'k.k.k']
const key = fc.constantFrom(...POOL)
const keys = fc.array(key, { maxLength: 10 })
const override = fc.record({ key, effect: fc.constantFrom<PermissionEffect>('allow', 'deny') })
const overrides = fc.array(override, { maxLength: 10 })
const templateKey = fc.option(fc.constantFrom('admin', 'manager', 'employee', 'custom'), {
  nil: null,
})
const input = fc.record({
  roleTemplateKey: templateKey,
  rolePermissionKeys: keys,
  overrides,
  catalog: keys,
})

describe('resolveEffective: properties', () => {
  it('non-owner result = (role ∪ allow) − deny, within the catalog', () => {
    fc.assert(
      fc.property(input, (i) => {
        const effective = resolveEffective(i)
        const catalog = new Set(i.catalog)
        const denied = new Set(i.overrides.filter((o) => o.effect === 'deny').map((o) => o.key))
        const expected = new Set(
          [
            ...i.rolePermissionKeys,
            ...i.overrides.filter((o) => o.effect === 'allow').map((o) => o.key),
          ]
            .filter((k) => catalog.has(k))
            .filter((k) => !denied.has(k)),
        )
        expect(effective.all).toBe(false)
        expect(sorted(effective.keys)).toEqual(sorted(expected))
      }),
    )
  })

  it('never grants a denied key or a key outside the catalog (non-owner)', () => {
    fc.assert(
      fc.property(input, fc.constantFrom(...POOL), (i, k) => {
        const effective = resolveEffective(i)
        const denied = i.overrides.some((o) => o.key === k && o.effect === 'deny')
        if (denied || !i.catalog.includes(k)) expect(can(effective, k)).toBe(false)
      }),
    )
  })

  it('can() agrees with the key set (non-owner)', () => {
    fc.assert(
      fc.property(input, fc.constantFrom(...POOL), (i, k) => {
        const effective = resolveEffective(i)
        expect(can(effective, k)).toBe(effective.keys.has(k))
      }),
    )
  })

  it('owner: always everything, whatever the rows and overrides', () => {
    fc.assert(
      fc.property(input, fc.string(), (i, k) => {
        const effective = resolveEffective({ ...i, roleTemplateKey: OWNER_TEMPLATE_KEY })
        expect(effective.all).toBe(true)
        expect(can(effective, k)).toBe(true)
        expect(sorted(effective.keys)).toEqual(sorted(new Set(i.catalog)))
      }),
    )
  })

  it('does not depend on the order of rows and overrides', () => {
    fc.assert(
      fc.property(input, fc.infiniteStream(fc.nat()), (i, rand) => {
        const shuffle = <T>(xs: readonly T[]) =>
          xs
            .map((x) => ({ x, r: rand.next().value as number }))
            .sort((p, q) => p.r - q.r)
            .map((p) => p.x)
        const a = resolveEffective(i)
        const b = resolveEffective({
          ...i,
          rolePermissionKeys: shuffle(i.rolePermissionKeys),
          overrides: shuffle(i.overrides),
          catalog: shuffle(i.catalog),
        })
        expect(sorted(b.keys)).toEqual(sorted(a.keys))
      }),
    )
  })

  it('adding a role key or an allow never removes a permission; adding a deny never adds one', () => {
    fc.assert(
      fc.property(input, key, (i, k) => {
        const base = resolveEffective(i)
        const withRoleKey = resolveEffective({
          ...i,
          rolePermissionKeys: [...i.rolePermissionKeys, k],
        })
        const withAllow = resolveEffective({
          ...i,
          overrides: [...i.overrides, { key: k, effect: 'allow' }],
        })
        const withDeny = resolveEffective({
          ...i,
          overrides: [...i.overrides, { key: k, effect: 'deny' }],
        })
        for (const granted of base.keys) {
          expect(withRoleKey.keys.has(granted)).toBe(true)
          expect(withAllow.keys.has(granted)).toBe(true)
        }
        for (const granted of withDeny.keys) expect(base.keys.has(granted)).toBe(true)
        expect(withDeny.keys.has(k)).toBe(false)
      }),
    )
  })

  it('is unaffected by duplicate rows', () => {
    fc.assert(
      fc.property(input, (i) => {
        const a = resolveEffective(i)
        const b = resolveEffective({
          ...i,
          rolePermissionKeys: [...i.rolePermissionKeys, ...i.rolePermissionKeys],
          overrides: [...i.overrides, ...i.overrides],
          catalog: [...i.catalog, ...i.catalog],
        })
        expect(sorted(b.keys)).toEqual(sorted(a.keys))
      }),
    )
  })
})
