import { MODULES, type ModuleManifest } from '@bizcost/modules'
import { describe, expect, it } from 'vitest'
import { moduleRegistry } from './context'

// The dev-only preview switch (D-125): planned modules counted as released, only when NODE_ENV is
// development or test. The API checks it itself, so a production server ignores a config that names
// preview modules, whoever built that config. Nothing is being built between Release A (M3 Step 6)
// and Quotations (Step 7): the tests start the build of Quotations in a registry of their own.

const availability = (registry: ReturnType<typeof moduleRegistry>, id: string) =>
  registry.find((m) => m.id === id)?.availability

const building: readonly ModuleManifest[] = MODULES.map((m) =>
  m.id === 'quotations'
    ? {
        ...m,
        permissionKeys: ['quotations.view'],
        nav: [
          {
            id: 'quotations',
            labelKey: 'nav.quotations',
            path: 'quotations',
            icon: 'file-signature',
            group: 'sales',
          },
        ],
      }
    : m,
)

describe('moduleRegistry', () => {
  it('is the released code’s registry when no preview module is named', () => {
    expect(moduleRegistry({}, 'development')).toBe(MODULES)
    expect(moduleRegistry({ previewModules: [] }, 'test')).toBe(MODULES)
    expect(moduleRegistry({}, 'test', building)).toBe(building)
  })

  it('counts the preview modules as released in development and test', () => {
    for (const env of ['development', 'test']) {
      const registry = moduleRegistry({ previewModules: ['quotations'] }, env, building)
      expect(availability(registry, 'quotations'), env).toBe('released')
      expect(availability(registry, 'invoices'), env).toBe('planned')
    }
  })

  it('ignores them in production, and when NODE_ENV is unset or anything else', () => {
    for (const env of ['production', undefined, '', 'staging', 'Development']) {
      expect(moduleRegistry({ previewModules: ['quotations'] }, env, building), String(env)).toBe(
        building,
      )
    }
  })

  it('ignores modules that cannot be previewed (not being built, released, unknown)', () => {
    const registry = moduleRegistry(
      { previewModules: ['inventory', 'settings', 'materials', 'sales', 'nope'] },
      'test',
      building,
    )
    expect(registry.map((m) => [m.id, m.availability])).toEqual(
      building.map((m) => [m.id, m.availability]),
    )
    // The released code has nothing to preview: the Costing Core is released (M2 Step 7), and Sales,
    // Orders, Customers, Payments and Reports with Release A (M3 Step 6).
    expect(moduleRegistry({ previewModules: ['materials', 'products'] }, 'test')).toBe(MODULES)
    expect(
      moduleRegistry(
        { previewModules: ['customers', 'sales', 'payments', 'reports', 'orders'] },
        'test',
      ),
    ).toBe(MODULES)
    expect(availability(MODULES, 'materials')).toBe('released')
    expect(availability(MODULES, 'orders')).toBe('released')
  })
})
