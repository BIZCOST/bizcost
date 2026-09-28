import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { OWNER_TEMPLATE_KEY } from '../tenancy/keys'
import { resolveEffective, type EffectivePermissions } from './effective'
import { isPermissionKey } from './keys'
import {
  isSensitivityCategory,
  SENSITIVITY_CATEGORIES,
  SENSITIVITY_PERMISSION_KEYS,
  SENSITIVITY_REQUIRES,
  sensitivityPermissionKey,
  visibleCategories,
} from './sensitivity'

const withKeys = (...keys: string[]): EffectivePermissions => ({ all: false, keys: new Set(keys) })
const sorted = (set: ReadonlySet<string>) => [...set].sort()

describe('sensitivity categories', () => {
  it('are the five documented categories', () => {
    expect(SENSITIVITY_CATEGORIES).toEqual([
      'cost',
      'profit_margin',
      'supplier_price',
      'payroll',
      'employee_pii',
    ])
  })

  it('map to data.<category>.view keys that are well-formed and unique', () => {
    expect(sensitivityPermissionKey('cost')).toBe('data.cost.view')
    expect(sensitivityPermissionKey('profit_margin')).toBe('data.profit_margin.view')
    expect(SENSITIVITY_PERMISSION_KEYS).toEqual(SENSITIVITY_CATEGORIES.map((c) => `data.${c}.view`))
    expect(new Set(SENSITIVITY_PERMISSION_KEYS).size).toBe(SENSITIVITY_CATEGORIES.length)
    for (const key of SENSITIVITY_PERMISSION_KEYS) expect(isPermissionKey(key)).toBe(true)
  })

  it('declares grouping rules only between known categories, never a category on itself', () => {
    for (const c of SENSITIVITY_CATEGORIES) {
      for (const r of SENSITIVITY_REQUIRES[c]) {
        expect(isSensitivityCategory(r)).toBe(true)
        expect(r).not.toBe(c)
      }
    }
    expect(Object.keys(SENSITIVITY_REQUIRES).sort()).toEqual([...SENSITIVITY_CATEGORIES].sort())
  })

  it('pairs costs and supplier prices (D-144)', () => {
    expect(SENSITIVITY_REQUIRES.cost).toContain('supplier_price')
    expect(SENSITIVITY_REQUIRES.supplier_price).toContain('cost')
  })

  it('isSensitivityCategory accepts only the categories', () => {
    expect(isSensitivityCategory('cost')).toBe(true)
    expect(isSensitivityCategory('price')).toBe(false)
    expect(isSensitivityCategory(undefined)).toBe(false)
  })
})

describe('visibleCategories', () => {
  it('shows everything to the owner', () => {
    const owner = resolveEffective({
      roleTemplateKey: OWNER_TEMPLATE_KEY,
      rolePermissionKeys: [],
      overrides: [],
      catalog: [],
    })
    expect(sorted(visibleCategories(owner))).toEqual([...SENSITIVITY_CATEGORIES].sort())
  })

  it('shows nothing without data keys', () => {
    expect(visibleCategories(withKeys('dashboard.home.view')).size).toBe(0)
  })

  it('shows each category whose key is granted', () => {
    expect(sorted(visibleCategories(withKeys('data.payroll.view')))).toEqual(['payroll'])
    expect(
      sorted(visibleCategories(withKeys('data.supplier_price.view', 'data.cost.view'))),
    ).toEqual(['cost', 'supplier_price'])
    expect(sorted(visibleCategories(withKeys('data.employee_pii.view')))).toEqual(['employee_pii'])
  })

  it('hides supplier prices when cost is hidden (the prices paid would reveal the average)', () => {
    expect(visibleCategories(withKeys('data.supplier_price.view')).size).toBe(0)
  })

  it('hides costs when supplier prices are hidden (the average over time reveals each price, D-144)', () => {
    expect(visibleCategories(withKeys('data.cost.view')).size).toBe(0)
    expect(sorted(visibleCategories(withKeys('data.cost.view', 'data.payroll.view')))).toEqual([
      'payroll',
    ])
    expect(visibleCategories(withKeys('data.cost.view', 'data.profit_margin.view')).size).toBe(0)
  })

  it('a deny on data.supplier_price.view also hides costs and profit/margin', () => {
    const effective = resolveEffective({
      roleTemplateKey: 'manager',
      rolePermissionKeys: ['data.cost.view', 'data.profit_margin.view', 'data.supplier_price.view'],
      overrides: [{ key: 'data.supplier_price.view', effect: 'deny' }],
      catalog: SENSITIVITY_PERMISSION_KEYS,
    })
    expect(visibleCategories(effective).size).toBe(0)
  })

  it('hides profit/margin when cost is hidden (price + margin would reveal cost)', () => {
    expect(visibleCategories(withKeys('data.profit_margin.view')).has('profit_margin')).toBe(false)
    expect(
      sorted(
        visibleCategories(
          withKeys('data.profit_margin.view', 'data.cost.view', 'data.supplier_price.view'),
        ),
      ),
    ).toEqual(['cost', 'profit_margin', 'supplier_price'])
  })

  it('a deny on data.cost.view also hides profit/margin', () => {
    const effective = resolveEffective({
      roleTemplateKey: 'accountant',
      rolePermissionKeys: ['data.cost.view', 'data.profit_margin.view'],
      overrides: [{ key: 'data.cost.view', effect: 'deny' }],
      catalog: SENSITIVITY_PERMISSION_KEYS,
    })
    expect(visibleCategories(effective).size).toBe(0)
  })

  it('visible ⇔ key granted and every required category visible (property)', () => {
    fc.assert(
      fc.property(fc.subarray([...SENSITIVITY_PERMISSION_KEYS]), (granted) => {
        const visible = visibleCategories(withKeys(...granted))
        for (const c of SENSITIVITY_CATEGORIES) {
          const expected =
            granted.includes(sensitivityPermissionKey(c)) &&
            SENSITIVITY_REQUIRES[c].every((r) => visible.has(r))
          expect(visible.has(c)).toBe(expected)
        }
        if (visible.has('profit_margin')) expect(visible.has('cost')).toBe(true)
        expect(visible.has('cost')).toBe(visible.has('supplier_price'))
        // The largest such set: costs and supplier prices show whenever both keys are granted.
        const both =
          granted.includes('data.cost.view') && granted.includes('data.supplier_price.view')
        expect(visible.has('cost')).toBe(both)
      }),
    )
  })
})
