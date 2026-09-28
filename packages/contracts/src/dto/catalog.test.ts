import { describe, expect, it } from 'vitest'
import { cleanName, hasVisibleCharacter } from '../text'
import { createMaterialInput, createProductInput } from './catalog'

// Catalog names as the API stores them (D-131): invisible characters removed, marks and spaces
// trimmed from the ends, and something to see.

const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b)
const BYTE_ORDER_MARK = String.fromCodePoint(0xfeff)
const RIGHT_TO_LEFT_MARK = String.fromCodePoint(0x200f)
const ZERO_WIDTH_JOINER = String.fromCodePoint(0x200d)
const ZERO_WIDTH_NON_JOINER = String.fromCodePoint(0x200c)

describe('cleanName', () => {
  it('removes invisible characters and trims spaces and marks from the ends', () => {
    expect(cleanName(`${ZERO_WIDTH_SPACE}Sugar${ZERO_WIDTH_SPACE} `)).toBe('Sugar')
    expect(cleanName(`Su${ZERO_WIDTH_SPACE}gar`)).toBe('Sugar')
    expect(cleanName(`${BYTE_ORDER_MARK}سكر${RIGHT_TO_LEFT_MARK}`)).toBe('سكر')
  })

  it('keeps joiners and marks inside a name', () => {
    const persian = `می${ZERO_WIDTH_NON_JOINER}خواهم`
    expect(cleanName(persian)).toBe(persian)
    const family = `Tea 👨${ZERO_WIDTH_JOINER}👩`
    expect(cleanName(family)).toBe(family)
  })
})

describe('hasVisibleCharacter', () => {
  it('needs a character that is neither a space nor a format mark', () => {
    expect(hasVisibleCharacter('')).toBe(false)
    expect(hasVisibleCharacter(` ${RIGHT_TO_LEFT_MARK}${ZERO_WIDTH_JOINER} `)).toBe(false)
    expect(hasVisibleCharacter('a')).toBe(true)
    expect(hasVisibleCharacter('١')).toBe(true)
  })
})

describe('catalog names', () => {
  const material = { id: '0190f3a8-1c2d-7e4f-8a9b-0c1d2e3f4a5b', unit: 'kg' }

  it('are stored clean', () => {
    const parsed = createMaterialInput.parse({
      ...material,
      name: `${ZERO_WIDTH_SPACE} Sugar ${BYTE_ORDER_MARK}`,
      packs: [
        {
          id: '0190f3a8-1c2d-7e4f-8a9b-0c1d2e3f4a5c',
          name: `bag${RIGHT_TO_LEFT_MARK}`,
          qty: '50',
          ofUnit: 'kg',
        },
      ],
    })
    expect(parsed.name).toBe('Sugar')
    expect(parsed.packs[0]?.name).toBe('bag')
  })

  it('are refused with nothing to see, or with control characters', () => {
    for (const name of [ZERO_WIDTH_SPACE, ` ${RIGHT_TO_LEFT_MARK} `, 'Su\tgar']) {
      expect(createMaterialInput.safeParse({ ...material, name }).success, name).toBe(false)
      expect(
        createProductInput.safeParse({ id: material.id, name, type: 'product', unit: 'piece' })
          .success,
      ).toBe(false)
    }
  })
})
