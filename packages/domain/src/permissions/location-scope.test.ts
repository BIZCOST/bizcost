import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { newId } from '../ids/id'
import { canAccessLocation, resolveLocationScope } from './location-scope'

describe('resolveLocationScope', () => {
  it('treats an empty set as all locations', () => {
    const scope = resolveLocationScope([])
    expect(scope).toEqual({ all: true })
    expect(canAccessLocation(scope, newId())).toBe(true)
  })

  it('limits a non-empty set to its locations', () => {
    const [a, b, c] = [newId(), newId(), newId()]
    const scope = resolveLocationScope([a, b])
    expect(scope.all).toBe(false)
    expect(canAccessLocation(scope, a)).toBe(true)
    expect(canAccessLocation(scope, b)).toBe(true)
    expect(canAccessLocation(scope, c)).toBe(false)
  })

  it('compares UUIDs case-insensitively', () => {
    const a = newId()
    expect(canAccessLocation(resolveLocationScope([a.toUpperCase()]), a)).toBe(true)
    expect(canAccessLocation(resolveLocationScope([a]), a.toUpperCase())).toBe(true)
  })

  it('ignores duplicates', () => {
    const a = newId()
    const scope = resolveLocationScope([a, a])
    expect(scope.all === false && scope.ids.size).toBe(1)
  })

  it('never grants a location outside a non-empty set (property)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.uuid(), { minLength: 1, maxLength: 8 }),
        fc.uuid(),
        (ids, x) => {
          const scope = resolveLocationScope(ids)
          expect(scope.all).toBe(false)
          const member = ids.some((id) => id.toLowerCase() === x.toLowerCase())
          expect(canAccessLocation(scope, x)).toBe(member)
          for (const id of ids) expect(canAccessLocation(scope, id)).toBe(true)
        },
      ),
    )
  })
})
