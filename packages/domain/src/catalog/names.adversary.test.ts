import { describe, expect, it } from 'vitest'
import { matchNames, nameKey } from './names'

// Security adversary (review of the owner's requests of 2026-09-29, R2): two names that read exactly
// alike must have one key, or "already exists" (NAME_TAKEN, the unique index on app.name_key) is
// passed by a name pasted with an invisible mark, typed on a Persian keyboard, or sent in another
// Unicode form of the same letters. The API stores a name as cleanName leaves it
// (contracts/text.ts): inside a name it removes only U+00AD, U+180E, U+200B, U+2060 and U+FEFF, and
// it trims the bidi marks and joiners from the ends only, so everything below reaches nameKey and
// app.name_key as written.
//
// These tests state what the key must do; they fail until nameKey (and app.name_key, which an API
// test holds equal to it) ignores those differences.

const LRM = '\u{200E}'
const RLM = '\u{200F}'
const ALM = '\u{061C}'
const LRI = '\u{2066}'
const PDI = '\u{2069}'

const sameName = (a: string, b: string) => {
  const found = matchNames(b, [{ name: a }], (r) => r.name)
  return found.same?.name ?? null
}

describe('nameKey: names that read exactly alike are one name', () => {
  it.each([
    ['Sugar', `Sug${LRM}ar`],
    ['سكر', `سك${RLM}ر`],
    ['سكر', `س${ALM}كر`],
    ['Brown sugar', `Brown ${LRI}sugar${PDI}`],
  ])('an invisible bidi mark inside the name: %j and %j', (a, b) => {
    expect(nameKey(b)).toBe(nameKey(a))
    expect(sameName(a, b)).toBe(a)
  })

  it.each([
    // U+06CC Farsi yeh: medially it has the two dots of U+064A, finally it is dotless like U+0649
    // (which the key already makes U+064A).
    ['ب\u{064A}ت', 'ب\u{06CC}ت'],
    ['شا\u{0649}', 'شا\u{06CC}'],
    // U+06A9 keheh: initially and medially it is drawn as U+0643 kaf.
    ['آيس \u{0643}ريم', 'آيس \u{06A9}ريم'],
  ])('the Persian form of an Arabic letter: %j and %j', (a, b) => {
    expect(nameKey(b)).toBe(nameKey(a))
    expect(sameName(a, b)).toBe(a)
  })

  it.each([
    // U+0624 waw with hamza above, and U+0648 waw + U+0654 hamza above (its canonical decomposition):
    // the key drops U+0654 but keeps U+0624, so the two spellings of one word get two keys.
    ['م\u{0624}سسة', 'م\u{0648}\u{0654}سسة'],
    // U+0626 yeh with hamza above, and U+064A yeh + U+0654.
    ['ب\u{0626}ر', 'ب\u{064A}\u{0654}ر'],
    // Latin é precomposed (U+00E9) and e + U+0301.
    ['Café', 'Cafe\u{0301}'],
    // Arabic presentation forms (a copy from a PDF): seen initial, kaf medial, reh final.
    ['سكر', '\u{FEB3}\u{FEDC}\u{FEAE}'],
  ])('another Unicode form of the same letters: %j and %j', (a, b) => {
    expect(nameKey(b)).toBe(nameKey(a))
    expect(sameName(a, b)).toBe(a)
  })
})
