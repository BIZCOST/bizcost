import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { matchNames, nameKey } from './names'

// The owner's duplicate rule (2026-09-29): the same name after the key (case, spaces, Arabic letter
// forms, marks, digits) is a duplicate; names that look alike get "Did you mean …?".

const names = (list: readonly string[]) => list.map((name, i) => ({ id: `m${i}`, name }))
const match = (name: string, list: readonly string[]) => {
  const result = matchNames(name, names(list), (r) => r.name)
  return { same: result.same?.name ?? null, similar: result.similar.map((r) => r.name) }
}

describe('nameKey', () => {
  it.each([
    ['  Sugar  ', 'sugar'],
    ['BROWN   sugar', 'brown sugar'],
    ['Brown\u{00A0}Sugar', 'brown sugar'],
    ['Milk 3.5%', 'milk 3.5%'],
    ['أرز', 'ارز'],
    ['إسفنج', 'اسفنج'],
    ['آيس كريم', 'ايس كريم'],
    ['ٱلزيت', 'الزيت'],
    ['قهوة', 'قهوه'],
    ['حلوى', 'حلوي'],
    ['سُكَّر', 'سكر'],
    ['طحيـــنة', 'طحينه'],
    ['حليب ٣٫٥٪', 'حليب 3٫5٪'],
    ['كوب ۱۲', 'كوب 12'],
    ['Crème brûlée', 'crème brûlée'],
  ])('%j → %j', (name, key) => {
    expect(nameKey(name)).toBe(key)
  })

  it('is stable: the key of a key is itself', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 30 }), (name) => {
        expect(nameKey(nameKey(name))).toBe(nameKey(name))
      }),
    )
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 20 }), (name) => {
        expect(nameKey(nameKey(name))).toBe(nameKey(name))
      }),
    )
  })

  it('drops every format character (Unicode category Cf), wherever it is', () => {
    const missed: string[] = []
    for (let code = 0; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue
      const c = String.fromCodePoint(code)
      if (/\p{Cf}/u.test(c) && nameKey(`a${c}b`) !== 'ab') missed.push(code.toString(16))
    }
    expect(missed).toEqual([])
  })

  it.each([
    // Unicode forms of the same letters (NFKC), after the format characters are gone.
    ['\u{FEB3}\u{FEDC}\u{FEAE}', 'سكر'],
    ['Cafe\u{0301}', 'café'],
    ['e\u{200E}\u{0301}', 'é'],
    ['م\u{0648}\u{0654}سسة', 'م\u{0624}سسه'],
    ['\u{FF33}\u{FF55}\u{FF47}\u{FF41}\u{FF52}', 'sugar'],
    ['\u{FEFB}بن', 'لابن'],
    // Persian letter forms read as the Arabic letters.
    ['ب\u{06CC}ت', 'بيت'],
    ['\u{06A9}ريم', 'كريم'],
    ['قهو\u{06D5}', 'قهوه'],
  ])('%j → %j', (name, key) => {
    expect(nameKey(name)).toBe(key)
  })
})

describe('matchNames: the same name', () => {
  it.each([
    ['sugar', ['Sugar'], 'Sugar'],
    ['  SUGAR ', ['Flour', 'Sugar'], 'Sugar'],
    ['brown  sugar', ['Brown sugar'], 'Brown sugar'],
    ['أرز بسمتي', ['ارز بسمتي'], 'ارز بسمتي'],
    ['قهوة', ['قهوه'], 'قهوه'],
    ['حلوى', ['حلوي'], 'حلوي'],
    ['سكّر', ['سكر'], 'سكر'],
    ['كوب ١٢ أونصة', ['كوب 12 اونصه'], 'كوب 12 اونصه'],
  ])('%j is %j', (name, list, same) => {
    expect(match(name, list).same).toBe(same)
  })

  it('is not "look alike" at the same time', () => {
    expect(match('Sugar', ['sugar', 'Sugar syrup'])).toEqual({
      same: 'sugar',
      similar: ['Sugar syrup'],
    })
  })
})

describe('matchNames: names that look alike', () => {
  it('one inside the other, either way, starting alike first', () => {
    expect(match('Milk', ['Milk powder', 'Coconut milk', 'Flour']).similar).toEqual([
      'Milk powder',
      'Coconut milk',
    ])
    expect(match('Milk powder', ['Milk']).similar).toEqual(['Milk'])
    expect(match('حليب', ['حليب مجفف', 'جبن']).similar).toEqual(['حليب مجفف'])
    expect(match('زيت زيتون', ['زيت']).similar).toEqual(['زيت'])
  })

  it('at most 2 letters apart when both have at least 4', () => {
    expect(match('Sugr', ['Sugar']).similar).toEqual(['Sugar'])
    expect(match('Suagr', ['Sugar']).similar).toEqual(['Sugar'])
    expect(match('Tomatos', ['Tomatoes', 'Potatoes']).similar).toEqual(['Tomatoes'])
    expect(match('طحين', ['طحينة']).similar).toEqual(['طحينة'])
    expect(match('بسكويت', ['بسكوت']).similar).toEqual(['بسكوت'])
    // 3 letters apart, or too short to compare this way.
    expect(match('Sugar', ['Cigars']).similar).toEqual([])
    expect(match('Tea', ['Pea']).similar).toEqual([])
    expect(match('Oil', ['Oat']).similar).toEqual([])
  })

  it('a key of one letter looks like nothing', () => {
    expect(match('X', ['Xylitol', 'Box']).similar).toEqual([])
  })

  it('lists at most 3, the closest first', () => {
    const list = ['Sugar cane', 'Sugar', 'Brown sugar', 'Sugar syrup', 'Icing sugar', 'Salt']
    expect(match('Suga', list).similar).toEqual(['Sugar', 'Sugar cane', 'Sugar syrup'])
  })

  it('an empty name matches nothing', () => {
    expect(match('   ', ['Sugar'])).toEqual({ same: null, similar: [] })
  })
})
