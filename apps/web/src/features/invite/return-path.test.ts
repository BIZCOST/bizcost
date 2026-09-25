import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invitationHint, isInvitePath, rememberInvitation, takeReturnPath } from './return-path'

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

/** 43 base64url characters, like a real token. */
const TOKEN = `${'A'.repeat(20)}_-${'b9'.repeat(10)}z`

describe('the way back to an invitation after signing in', () => {
  beforeEach(() => vi.stubGlobal('sessionStorage', memoryStorage()))
  afterEach(() => vi.unstubAllGlobals())

  it('returns to the invitation once, then home', () => {
    expect(TOKEN).toHaveLength(43)
    rememberInvitation(TOKEN)
    expect(takeReturnPath()).toBe(`/invite/${TOKEN}`)
    expect(takeReturnPath()).toBe('/')
  })

  it('keeps what the sign in pages show about the invitation until the way back is taken', () => {
    const hint = { businessName: 'Al Noor', maskedEmail: 'r•••@example.com' }
    rememberInvitation(TOKEN, hint)
    expect(invitationHint()).toEqual(hint)
    expect(invitationHint()).toEqual(hint)
    expect(takeReturnPath()).toBe(`/invite/${TOKEN}`)
    expect(invitationHint()).toBeNull()
    // A hint without a valid way back is not shown.
    sessionStorage.setItem('bz_invitation_hint', JSON.stringify(hint))
    expect(invitationHint()).toBeNull()
  })

  it('goes home without a remembered invitation', () => {
    expect(takeReturnPath()).toBe('/')
  })

  it('never follows anything but an invitation path', () => {
    for (const value of [
      `https://evil.example/invite/${TOKEN}`,
      '//evil.example',
      '/b/123',
      `/invite/${TOKEN}/../../account`,
      `/invite/${TOKEN}?next=/x`,
      '/invite/short',
    ]) {
      sessionStorage.setItem('bz_after_sign_in', value)
      expect(takeReturnPath(), value).toBe('/')
    }
    rememberInvitation('../../account')
    expect(takeReturnPath()).toBe('/')
    expect(isInvitePath(`/invite/${TOKEN}`)).toBe(true)
  })

  it('goes home when storage is blocked', () => {
    const blocked = () => {
      throw new Error('blocked')
    }
    vi.stubGlobal('sessionStorage', { getItem: blocked, setItem: blocked, removeItem: blocked })
    rememberInvitation(TOKEN)
    expect(takeReturnPath()).toBe('/')
  })
})
