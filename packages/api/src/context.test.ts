import { MODULES, type ModuleManifest } from '@bizcost/modules'
import { describe, expect, it } from 'vitest'
import { moduleRegistry } from './context'

// The dev-only preview switch (D-125): planned modules counted as released, only when NODE_ENV is
// development or test. The API checks it itself, so a production server ignores a config that names
// preview modules, whoever built that config. Nothing is being built between the Costing Core's
// release (M2 Step 7) and Phase 3: the tests start the build of Orders in a registry of their own.

const availability = (registry: ReturnType<typeof moduleRegistry>, id: string) =>
  registry.find((m) => m.id === id)?.availability

const building: readonly ModuleManifest[] = MODULES.map((m) =>
  m.id === 'orders'
    ? {
        ...m,
        permissionKeys: ['orders.view'],
        nav: [
          {
            id: 'orders',
            labelKey: 'nav.orders',
            path: 'orders',
            icon: 'shopping-bag',
            group: 'main',
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
      const registry = moduleRegistry({ previewModules: ['orders'] }, env, building)
      expect(availability(registry, 'orders'), env).toBe('released')
      expect(availability(registry, 'quotations'), env).toBe('planned')
    }
  })

  it('ignores them in production, and when NODE_ENV is unset or anything else', () => {
    for (const env of ['production', undefined, '', 'staging', 'Development']) {
      expect(moduleRegistry({ previewModules: ['orders'] }, env, building), String(env)).toBe(
        building,
      )
    }
  })

  it('ignores modules that cannot be previewed (not being built, released, unknown)', () => {
    const registry = moduleRegistry(
      { previewModules: ['quotations', 'settings', 'materials', 'nope'] },
      'test',
      building,
    )
    expect(registry.map((m) => [m.id, m.availability])).toEqual(
      building.map((m) => [m.id, m.availability]),
    )
    // The released code has nothing to preview: the Costing Core is released (M2 Step 7).
    expect(moduleRegistry({ previewModules: ['materials', 'products'] }, 'test')).toBe(MODULES)
    expect(availability(MODULES, 'materials')).toBe('released')
  })
})
