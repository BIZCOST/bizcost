import { describe, expect, it } from 'vitest'
import { closedFor, firstOpenDay, nextDay } from './books'

// The books-closed date said before Finalize (D-143).

describe('the closed books on a document’s date', () => {
  it('open books never stop it', () => {
    expect(closedFor('2026-09-28', '2026-09-28', null)).toBeNull()
    expect(firstOpenDay('2026-09-28', null)).toBeUndefined()
  })

  it('closed up to an earlier day: a later day can be picked', () => {
    expect(closedFor('2026-09-15', '2026-09-28', '2026-09-20')).toBe('earlier')
    expect(closedFor('2026-09-20', '2026-09-28', '2026-09-20')).toBe('earlier')
    expect(closedFor('2026-09-21', '2026-09-28', '2026-09-20')).toBeNull()
    expect(firstOpenDay('2026-09-28', '2026-09-20')).toBe('2026-09-21')
  })

  it('closed up to today: nothing can be finalized before tomorrow', () => {
    expect(closedFor('2026-09-28', '2026-09-28', '2026-09-28')).toBe('today')
    expect(closedFor('2026-09-01', '2026-09-28', '2026-09-28')).toBe('today')
    expect(firstOpenDay('2026-09-28', '2026-09-28')).toBeUndefined()
  })

  it('crosses months and years', () => {
    expect(nextDay('2026-09-30')).toBe('2026-10-01')
    expect(nextDay('2026-12-31')).toBe('2027-01-01')
  })
})
