import { MODULES } from '@bizcost/modules'
import { describe, expect, it } from 'vitest'
import { moduleRegistry } from './context'

// The dev-only preview switch (D-125): planned modules counted as released, only when NODE_ENV is
// development or test. The API checks it itself, so a production server ignores a config that names
// preview modules, whoever built that config.

const availability = (registry: ReturnType<typeof moduleRegistry>, id: string) =>
  registry.find((m) => m.id === id)?.availability

describe('moduleRegistry', () => {
  it('is the released code’s registry when no preview module is named', () => {
    expect(moduleRegistry({}, 'development')).toBe(MODULES)
    expect(moduleRegistry({ previewModules: [] }, 'test')).toBe(MODULES)
  })

  it('counts the preview modules as released in development and test', () => {
    for (const env of ['development', 'test']) {
      const registry = moduleRegistry({ previewModules: ['materials', 'products'] }, env)
      expect(availability(registry, 'materials'), env).toBe('released')
      expect(availability(registry, 'products'), env).toBe('released')
      expect(availability(registry, 'orders'), env).toBe('planned')
    }
  })

  it('ignores them in production, and when NODE_ENV is unset or anything else', () => {
    for (const env of ['production', undefined, '', 'staging', 'Development']) {
      expect(moduleRegistry({ previewModules: ['materials'] }, env), String(env)).toBe(MODULES)
    }
  })

  it('ignores modules that cannot be previewed (not being built, released, unknown)', () => {
    const registry = moduleRegistry({ previewModules: ['orders', 'settings', 'nope'] }, 'test')
    expect(registry.map((m) => [m.id, m.availability])).toEqual(
      MODULES.map((m) => [m.id, m.availability]),
    )
  })
})
