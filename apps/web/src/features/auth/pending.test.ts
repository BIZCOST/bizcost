import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearPending, readPending, savePending } from './pending'

function memoryStorage(): Storage {
  const items = new Map<string, string>()
  return {
    get length() {
      return items.size
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, value),
  }
}

describe('pending code storage', () => {
  beforeEach(() => vi.stubGlobal('sessionStorage', memoryStorage()))
  afterEach(() => vi.unstubAllGlobals())

  it('round-trips a pending code and clears it', () => {
    const pending = { email: 'a@example.com', purpose: 'signUp', sentAt: 1 } as const
    savePending(pending)
    expect(readPending()).toEqual(pending)
    clearPending()
    expect(readPending()).toBeNull()
  })

  it('keeps whether a reset code was used and whether it requires a new password', () => {
    const pending = {
      email: 'a@example.com',
      purpose: 'recovery',
      sentAt: 1,
      verified: true,
      passwordRequired: true,
    } as const
    savePending(pending)
    expect(readPending()).toEqual(pending)
  })

  it('ignores malformed or foreign values', () => {
    for (const raw of ['{', 'null', '"x"', '{"email":"a@b.c","purpose":"admin","sentAt":1}']) {
      sessionStorage.setItem('bz_pending_code', raw)
      expect(readPending()).toBeNull()
    }
  })

  it('survives blocked storage', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    })
    expect(() => savePending({ email: 'a@b.c', purpose: 'signIn', sentAt: 1 })).not.toThrow()
    expect(readPending()).toBeNull()
    expect(() => clearPending()).not.toThrow()
  })
})
