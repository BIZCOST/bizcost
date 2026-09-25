import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearPending, readPending, savePending, sentCode } from './pending'

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

  it('keeps a planned automatic resend (D-073)', () => {
    const pending = {
      email: 'a@example.com',
      purpose: 'signIn',
      sentAt: 1,
      retryAt: 35_001,
    } as const
    savePending(pending)
    expect(readPending()).toEqual(pending)
  })

  it('hands over the code sent for a purpose only when it went out and was not used (D-073)', () => {
    savePending({ email: 'a@example.com', purpose: 'recovery', sentAt: 5 })
    expect(sentCode('recovery')).toEqual({ email: 'a@example.com', sentAt: 5 })
    expect(sentCode('signIn')).toBeNull()
    // Not sent yet (an automatic resend is planned), or already used.
    savePending({ email: 'a@example.com', purpose: 'recovery', sentAt: 5, retryAt: 35_001 })
    expect(sentCode('recovery')).toBeNull()
    savePending({ email: 'a@example.com', purpose: 'recovery', sentAt: 5, verified: true })
    expect(sentCode('recovery')).toBeNull()
    clearPending()
    expect(sentCode('recovery')).toBeNull()
  })

  it('ignores malformed or foreign values', () => {
    for (const raw of [
      '{',
      'null',
      '"x"',
      '{"email":"a@b.c","purpose":"admin","sentAt":1}',
      '{"email":"a@b.c","purpose":"recovery","sentAt":1,"retryAt":"soon"}',
    ]) {
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
