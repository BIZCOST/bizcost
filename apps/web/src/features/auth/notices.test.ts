import { describe, expect, it } from 'vitest'
import { NOTICE_KEYS, parseNotice } from './notices'

describe('parseNotice', () => {
  it('accepts only the known notices', () => {
    for (const notice of Object.keys(NOTICE_KEYS)) expect(parseNotice(notice)).toBe(notice)
    for (const value of [undefined, '', 'toString', '__proto__', ['signed-out'], 'Signed-Out']) {
      expect(parseNotice(value)).toBeUndefined()
    }
  })
})
