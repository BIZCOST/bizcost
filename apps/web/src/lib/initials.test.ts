import { describe, expect, it } from 'vitest'
import { initials } from './initials'

describe('initials', () => {
  it.each([
    ['Rashed', 'R'],
    ['rashed al mansoori', 'RM'],
    ['  Sara   Ahmed  ', 'SA'],
    ['راشد المنصوري', 'ر'],
    ['', ''],
    ['   ', ''],
  ])('%j → %j', (name, expected) => {
    expect(initials(name)).toBe(expected)
  })
})
