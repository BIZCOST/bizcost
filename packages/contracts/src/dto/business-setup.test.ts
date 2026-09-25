import { newId } from '@bizcost/domain'
import { describe, expect, it } from 'vitest'
import { withoutControlCharacters } from '../text'
import { displayNameInput } from './account'
import { createFromSetupDto, createFromSetupInput, setLastBusinessInput } from './business-setup'

const input = {
  businessId: newId(),
  legalName: '  Sara’s Sweets ',
  locale: 'ar',
  questionSetVersion: 1,
  answers: {
    what_you_do: ['food_drinks'],
    workplace: 'home',
    team: 'alone',
    work_setup: ['none'],
    sales_channels: ['messages'],
    vat: 'no',
  },
  adjustments: { modules: [{ id: 'orders', enabled: false }], capabilities: [] },
}

describe('createFromSetupInput', () => {
  it('parses a setup and trims the business name', () => {
    const parsed = createFromSetupInput.parse(input)
    expect(parsed.legalName).toBe('Sara’s Sweets')
    expect(parsed.answers).toEqual(input.answers)
  })

  it('needs a name of 1–100 characters after trimming', () => {
    expect(createFromSetupInput.safeParse({ ...input, legalName: '   ' }).success).toBe(false)
    expect(createFromSetupInput.safeParse({ ...input, legalName: 'x'.repeat(100) }).success).toBe(
      true,
    )
    expect(createFromSetupInput.safeParse({ ...input, legalName: 'x'.repeat(101) }).success).toBe(
      false,
    )
  })

  it('refuses control characters in names (Postgres text cannot hold U+0000)', () => {
    for (const name of ['Sara\u0000Sweets', 'Sara\tSweets', 'Sara\nSweets', 'Sara\u0085Sweets']) {
      expect(createFromSetupInput.safeParse({ ...input, legalName: name }).success).toBe(false)
      expect(displayNameInput.safeParse(name).success).toBe(false)
    }
    // Trailing ones are trimmed first; other scripts and bidi marks are not control characters.
    expect(createFromSetupInput.safeParse({ ...input, legalName: 'Sara\n' }).success).toBe(true)
    expect(displayNameInput.safeParse('حلويات سارة ‏!').success).toBe(true)
    expect(withoutControlCharacters('Sara\t\u0000Sweets')).toBe('Sara Sweets')
  })

  it('checks only the shape of answers (the server applies the question set)', () => {
    const ok = (answers: unknown) => createFromSetupInput.safeParse({ ...input, answers }).success
    expect(ok({ anything: 'goes', yes: true })).toBe(true)
    expect(ok({ what_you_do: [1] })).toBe(false)
    expect(ok({ vat: null })).toBe(false)
    expect(ok({ vat: { nested: true } })).toBe(false)
    expect(ok({ what_you_do: Array.from({ length: 11 }, (_, i) => `o${i}`) })).toBe(false)
    expect(ok(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`q${i}`, true])))).toBe(
      false,
    )
    expect(ok({ ['x'.repeat(41)]: true })).toBe(false)
  })

  it('needs both adjustment lists, a locale, a UUID and a positive version', () => {
    const bad = (patch: object) =>
      createFromSetupInput.safeParse({ ...input, ...patch }).success === false
    expect(bad({ adjustments: { modules: [] } })).toBe(true)
    expect(bad({ locale: 'fr' })).toBe(true)
    expect(bad({ businessId: 'nope' })).toBe(true)
    expect(bad({ questionSetVersion: 0 })).toBe(true)
    expect(bad({ questionSetVersion: '1' })).toBe(true)
  })
})

describe('createFromSetupDto / setLastBusinessInput', () => {
  it('carry a business id', () => {
    const id = newId()
    expect(createFromSetupDto.parse({ businessId: id })).toEqual({ businessId: id })
    expect(setLastBusinessInput.parse({ businessId: id.toUpperCase() })).toEqual({ businessId: id })
    expect(setLastBusinessInput.safeParse({ businessId: 'x' }).success).toBe(false)
  })
})
