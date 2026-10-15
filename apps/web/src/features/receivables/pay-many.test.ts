import { describe, expect, it } from 'vitest'
import { allocate, owedIn } from './pay-many'

describe('Pay several at once', () => {
  const documents = [{ owed: '120' }, { owed: '80.5' }, { owed: '30' }]

  it('pays each document in its order, up to what it owes', () => {
    expect(allocate('150', documents)).toEqual(['120', '30', '0'])
    expect(allocate('230.5', documents)).toEqual(['120', '80.5', '30'])
    expect(allocate('120', documents)).toEqual(['120', '0', '0'])
    expect(allocate('0.01', documents)).toEqual(['0.01', '0', '0'])
  })

  it('reaches no document beyond what they owe in all, and adds up exactly', () => {
    expect(owedIn(documents)).toBe('230.5')
    expect(allocate('500', documents)).toEqual(['120', '80.5', '30'])
    expect(owedIn([{ owed: '0.1' }, { owed: '0.2' }])).toBe('0.3')
  })
})
