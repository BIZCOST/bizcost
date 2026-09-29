// Names of catalog records compared the way people read them (the owner's duplicate rule of
// 2026-09-29, D-158). Two names are the same name when their keys are equal. The key, in this order:
// the format characters that never show dropped (Unicode category Cf: bidi marks, the Arabic letter
// mark, joiners, the zero-width space…), then Unicode NFKC (one form for the same letters: a letter
// and its combining mark become the precomposed letter; Arabic presentation forms, ligatures and
// full-width forms become the plain letters), then case ignored, Arabic letter forms that are often
// typed or pasted for each other made one (alef with hamza or madda and alef wasla → alef; teh
// marbuta, heh goal and ae → heh; alef maksura and Farsi yeh → yeh; keheh → kaf), short vowels and
// other marks (tashkeel, U+064B to U+065F, and U+0670) and the tatweel (U+0640) dropped, Arabic-Indic
// digits read as 0 to 9, spaces collapsed and trimmed. Only the key folds: a name is stored as typed.
// The database has the same function (app.name_key, migrations name_key and name_key_unicode) under
// the unique index of material names, so the API refuses the names the screens call the same
// (NAME_TAKEN); an API test compares the two.
//
// Names that are not the same but look alike ("Did you mean …?", a warning the person may pass) are
// those whose keys contain one another (the shorter at least 2 characters), or, when both keys have
// at least 4 characters, differ by at most 2 letters (Levenshtein distance).

/**
 * The format characters (Unicode 17, category Cf), listed as app.name_key lists them. Tests hold
 * both lists equal to \p{Cf}: nameKey and app.name_key drop every Cf character.
 */
const FORMAT_CHARACTERS =
  /[\u{00AD}\u{0600}-\u{0605}\u{061C}\u{06DD}\u{070F}\u{0890}\u{0891}\u{08E2}\u{180E}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{206F}\u{FEFF}\u{FFF9}-\u{FFFB}\u{110BD}\u{110CD}\u{13430}-\u{1343F}\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0001}\u{E0020}-\u{E007F}]/gu

const LETTERS: Readonly<Record<string, string>> = {
  '\u{0623}': '\u{0627}', // alef with hamza above → alef
  '\u{0625}': '\u{0627}', // alef with hamza below → alef
  '\u{0622}': '\u{0627}', // alef with madda → alef
  '\u{0671}': '\u{0627}', // alef wasla → alef
  '\u{0629}': '\u{0647}', // teh marbuta → heh
  '\u{06C1}': '\u{0647}', // heh goal → heh
  '\u{06D5}': '\u{0647}', // ae (drawn like a final heh) → heh
  '\u{0649}': '\u{064A}', // alef maksura → yeh
  '\u{06CC}': '\u{064A}', // Farsi yeh (yeh's dots inside a word, dotless at its end) → yeh
  '\u{06A9}': '\u{0643}', // keheh (drawn as kaf at the start and inside a word) → kaf
}
const LETTER_FORMS =
  /[\u{0622}\u{0623}\u{0625}\u{0629}\u{0649}\u{0671}\u{06A9}\u{06C1}\u{06CC}\u{06D5}]/gu
/** Tashkeel (fathatan to the small high marks), the superscript alef and the tatweel. */
const MARKS = /[\u{064B}-\u{065F}\u{0670}\u{0640}]/gu
/** Arabic-Indic (U+0660 to U+0669) and Extended Arabic-Indic (U+06F0 to U+06F9) digits. */
const DIGITS = /[\u{0660}-\u{0669}\u{06F0}-\u{06F9}]/gu
/**
 * Spaces, as the database function lists them (a name never holds a control character such as a
 * tab: the API refuses them).
 */
const SPACES = /[ \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}]+/gu

/** The key two names are compared by (see above). */
export function nameKey(name: string): string {
  return name
    .replace(FORMAT_CHARACTERS, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(LETTER_FORMS, (c) => LETTERS[c] ?? c)
    .replace(MARKS, '')
    .replace(DIGITS, (c) => String((c.codePointAt(0) ?? 0) & 0xf))
    .replace(SPACES, ' ')
    .trim()
}

/** Letters (code points) of a key. */
const lettersOf = (key: string) => Array.from(key)

/** Levenshtein distance between two keys, or `limit + 1` once it is known to be more than `limit`. */
function distance(a: readonly string[], b: readonly string[], limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost)
      current.push(value)
      best = Math.min(best, value)
    }
    if (best > limit) return limit + 1
    previous = current
  }
  return previous[b.length]!
}

export interface NameMatches<T> {
  /** A record whose name is the same name (its key is equal); null when none. */
  readonly same: T | null
  /** Up to `limit` records whose names look alike, the closest first. */
  readonly similar: readonly T[]
}

/**
 * The records named like `name`: the one with the same name, and those whose names look alike (see
 * above), closest first: a name that starts like the other, then one inside the other, then by the
 * number of letters that differ, then by key.
 */
export function matchNames<T>(
  name: string,
  records: readonly T[],
  nameOf: (record: T) => string,
  limit = 3,
): NameMatches<T> {
  const key = nameKey(name)
  const letters = lettersOf(key)
  let same: T | null = null
  const alike: { record: T; rank: number; distance: number; key: string }[] = []
  if (key === '') return { same, similar: [] }
  for (const record of records) {
    const other = nameKey(nameOf(record))
    if (other === '') continue
    if (other === key) {
      same ??= record
      continue
    }
    const otherLetters = lettersOf(other)
    const shorter = Math.min(letters.length, otherLetters.length)
    const prefix = key.startsWith(other) || other.startsWith(key)
    const inside = key.includes(other) || other.includes(key)
    if (shorter >= 2 && (prefix || inside)) {
      alike.push({
        record,
        rank: prefix ? 0 : 1,
        distance: Math.abs(letters.length - otherLetters.length),
        key: other,
      })
      continue
    }
    if (shorter >= 4) {
      const d = distance(letters, otherLetters, 2)
      if (d <= 2) alike.push({ record, rank: 2, distance: d, key: other })
    }
  }
  alike.sort(
    (a, b) =>
      a.rank - b.rank || a.distance - b.distance || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  )
  return { same, similar: alike.slice(0, limit).map((a) => a.record) }
}
