import { describe, expect, it } from 'vitest'
import { isUuid, newId } from './id'

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('newId', () => {
  it('returns a lowercase UUIDv7 with the RFC 9562 variant', () => {
    expect(newId()).toMatch(UUID_V7)
  })

  it('returns unique ids that sort in creation order', () => {
    const ids = Array.from({ length: 1000 }, () => newId())
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(ids)
  })

  it('encodes the current time in the first 48 bits', () => {
    const before = Date.now()
    const id = newId()
    const after = Date.now()
    const ms = Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16)
    expect(ms).toBeGreaterThanOrEqual(before)
    expect(ms).toBeLessThanOrEqual(after)
  })
})

describe('isUuid', () => {
  it('accepts canonical UUIDs of any version and case', () => {
    expect(isUuid(newId())).toBe(true)
    expect(isUuid('6F9619FF-8B86-D011-B42D-00C04FC964FF')).toBe(true)
  })

  it('rejects other values', () => {
    expect(isUuid('')).toBe(false)
    expect(isUuid('not-a-uuid')).toBe(false)
    expect(isUuid('6f9619ff8b86d011b42d00c04fc964ff')).toBe(false)
    expect(isUuid("6f9619ff-8b86-d011-b42d-00c04fc964ff' or 1=1")).toBe(false)
    expect(isUuid(null)).toBe(false)
    expect(isUuid(42)).toBe(false)
  })
})
